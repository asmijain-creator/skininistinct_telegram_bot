// Test the voice instructions (with news context) without Telegram.
// Usage: npm run try -- "my rough note about hiring our first engineer"
import { draftPost, VERIFY_FLAG } from "../lib/gemini.js";
import { findNews, formatRelatedNews } from "../lib/news.js";

const note = process.argv.slice(2).join(" ").trim();
if (!note) {
  console.error('Usage: npm run try -- "your note here"');
  process.exit(1);
}

const news = await findNews(note);
const { draft, newsUsed } = await draftPost(note, news.article);
console.log(newsUsed ? `${draft}\n\n${VERIFY_FLAG}` : draft);
console.log(`\n———\n${formatRelatedNews(news, { used: newsUsed })}`);
