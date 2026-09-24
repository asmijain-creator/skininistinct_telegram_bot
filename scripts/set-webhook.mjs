// Registers the Vercel URL with Telegram so messages to the bot reach api/telegram.js.
// Usage: npm run set-webhook -- https://your-project.vercel.app
import { callTelegram } from "../lib/telegram.js";

const baseUrl = process.argv[2]?.replace(/\/+$/, "");
if (!baseUrl?.startsWith("https://")) {
  console.error("Usage: npm run set-webhook -- https://your-project.vercel.app");
  process.exit(1);
}
if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.error("TELEGRAM_WEBHOOK_SECRET is missing from .env");
  process.exit(1);
}

const webhookUrl = `${baseUrl}/api/telegram`;
await callTelegram("setWebhook", {
  url: webhookUrl,
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message"],
  drop_pending_updates: true,
});

const info = await callTelegram("getWebhookInfo", {});
console.log(`Webhook set to ${info.url}`);
if (info.last_error_message) console.log(`Last error from Telegram: ${info.last_error_message}`);
