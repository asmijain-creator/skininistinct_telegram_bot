# Meera's post drafter

Meera texts a note to a Telegram bot → the bot sends it to Gemini with her voice
instructions → the draft post comes back in the same chat, as a reply to her note.

```
Telegram ──webhook──▶ Vercel: api/telegram.js ──▶ Gemini
    ▲                                              │
    └────────────── draft post ◀───────────────────┘
```

No npm dependencies — it uses Node's built-in `fetch`.

## Files

| File | What it does |
| --- | --- |
| `api/telegram.js` | The webhook Vercel runs for each Telegram message |
| `lib/gemini.js` | Shared Gemini client; scores each note (guardrail), then drafts with optional news context |
| `lib/news.js` | For notes that pass: search terms → Google News RSS → relevance check → one article (or none) |
| `lib/telegram.js` | Sends replies (splits anything over Telegram's 4096-char limit) |
| `prompts/voice-skill.txt` | Meera's voice description, sent to Gemini word for word on every draft |
| `scripts/set-webhook.mjs` | One-time: tells Telegram where your Vercel app is |
| `scripts/try-draft.mjs` | Test the voice prompt from your terminal, no Telegram needed |
| `scripts/test-guardrail.mjs` | `npm run test-guardrail`: end-to-end tests of the scoring guardrail (real Gemini, fake Telegram) |
| `scripts/test-news.mjs` | `npm run test-news`: end-to-end tests of the news layer and `[VERIFY NEWS]` flag, with fault injection |
| `vercel.json` | 60s timeout, and bundles `prompts/` with the function |
| `.env.example` | The environment variables you need |

## Setup

You need Node 20+ locally only for the two helper scripts.

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, and copy the token.
2. **Get a Gemini key** at <https://aistudio.google.com/apikey>.
3. **Fill in `.env`.** Copy `.env.example` to `.env` and add the token, the Gemini
   key and a made-up `TELEGRAM_WEBHOOK_SECRET` (letters, numbers, `_`, `-`).
   Leave `ALLOWED_CHAT_IDS` empty for now.
4. **Check the voice.** `prompts/voice-skill.txt` already holds Meera's voice. Try it:
   ```bash
   npm run try -- "note: we lost a big customer today, lessons on over-promising"
   ```
5. **Deploy to Vercel.** Push to GitHub and import it at vercel.com/new (or run
   `vercel` from this folder). In **Project → Settings → Environment Variables**
   add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`
   (and `GEMINI_MODEL` if you want a different model), then redeploy.
6. **Connect Telegram to Vercel:**
   ```bash
   npm run set-webhook -- https://your-project.vercel.app
   ```
7. **Lock it to Meera.** Have Meera send `/start` to the bot. It replies with her
   chat ID. Add that as `ALLOWED_CHAT_IDS` in Vercel and redeploy.
   Until then the bot answers `/start` but ignores notes, so strangers who find
   the bot can't use up your Gemini quota.

Now any text note Meera sends gets a draft back.

## Changing things later

- **Voice:** edit or replace `prompts/voice-skill.txt` and redeploy. Its full text is
  sent to Gemini as the instructions for every draft.
- **Scoring guardrail:** every note is scored 0–10 by Gemini before drafting. Notes under 6
  get a short reply explaining why, and no draft. The rubric is `SCORING_PROMPT` and the
  threshold is `MIN_DRAFT_SCORE` in `lib/gemini.js`.
- **News context:** notes that pass get one Google News search (no key needed, last 30 days).
  An article is used only if Gemini judges it genuinely relevant and actually works it into the
  draft; then the draft ends with `[VERIFY NEWS]` and a second message gives the article link.
  Any news failure just means a draft without news.
- **Model:** set `GEMINI_MODEL` in Vercel (default `gemini-3.6-flash`).
- **Output format:** `lib/gemini.js` adds fixed rules after the voice file —
  use only facts from the note, write [add figure] instead of inventing numbers,
  return only the post, and use plain text (Telegram would show Markdown `**` literally).

## Troubleshooting

- **Bot doesn't reply at all:** rerun `npm run set-webhook -- <url>`; it prints
  Telegram's last delivery error. Check Vercel → Logs for the function.
- **"Unauthorized" in logs:** `TELEGRAM_WEBHOOK_SECRET` in Vercel doesn't match `.env`.
  Fix it and rerun `set-webhook`.
- **Replies "something went wrong":** usually a bad Gemini key or model name — the
  exact error is in Vercel logs.
- **Voice notes/photos:** only text is supported; photo captions are treated as notes.
