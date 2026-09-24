// End-to-end test of the scoring guardrail: runs the real webhook handler with
// real Gemini calls, but intercepts Telegram so no messages are sent.
// Usage: npm run test-guardrail
import handler from "../api/telegram.js";
import { parseScore } from "../lib/gemini.js";

const CHAT_ID = 111;
process.env.ALLOWED_CHAT_IDS = String(CHAT_ID);
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "test-token";

const realFetch = globalThis.fetch;
let log;
let fakeScoringReplies = null; // when set, scoring calls get these raw replies instead of Gemini's

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.telegram.org/")) {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body || "{}");
    if (method === "sendMessage") log.telegram.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body);
    const sys = body.system_instruction?.parts?.[0]?.text || "";
    const kind = sys.includes("strict editorial gatekeeper") ? "score" : sys.startsWith("Meera Pillai / Skinstinct") ? "draft" : "news";
    log.gemini.push({ kind, body });
    if (kind === "score" && fakeScoringReplies) {
      const text = fakeScoringReplies.shift();
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }
    const res = await realFetch(url, init);
    const data = await res.clone().json();
    if (kind === "score") log.rawScore = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
    return res;
  }
  return realFetch(url, init);
};

async function runNote(text) {
  log = { gemini: [], telegram: [], rawScore: null };
  const req = {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    body: { update_id: 1, message: { message_id: 7, chat: { id: CHAT_ID }, text } },
  };
  let status;
  const res = {
    status(code) { status = code; return this; },
    json() { return this; },
    send() { return this; },
  };
  await handler(req, res);
  const scored = parseScore(log.rawScore);
  return {
    status,
    score: scored?.score,
    reason: scored?.reason,
    scoringCalls: log.gemini.filter((g) => g.kind === "score").length,
    draftCalled: log.gemini.some((g) => g.kind === "draft"),
    draftRequest: log.gemini.find((g) => g.kind === "draft")?.body,
    replies: log.telegram,
  };
}

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
const REJECT_PREFIX = "I didn't create a draft because this note isn't substantive enough yet: ";

// ---- Test A: substantive note --------------------------------------------
{
  console.log("\nTEST A — substantive note");
  const r = await runNote(
    "I’ve noticed that customers often ask whether our niacinamide is 5% or 10%, but the percentage alone doesn't tell you much. The pH, delivery base and batch consistency can all affect what the finished product actually delivers. We should explain why concentration on the label is only the beginning of the question."
  );
  console.log(`  score=${r.score}  reason="${r.reason}"`);
  check("score >= 6", r.score >= 6);
  check("scoring ran before drafting", r.scoringCalls === 1);
  check("drafting step called", r.draftCalled);
  check("draft sent to Telegram (not a rejection)", r.replies.length >= 1 && !r.replies[0].includes(REJECT_PREFIX) && r.replies[0].length > 100);
  check("reply leads with the grade", r.replies[0]?.startsWith(`Score: ${r.score}/10 — ${r.reason}\n\n`));
  const sys = r.draftRequest?.system_instruction?.parts?.[0]?.text || "";
  check("draft request uses the voice skill, output rules and the note",
    sys.startsWith("Meera Pillai / Skinstinct") && sys.includes("Output rules:") &&
    r.draftRequest.contents[0].parts[0].text.startsWith("Here is my note. Turn it into a post:\n\n"));
  console.log("  --- draft ---\n" + (r.replies[0] || "").split("\n").map((l) => "  | " + l).join("\n"));
}

// ---- Test B: task / reminder ----------------------------------------------
{
  console.log("\nTEST B — task/reminder");
  const r = await runNote("Write something about niacinamide tomorrow.");
  console.log(`  score=${r.score}  reason="${r.reason}"`);
  check("score <= 3", r.score <= 3);
  check("drafting step NOT called", !r.draftCalled);
  check("rejection message sent in required format", r.replies.length === 1 && r.replies[0] === `Score: ${r.score}/10\n\n` + REJECT_PREFIX + r.reason);
  console.log(`  telegram: "${r.replies[0]}"`);
}

// ---- Test C: abandoned / general thought ----------------------------------
{
  console.log("\nTEST C — abandoned/general thought");
  const r = await runNote("Need to write about climate and skincare formulations.");
  console.log(`  score=${r.score}  reason="${r.reason}"`);
  check("score < 6", r.score < 6);
  check("drafting step NOT called", !r.draftCalled);
  check("rejection message sent in required format", r.replies.length === 1 && r.replies[0] === `Score: ${r.score}/10\n\n` + REJECT_PREFIX + r.reason);
  console.log(`  telegram: "${r.replies[0]}"`);
}

// ---- Malformed scoring output never bypasses the guardrail ----------------
{
  console.log("\nTEST D — malformed Gemini scoring output");
  const bad = [
    "not json at all",
    '{"score": "8", "reason": "string score"}',
    '{"score": 7.5, "reason": "non-integer"}',
    '{"score": 11, "reason": "out of range"}',
    '{"score": 8}',
    '{"score": 8, "reason": ""}',
    '{"score": 8, "reason": "truncated',
    "[8]",
    "",
  ];
  check("parser rejects every malformed reply", bad.every((b) => parseScore(b) === null));
  check("parser accepts JSON wrapped in a code fence",
    parseScore('```json\n{"score": 7, "reason": "Fine."}\n```')?.score === 7);

  // A substantive note, but Gemini returns garbage twice: must not draft.
  fakeScoringReplies = ["Sure! Score: 9", '{"score": "9"}'];
  const r = await runNote("I’ve noticed that customers often ask whether our niacinamide is 5% or 10%, but the pH and base matter more.");
  check("retried scoring once, then stopped", r.scoringCalls === 2);
  check("drafting step NOT called", !r.draftCalled);
  check("user told something went wrong (no draft)", r.replies.length === 1 && r.replies[0].startsWith("Sorry, something went wrong"));

  // Garbage once, then valid: recovers via the retry.
  fakeScoringReplies = ["oops", '{"score": 3, "reason": "It is only a reminder."}'];
  const r2 = await runNote("Write something about niacinamide tomorrow.");
  check("recovers on retry and routes by the valid score", r2.scoringCalls === 2 && !r2.draftCalled && r2.replies[0] === "Score: 3/10\n\n" + REJECT_PREFIX + "It is only a reminder.");
  fakeScoringReplies = null;
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
