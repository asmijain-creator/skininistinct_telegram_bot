import { readFileSync } from "node:fs";
import path from "node:path";

// The founder's voice description, sent to Gemini word for word on every draft.
const VOICE_FILE = path.join(process.cwd(), "prompts", "voice-skill.txt");

// Rules that apply no matter what the voice file says, so the reply is
// accurate and can be copied straight out of Telegram and posted.
const OUTPUT_RULES = `
Output rules:
- Turn the note into a finished post written in the voice described above.
- Use only the facts, numbers and stories in the note. The examples in the voice description come from past posts; do not reuse them unless the note mentions them.
- Never invent a number. If a sentence needs a figure the note doesn't give, write [add figure].
- Reply with the finished post only. No preamble, no "Here's your post", no commentary.
- Use plain text. Do not use Markdown syntax such as **bold**, # headings or [links](url).
`;

let cachedVoice;

function loadVoiceInstructions() {
  if (cachedVoice === undefined) {
    cachedVoice = readFileSync(VOICE_FILE, "utf8").trim();
  }
  return cachedVoice;
}

// Shared Gemini call used by scoring, the news layer and drafting. Returns the reply text.
export async function generate(systemText, userText, generationConfig) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const request = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemText }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userText }],
          },
        ],
        ...(generationConfig ? { generationConfig } : {}),
      }),
    });

  // One retry for temporary Gemini errors (rate limit / overloaded).
  let res = await request();
  if (res.status === 429 || res.status >= 500) {
    console.warn(`Gemini ${res.status}, retrying once`);
    await new Promise((r) => setTimeout(r, 1500));
    res = await request();
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${data.error?.message || res.statusText}`);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    const reason = data.promptFeedback?.blockReason || candidate?.finishReason || "unknown";
    throw new Error(`Gemini returned no text (reason: ${reason})`);
  }
  return text;
}

// Pulls the JSON object out of a model reply (tolerating code fences or stray
// text around it). Returns the parsed object, or null if there isn't one.
export function extractJson(raw) {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---- Drafting ----------------------------------------------------------------

export const VERIFY_FLAG = "[VERIFY NEWS]";

const NEWS_INSTRUCTION = "If this news item is genuinely relevant, use it to make the post timely. If it doesn't fit naturally, ignore it.";

// Governs how an optional news item may be used, and the structured reply
// that tells the app whether it was used (so the verify flag is accurate).
const NEWS_AND_FORMAT_RULES = `
News context rules (apply only when a news item is provided):
- Priority: 1) the note is the primary source of the post; 2) the voice description above governs tone, style and structure; 3) the news item is optional context only.
- Do not rewrite the post around the article, force a news hook, invent connections, or change Meera's position because of the article.
- Open with the note's own point, not the article. If used, the news belongs later in the post as supporting context.
- Only the headline, source, date and summary of the article are known. Do not state anything about the article beyond them.
- If the connection is weak, leave the news out entirely.

Response format:
- Return JSON only: {"draft": "<the finished post, following the output rules above>", "news_used": <true or false>}
- Inside the draft string, keep the post's normal paragraph structure: separate paragraphs with a blank line (\\n\\n). Do not return the post as a single block.
- news_used is true only if the draft includes any information, claim, context or reference taken from the news item. Otherwise false. If no news item was provided, it must be false.
- Never write ${VERIFY_FLAG} or any verification note inside the draft; the app adds it.
`;

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: { draft: { type: "STRING" }, news_used: { type: "BOOLEAN" } },
  required: ["draft", "news_used"],
  propertyOrdering: ["draft", "news_used"],
};

function parseDraft(raw) {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.draft !== "string" || !parsed.draft.trim() || typeof parsed.news_used !== "boolean") {
    return null;
  }
  return parsed;
}

// The model must not place the flag itself; only the app appends it, at the end.
function stripFlag(text) {
  return text.split(VERIFY_FLAG).join("").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Backstop for the self-report: if the draft names the article's source or
// quotes its headline, treat the news as used even if news_used said false.
function mentionsArticle(draft, news) {
  const text = draft.toLowerCase();
  const source = news.source.toLowerCase().replace(/^the\s+/, "");
  return (source.length >= 4 && text.includes(source)) || text.includes(news.headline.toLowerCase());
}

// Returns { draft, newsUsed }. `news` is optional context from lib/news.js.
export async function draftPost(note, news = null) {
  const system = `${loadVoiceInstructions()}\n${OUTPUT_RULES}\n${NEWS_AND_FORMAT_RULES}`;
  let user = `Here is my note. Turn it into a post:\n\n${note}`;
  if (news) {
    user +=
      `\n\nNews item:\nHeadline: ${news.headline}\nSource: ${news.source}\nDate: ${news.date}\n` +
      `Summary: ${news.summary}\nURL: ${news.url}\n\n${NEWS_INSTRUCTION}`;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generate(system, user, { responseMimeType: "application/json", responseSchema: DRAFT_SCHEMA });
    const parsed = parseDraft(raw);
    if (parsed) {
      const draft = stripFlag(parsed.draft);
      const newsUsed = Boolean(news) && (parsed.news_used || mentionsArticle(draft, news));
      return { draft, newsUsed };
    }
    console.warn(`Unusable draft reply (attempt ${attempt}): ${raw.slice(0, 200)}`);
  }

  // Structured drafting failed twice: fall back to the original plain-text
  // draft without news, so the note still gets a draft and no flag is needed.
  const text = await generate(
    `${loadVoiceInstructions()}\n${OUTPUT_RULES}`,
    `Here is my note. Turn it into a post:\n\n${note}`
  );
  return { draft: stripFlag(text), newsUsed: false };
}

// ---- Scoring guardrail -------------------------------------------------
// Runs before draftPost. Notes scoring below MIN_DRAFT_SCORE are not drafted.

export const MIN_DRAFT_SCORE = 6;

const SCORING_PROMPT = `You are a strict editorial gatekeeper for a founder's content pipeline. You are not a writing assistant. Your only job is to decide whether a raw note already contains enough substance to be drafted into a post without inventing information.

Read the note and assign an integer score from 0 to 10 using this rubric.

9-10: Strong, highly substantive idea. The note contains a clear insight, argument, observation, experience, or learning; specific details; and enough reasoning, evidence, examples, or context to develop into meaningful content.

7-8: Clearly draftable. The note contains a meaningful idea worth communicating; specific context, observation, opinion, experience, or useful information; and enough substance to draft without inventing major information.

6: Minimum passing score. The note contains a sufficiently clear and substantive idea and enough material to create a useful draft. Some structuring or expansion may be needed, but the core idea already exists.

4-5: Borderline, reject. The note contains a topic or intention but is underdeveloped; it is mostly a prompt to self rather than actual content; there is insufficient substance to create meaningful content without inventing information.

1-3: Reject. For example: a task or reminder; scheduling or logistics; an abandoned sentence; a fragment with no developed idea; a generic thought with no explanation or context. Examples: "write about sunscreen tomorrow", "Need to talk about peptides", "Maybe do something on this", "Remind me to post this".

0: No usable content. For example: empty, unintelligible, an accidental message, or purely logistical content.

Rules you must follow:
1. Score only what is actually present in the note.
2. Do not score based on what the note could become.
3. A topic alone is not substantive.
4. A future intention is not substantive.
5. A task or reminder is not substantive.
6. Do not infer missing facts, arguments, examples, experiences, or opinions.
7. Do not reward a note merely because it mentions skincare, formulation, Meera, or an interesting subject.
8. If significant information would have to be invented to create a useful draft, the score must be below 6.
9. Be conservative around the 6-point threshold. When in doubt between 5 and 6, choose 5.
10. The purpose of this step is to prevent weak notes from entering the drafting pipeline.

Respond with JSON only, exactly in this shape and with no other fields, no markdown, no draft and no suggestions:
{"score": <integer 0-10>, "reason": "<one concise sentence explaining why the note received this score>"}`;

const SCORE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER" },
    reason: { type: "STRING" },
  },
  required: ["score", "reason"],
  propertyOrdering: ["score", "reason"],
};

// Returns { score, reason } or null if the reply isn't valid. Tolerates code
// fences or stray text around the JSON, but never guesses a missing score.
export function parseScore(raw) {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const { score, reason } = parsed;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;

  return { score, reason: reason.replace(/\s+/g, " ").trim() };
}

// Scores a note 0-10. Retries once on an unusable reply, then throws, so a
// malformed response can never be treated as a pass.
export async function scoreNote(note) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generate(SCORING_PROMPT, `Note to score:\n\n${note}`, {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: SCORE_SCHEMA,
    });
    const result = parseScore(raw);
    if (result) return result;
    console.warn(`Unusable scoring reply (attempt ${attempt}): ${raw.slice(0, 200)}`);
  }
  throw new Error("Gemini scoring returned malformed output twice");
}
