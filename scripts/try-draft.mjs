// Test the voice instructions without Telegram.
// Usage: npm run try -- "my rough note about hiring our first engineer"
import { draftPost } from "../lib/gemini.js";

const note = process.argv.slice(2).join(" ").trim();
if (!note) {
  console.error('Usage: npm run try -- "your note here"');
  process.exit(1);
}

console.log(await draftPost(note));
