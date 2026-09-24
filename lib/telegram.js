const TELEGRAM_MAX_LENGTH = 4096;

async function callTelegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

// Telegram rejects messages over 4096 characters, so long drafts are split,
// preferring to break at a paragraph or line boundary.
function splitMessage(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    const window = rest.slice(0, TELEGRAM_MAX_LENGTH);
    let cut = window.lastIndexOf("\n\n");
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = window.lastIndexOf("\n");
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = TELEGRAM_MAX_LENGTH;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendMessage(chatId, text, replyToMessageId) {
  const chunks = splitMessage(text);
  for (const [i, chunk] of chunks.entries()) {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      // Thread the first chunk under Meera's note so drafts are easy to match up.
      ...(i === 0 && replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
        : {}),
    });
  }
}

export async function sendTyping(chatId) {
  await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
}

export { callTelegram };
