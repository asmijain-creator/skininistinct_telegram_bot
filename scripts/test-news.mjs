// End-to-end tests for B1.2 (news context before drafting). Runs the real
// webhook handler with real Gemini and real Google News, but intercepts
// Telegram so nothing is sent. Faults can be injected per step.
// Usage: npm run test-news
import handler from "../api/telegram.js";
import { parseScore } from "../lib/gemini.js";
import { parseSearchTerms, parseRelevance, parseGoogleNewsRss, formatRelatedNews } from "../lib/news.js";

const CHAT_ID = 111;
process.env.ALLOWED_CHAT_IDS = String(CHAT_ID);
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "test-token";

const FLAG = "[VERIFY NEWS]";
const REJECT_PREFIX = "I didn't create a draft because this note isn't substantive enough yet: ";
const realFetch = globalThis.fetch;
let log;
let faults = {}; // { keywords: rawText, news: "error" | xmlText, draft: [rawText, ...] }

function geminiKind(body) {
  const sys = body.system_instruction?.parts?.[0]?.text || "";
  const user = body.contents?.[0]?.parts?.[0]?.text || "";
  if (sys.includes("strict editorial gatekeeper")) return "score";
  if (user.startsWith("You are preparing a news search")) return "keywords";
  if (sys.includes("strict relevance checker")) return "relevance";
  if (sys.startsWith("Meera Pillai / Skinstinct")) return "draft";
  return "other";
}
const geminiReply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.telegram.org/")) {
    if (url.endsWith("/sendMessage")) log.telegram.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  if (url.startsWith("https://news.google.com/")) {
    log.newsSearches.push(decodeURIComponent(new URL(url).searchParams.get("q")));
    if (faults.news === "error") throw new Error("simulated network failure");
    if (typeof faults.news === "string") return new Response(faults.news, { status: 200 });
    const res = await realFetch(url, init);
    log.rssItems = [...(log.rssItems || []), ...parseGoogleNewsRss(await res.clone().text())];
    return res;
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body);
    const kind = geminiKind(body);
    const entry = { kind, body, raw: null };
    log.gemini.push(entry);
    if (kind === "keywords" && faults.keywords !== undefined) return geminiReply((entry.raw = faults.keywords));
    if (kind === "draft" && faults.draft?.length) return geminiReply((entry.raw = faults.draft.shift()));
    const res = await realFetch(url, init);
    const data = await res.clone().json();
    entry.raw = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text).join("") ?? null;
    return res;
  }
  return realFetch(url, init);
};

async function runNote(text, injected = {}) {
  faults = injected;
  log = { gemini: [], telegram: [], newsSearches: [], rssItems: null };
  const res = { status() { return this; }, json() { return this; }, send() { return this; } };
  await handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    body: { update_id: 1, message: { message_id: 7, chat: { id: CHAT_ID }, text } } }, res);
  faults = {};

  const calls = (k) => log.gemini.filter((g) => g.kind === k);
  const draftCall = calls("draft").at(-1);
  const draftJson = (() => { try { return JSON.parse(draftCall?.raw); } catch { return null; } })();
  const draftUser = draftCall?.body.contents[0].parts[0].text || "";
  return {
    score: parseScore(calls("score")[0]?.raw),
    terms: parseSearchTerms(calls("keywords")[0]?.raw),
    keywordCalls: calls("keywords").length,
    newsSearches: log.newsSearches,
    rssItems: log.rssItems,
    relevance: calls("relevance")[0] ? parseRelevance(calls("relevance")[0].raw, 5) : null,
    draftCalls: calls("draft").length,
    newsInDraftPrompt: draftUser.includes("\nNews item:\n"),
    draftPromptNews: draftUser.split("\nNews item:\n")[1] || "",
    modelNewsUsed: draftJson?.news_used,
    replies: log.telegram,
  };
}

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const flagCount = (s) => (s || "").split(FLAG).length - 1;
const flagOk = (draft, expected) => expected
  ? flagCount(draft) === 1 && draft.endsWith(`\n\n${FLAG}`)
  : flagCount(draft) === 0;
// A draft reply is: grade + draft (+ flag), then SEP, then the Related news section.
const SEP = "\n\n———\n";
const draftOf = (reply) => (reply || "").split(SEP)[0];
const relatedOf = (reply) => (reply || "").split(SEP)[1] || "";
const usedInReply = (reply) => relatedOf(reply).includes("Used in this draft");
const endsWithQuestion = (reply) => {
  const lines = draftOf(reply).split("\n").map((l) => l.trim()).filter((l) => l && l !== FLAG);
  return lines.at(-1)?.endsWith("?");
};
function show(r) {
  if (r.score) console.log(`  score=${r.score.score}  "${r.score.reason}"`);
  if (r.terms) console.log(`  keywords=${JSON.stringify(r.terms.keywords)}  phrase="${r.terms.search_phrase}"`);
  if (r.rssItems) console.log(`  google news: ${r.rssItems.length} results; top = "${r.rssItems[0]?.headline}" (${r.rssItems[0]?.source}, ${r.rssItems[0]?.date})`);
  if (r.relevance) console.log(`  relevance: ${r.relevance.index === 0 ? "none relevant" : `picked #${r.relevance.index} — ${r.relevance.summary}`}`);
  if (r.newsInDraftPrompt) console.log("  news passed to drafting:\n" + r.draftPromptNews.split("\n").slice(0, 5).map((l) => "    " + l).join("\n"));
  if (r.modelNewsUsed !== undefined) console.log(`  model news_used=${r.modelNewsUsed}`);
  r.replies.forEach((m, i) => console.log(`  --- telegram message ${i + 1} ---\n` + m.split("\n").map((l) => "  | " + l).join("\n")));
}

const NIACINAMIDE = "I've noticed that customers often ask whether our niacinamide is 5% or 10%, but the percentage alone doesn't tell you much. The pH, delivery base and batch consistency can all affect what the finished product actually delivers. We should explain why concentration on the label is only the beginning of the question.";
const PERSONAL = "Last month I sat in on our customer-service calls for a full week. What surprised me most was how often people apologised before asking a basic question, like 'sorry, this is probably silly, but can I use this with retinol?'. 31 of the 118 calls started with an apology. If customers feel embarrassed asking, that is a labelling failure on our side, not theirs. We are rewriting our back labels to answer the three questions we hear most.";

// ---- TEST 1 -------------------------------------------------------------------
{
  console.log("\nTEST 1 — substantive note with obvious news potential");
  const r = await runNote(NIACINAMIDE);
  show(r);
  check("B1.1 score >= 6", r.score?.score >= 6);
  check("Gemini extracted 3–5 keywords and a search phrase", r.terms && r.terms.keywords.length >= 3 && r.terms.keywords.length <= 5 && r.terms.search_phrase.length > 0);
  console.log(`  queries sent: ${JSON.stringify(r.newsSearches)}`);
  check("Google News searched with the search phrase first", r.newsSearches.length >= 1 && r.newsSearches[0].startsWith(r.terms?.search_phrase));
  check("results retrieved with headline/source/date/url", r.rssItems?.length > 0 && r.rssItems.every((a) => a.headline && a.source && a.date && a.url.startsWith("https://")));
  check("relevance was evaluated", r.relevance !== null);
  check("news only passed to drafting if judged relevant", r.newsInDraftPrompt === (r.relevance?.index > 0));
  check("draft generated", r.draftCalls >= 1 && r.replies[0]?.length > 100 && !r.replies[0].includes(REJECT_PREFIX));
  check("reply leads with the grade", r.replies[0]?.startsWith(`Score: ${r.score?.score}/10 — ${r.score?.reason}\n\n`));
  check("draft keeps paragraph breaks", r.replies[0]?.includes("\n\n"));
  check("draft ends with an opening question to her network", endsWithQuestion(r.replies[0]));
  const used = r.newsInDraftPrompt && usedInReply(r.replies[0]);
  check(`flag ${used ? "present at the very end of the draft (news used)" : "absent (news not used)"}`, flagOk(draftOf(r.replies[0]), used));
  check("reply ends with a Related news section with Google News links",
    r.replies.length === 1 && relatedOf(r.replies[0]).startsWith("Related news") && relatedOf(r.replies[0]).includes("https://news.google.com/"));
}

// ---- TEST 2 -------------------------------------------------------------------
{
  console.log("\nTEST 2 — substantive personal observation, news unlikely to help");
  const r = await runNote(PERSONAL);
  show(r);
  check("passes B1.1", r.score?.score >= 6);
  check("draft generated and based on the note", r.replies[0]?.includes("31") && r.replies[0]?.includes("118"));
  check("draft keeps paragraph breaks", r.replies[0]?.includes("\n\n"));
  check("draft ends with an opening question to her network", endsWithQuestion(r.replies[0]));
  const used = usedInReply(r.replies[0]);
  check(`no flag unless news actually used (news in prompt=${r.newsInDraftPrompt}, news_used=${r.modelNewsUsed ?? "n/a"})`,
    flagOk(draftOf(r.replies[0]), used) && (r.newsInDraftPrompt || !used));
  check("reply ends with a Related news section", relatedOf(r.replies[0]).startsWith("Related news"));
}

// ---- TEST 3 -------------------------------------------------------------------
{
  console.log("\nTEST 3 — scoring rejection");
  const r = await runNote("Write something about niacinamide tomorrow.");
  show(r);
  check("B1.1 score < 6", r.score?.score < 6);
  check("NO keyword extraction", r.keywordCalls === 0);
  check("NO Google News search", r.newsSearches.length === 0);
  check("NO drafting", r.draftCalls === 0);
  check("rejection message sent, workflow stops", r.replies.length === 1 && r.replies[0] === `Score: ${r.score?.score}/10\n\n` + REJECT_PREFIX + r.score?.reason);
}

// ---- Failure handling: news layer never blocks drafting --------------------------
{
  console.log("\nTEST 4 — news layer failures fall back to drafting without news");
  const cases = [
    ["malformed keyword JSON", { keywords: "keywords: niacinamide, pH" }],
    ["too few keywords", { keywords: '{"keywords":["niacinamide"],"search_phrase":"niacinamide"}' }],
    ["Google News network failure", { news: "error" }],
    ["Google News returns no results", { news: "<rss><channel></channel></rss>" }],
    ["result missing metadata", { news: "<rss><channel><item><title>No link or date</title></item></channel></rss>" }],
  ];
  for (const [label, injected] of cases) {
    const r = await runNote(NIACINAMIDE, injected);
    check(`${label}: draft still sent, no news, no flag, Related news explains why`,
      r.draftCalls >= 1 && !r.newsInDraftPrompt && r.replies.length === 1 && draftOf(r.replies[0]).length > 100 &&
      flagOk(draftOf(r.replies[0]), false) && relatedOf(r.replies[0]).startsWith("Related news:"));
  }
}

// ---- The flag follows news_used, not news_found ---------------------------------
{
  console.log("\nTEST 5 — verify flag logic");
  // A relevant-looking fixture article, so the "news found" paths are exercised deterministically.
  const fixture = `<rss><channel><item><title>Regulator asks cosmetic brands to back up ingredient-percentage claims - Test Wire</title><link>https://news.google.com/rss/articles/TEST</link><pubDate>${new Date().toUTCString()}</pubDate><source url="https://example.com">Test Wire</source></item></channel></rss>`;

  const found = await runNote(NIACINAMIDE, { news: fixture, draft: ['{"draft":"A post that ignores the article entirely and talks only about pH and delivery base in niacinamide serums, at some length so it looks real.","news_used":false}'] });
  check("news found but draft says news_used=false → no flag; article listed as most relevant (not used)",
    found.newsInDraftPrompt && flagOk(draftOf(found.replies[0]), false) && relatedOf(found.replies[0]).includes("Most relevant (not used in the draft)"));

  const used = await runNote(NIACINAMIDE, { news: fixture, draft: ['{"draft":"Regulators are now asking brands to back up percentage claims. That is a start. The pH and delivery base matter just as much.","news_used":true}'] });
  check("news_used=true → flag once at the very end of the draft; article listed as used, with URL",
    flagOk(draftOf(used.replies[0]), true) && usedInReply(used.replies[0]) && relatedOf(used.replies[0]).includes("https://news.google.com/rss/articles/TEST"));

  const misplaced = await runNote(NIACINAMIDE, { news: fixture, draft: ['{"draft":"[VERIFY NEWS] Opening line about pH.\\n\\nMore about delivery base and batch consistency here. [VERIFY NEWS]","news_used":false}'] });
  check("model-written flags are stripped when news_used=false", flagOk(draftOf(misplaced.replies[0]), false));

  const understated = await runNote(NIACINAMIDE, { news: fixture, draft: ['{"draft":"As Test Wire reported this week, regulators want proof behind percentages. The pH matters too.","news_used":false}'] });
  check("draft cites the source but claims news_used=false → flag added anyway", flagOk(draftOf(understated.replies[0]), true));

  const none = await runNote(NIACINAMIDE, { news: "<rss><channel></channel></rss>", draft: ['{"draft":"A post about pH and delivery base in niacinamide serums, long enough to be a real draft for this test.","news_used":true}'] });
  check("no article found but model claims news_used=true → no flag", flagOk(draftOf(none.replies[0]), false));

  const broken = await runNote(NIACINAMIDE, { news: fixture, draft: ["not json", "still not json"] });
  check("malformed draft JSON twice → plain-text fallback draft, no flag",
    broken.replies.length === 1 && draftOf(broken.replies[0]).length > 100 && flagOk(draftOf(broken.replies[0]), false));
}

// ---- Parsers ------------------------------------------------------------------
{
  console.log("\nTEST 6 — parsers");
  check("search terms: rejects malformed / <3 keywords / non-string phrase",
    [null, "", "nope", '{"keywords":["a","b"],"search_phrase":"x"}', '{"keywords":["a","b","c"],"search_phrase":5}', '{"keywords":"a,b,c","search_phrase":"x"}']
      .every((s) => parseSearchTerms(s) === null));
  const t = parseSearchTerms('{"keywords":["a","b","c","d","e","f"],"search_phrase":"latest niacinamide news pH"}');
  check("search terms: trims to 5 keywords and strips generic words", t.keywords.length === 5 && t.search_phrase === "niacinamide pH");
  check("relevance: rejects out-of-range / missing summary", parseRelevance('{"index":6,"summary":"x"}', 5) === null && parseRelevance('{"index":2,"summary":""}', 5) === null);
  check("relevance: accepts none", parseRelevance('{"index":0,"summary":""}', 5)?.index === 0);
  const rss = parseGoogleNewsRss(`<rss><item><title>Brands &amp; labels: what&#39;s next - The Hindu</title><link>https://news.google.com/a</link><pubDate>Mon, 21 Sep 2026 07:00:00 GMT</pubDate><source url="https://thehindu.com">The Hindu</source></item></rss>`);
  check("rss: decodes entities, strips ' - Source', formats date", rss[0]?.headline === "Brands & labels: what's next" && rss[0].source === "The Hindu" && rss[0].date === "2026-09-21");

  const a = (n) => ({ headline: `H${n}`, source: `S${n}`, date: "2026-09-20", url: `https://news.google.com/${n}` });
  const results = [a(1), a(2), a(3), a(4)];
  const usedTxt = formatRelatedNews({ status: "found", results, article: { ...a(2), summary: "x" } }, { used: true });
  check("related news: used article first and labelled, 3 items max",
    usedTxt.includes("1. Used in this draft") && usedTxt.indexOf("H2") < usedTxt.indexOf("H1") && !usedTxt.includes("H4") && (usedTxt.match(/https:/g) || []).length === 3);
  check("related news: relevant but unused is labelled as not used",
    formatRelatedNews({ status: "found", results, article: { ...a(1), summary: "x" } }, { used: false }).includes("Most relevant (not used in the draft)"));
  const nearest = formatRelatedNews({ status: "none_relevant", results, article: null });
  check("related news: none relevant → says so, lists nearest 3", nearest.includes("None closely matched") && (nearest.match(/https:/g) || []).length === 3);
  check("related news: no results / failed → one honest line",
    formatRelatedNews({ status: "no_results", search_phrase: "q", results: [] }).includes('nothing on Google News in the last 30 days for "q"') &&
    formatRelatedNews({ status: "failed", results: [] }).includes("couldn't be searched"));
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
