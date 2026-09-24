// B1.2 news layer: for notes that passed scoring, find one recent, genuinely
// relevant Google News article to give the draft optional timely context.
// Everything here is non-blocking: findNews() never throws, it returns null.
import { generate, extractJson } from "./gemini.js";

const MAX_CANDIDATES = 5;
const NEWS_WINDOW = "30d";
const FETCH_TIMEOUT_MS = 6000;

// ---- 1. Search terms -------------------------------------------------------

const SEARCH_TERMS_PROMPT = `You are preparing a news search for a content-writing workflow.
Read the approved note below and identify the core topic that could benefit from recent news context.
Extract 3–5 specific search terms and combine them into one short Google News search phrase.
Rules:
* Focus on the actual subject of the note.
* Do not invent topics that are not present.
* Avoid generic terms such as 'latest news', 'trending', or 'news'.
* Prefer specific entities, topics, ingredients, industries, technologies, companies, regulations, consumer trends, or events when present.
* Keep the final search phrase concise.
* The phrase should be useful for finding a genuinely relevant recent news article.

Return ONLY valid JSON:
{
"keywords": ["keyword 1", "keyword 2", "keyword 3"],
"search_phrase": "short Google News search phrase"
}
Approved note:
{{NOTE}}`;

const SEARCH_TERMS_SCHEMA = {
  type: "OBJECT",
  properties: {
    keywords: { type: "ARRAY", items: { type: "STRING" } },
    search_phrase: { type: "STRING" },
  },
  required: ["keywords", "search_phrase"],
  propertyOrdering: ["keywords", "search_phrase"],
};

const GENERIC_WORDS = /\b(latest|news|trending|breaking|update|updates)\b/gi;

// Returns { keywords, search_phrase } or null if the reply isn't usable.
export function parseSearchTerms(raw) {
  const parsed = extractJson(raw);
  if (!parsed) return null;

  const { keywords, search_phrase } = parsed;
  if (!Array.isArray(keywords)) return null;
  const cleanKeywords = [...new Set(
    keywords.filter((k) => typeof k === "string").map((k) => k.replace(/\s+/g, " ").trim()).filter(Boolean)
  )];
  if (cleanKeywords.length < 3) return null;

  if (typeof search_phrase !== "string") return null;
  const phrase = search_phrase.replace(GENERIC_WORDS, " ").replace(/\s+/g, " ").trim();
  if (!phrase || phrase.split(" ").length > 12) return null;

  return { keywords: cleanKeywords.slice(0, 5), search_phrase: phrase };
}

export async function extractSearchTerms(note) {
  const raw = await generate(
    "You return only valid JSON.",
    SEARCH_TERMS_PROMPT.replace("{{NOTE}}", note),
    { temperature: 0, responseMimeType: "application/json", responseSchema: SEARCH_TERMS_SCHEMA }
  );
  const terms = parseSearchTerms(raw);
  if (!terms) console.warn(`Unusable search-terms reply: ${raw.slice(0, 200)}`);
  return terms;
}

// ---- 2. Google News RSS (no account or API key) ----------------------------

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// Parses the RSS feed into articles, keeping only items with full metadata.
export function parseGoogleNewsRss(xml) {
  const articles = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const source = tag(item, "source");
    let headline = tag(item, "title");
    // Google News titles end with " - Source"; drop it so the headline stands alone.
    if (source && headline.endsWith(` - ${source}`)) headline = headline.slice(0, -(source.length + 3)).trim();
    const url = tag(item, "link");
    const published = new Date(tag(item, "pubDate"));

    if (!headline || !source || !/^https?:\/\//.test(url) || Number.isNaN(published.getTime())) continue;
    articles.push({ headline, source, date: published.toISOString().slice(0, 10), url });
  }
  return articles;
}

async function fetchGoogleNews(query) {
  const q = encodeURIComponent(`${query} when:${NEWS_WINDOW}`);
  const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  return parseGoogleNewsRss(await res.text());
}

// Searches with the search phrase first. Google News requires every word to
// match, so if that finds fewer than 3 articles, one broader search on the
// keywords tops the list up. Every candidate still goes through the relevance check.
export async function searchGoogleNews(phrase, keywords = []) {
  const articles = await fetchGoogleNews(phrase);
  if (articles.length < 3 && keywords.length) {
    const broader = keywords.slice(0, 3).map((k) => `"${k.replace(/"/g, "")}"`).join(" OR ");
    const seen = new Set(articles.map((a) => a.headline.toLowerCase()));
    for (const a of await fetchGoogleNews(broader).catch(() => [])) {
      if (!seen.has(a.headline.toLowerCase())) articles.push(a);
    }
  }
  return articles.slice(0, MAX_CANDIDATES);
}

// ---- 3. Relevance ------------------------------------------------------------

const RELEVANCE_PROMPT = `You are a strict relevance checker for a founder's content pipeline. Given an approved note and a numbered list of recent news headlines, decide whether any article has a meaningful topical connection to the note's actual subject.

An article is relevant only if it is about the same specific issue the note discusses: for example the same ingredient, formulation or testing question, labelling or claims practice, regulation, or industry practice. It is NOT relevant just because it shares a broad word such as "skincare" or "serum". Shopping lists, product round-ups, celebrity or brand launches, promotions and generic beauty tips are not relevant unless they are specifically about the note's issue.

If more than one is relevant, choose the one most useful as timely context. If none is clearly relevant, choose none. Do not force a match.

Return JSON only: {"index": <number of the chosen article, or 0 for none>, "summary": "<if chosen, one concise sentence describing what the article is about, based only on its headline and source; do not add any facts that are not in the headline. Empty string if none.>"}`;

const RELEVANCE_SCHEMA = {
  type: "OBJECT",
  properties: { index: { type: "INTEGER" }, summary: { type: "STRING" } },
  required: ["index", "summary"],
  propertyOrdering: ["index", "summary"],
};

// Returns { index (1-based) or 0, summary } or null if the reply isn't usable.
export function parseRelevance(raw, count) {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const { index, summary } = parsed;
  if (!Number.isInteger(index) || index < 0 || index > count) return null;
  if (index === 0) return { index: 0, summary: "" };
  if (typeof summary !== "string" || !summary.trim()) return null;
  return { index, summary: summary.replace(/\s+/g, " ").trim() };
}

export async function pickRelevantArticle(note, articles) {
  const list = articles.map((a, i) => `${i + 1}. ${a.headline} (${a.source}, ${a.date})`).join("\n");
  const raw = await generate(RELEVANCE_PROMPT, `Approved note:\n${note}\n\nHeadlines:\n${list}`, {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: RELEVANCE_SCHEMA,
  });
  const choice = parseRelevance(raw, articles.length);
  if (!choice) {
    console.warn(`Unusable relevance reply: ${raw.slice(0, 200)}`);
    return null;
  }
  if (choice.index === 0) return null;
  return { ...articles[choice.index - 1], summary: choice.summary };
}

// ---- Pipeline ----------------------------------------------------------------

// Returns { headline, source, date, summary, url, keywords, search_phrase } or null.
// Any failure along the way means "no news", never a failed draft.
export async function findNews(note) {
  try {
    const terms = await extractSearchTerms(note);
    if (!terms) return null;
    console.log(`News search: "${terms.search_phrase}" [${terms.keywords.join(", ")}]`);

    const articles = await searchGoogleNews(terms.search_phrase, terms.keywords);
    if (articles.length === 0) {
      console.log("News: no usable results");
      return null;
    }

    const article = await pickRelevantArticle(note, articles);
    if (!article) {
      console.log(`News: none of ${articles.length} results relevant (top was "${articles[0].headline}")`);
      return null;
    }
    console.log(`News: using "${article.headline}" (${article.source}, ${article.date})`);
    return { ...article, keywords: terms.keywords, search_phrase: terms.search_phrase };
  } catch (err) {
    console.warn(`News layer skipped: ${err.message}`);
    return null;
  }
}
