import { draftPost, scoreNote, MIN_DRAFT_SCORE, VERIFY_FLAG } from "../lib/gemini.js";
import { findNews, formatRelatedNews } from "../lib/news.js";
import { sendMessage, sendTyping } from "../lib/telegram.js";

function allowedChatIds() {
  return (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram webhook is running.");
  }

  // Telegram echoes the secret we registered with setWebhook in this header.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).send("Unauthorized");
  }

  const message = req.body?.message;
  if (!message?.chat) {
    // Edits, reactions, etc. — nothing to do.
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();
  const allowed = allowedChatIds();

  try {
    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        `Hi! Send me a note and I'll reply with a draft post.\n\nYour chat ID is ${chatId}` +
          (allowed.includes(String(chatId)) ? "" : " — add it to ALLOWED_CHAT_IDS in Vercel to enable drafting.")
      );
    } else if (!allowed.includes(String(chatId))) {
      // Don't draft for strangers so nobody else can spend the Gemini quota.
      console.warn(`Ignored message from unauthorised chat ${chatId}`);
      await sendMessage(chatId, `This chat (ID ${chatId}) isn't allowed to use this bot yet. Add the ID to ALLOWED_CHAT_IDS in Vercel.`);
    } else if (!text) {
      await sendMessage(chatId, "I can only work with text notes for now — please type or paste your note.", message.message_id);
    } else {
      await sendTyping(chatId).catch(() => {});
      // Guardrail: only notes that already have substance reach drafting.
      // If scoring fails or is malformed, scoreNote throws and nothing is drafted.
      const { score, reason } = await scoreNote(text);
      console.log(`Note scored ${score}/10: ${reason}`);
      // The grade leads every reply; the draft (and any verify flag) follows it.
      const grade = `Score: ${score}/10`;
      if (score < MIN_DRAFT_SCORE) {
        await sendMessage(
          chatId,
          `${grade}\n\nI didn't create a draft because this note isn't substantive enough yet: ${reason}`,
          message.message_id
        );
      } else {
        // News context (B1.2): never blocks; only a relevant article reaches drafting.
        const news = await findNews(text);
        await sendTyping(chatId).catch(() => {});
        const { draft, newsUsed } = await draftPost(text, news.article);
        const body = newsUsed ? `${draft}\n\n${VERIFY_FLAG}` : draft;
        const related = formatRelatedNews(news, { used: newsUsed });
        await sendMessage(chatId, `${grade} — ${reason}\n\n${body}\n\n———\n${related}`, message.message_id);
      }
    }
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "Sorry, something went wrong making that draft. Please try again in a minute.", message.message_id).catch(
      () => {}
    );
  }

  // Always 200 so Telegram doesn't keep retrying the same note.
  return res.status(200).json({ ok: true });
}
