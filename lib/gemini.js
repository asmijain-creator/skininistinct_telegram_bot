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

export async function draftPost(note) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `${loadVoiceInstructions()}\n${OUTPUT_RULES}` }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: `Here is my note. Turn it into a post:\n\n${note}` }],
        },
      ],
    }),
  });

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
