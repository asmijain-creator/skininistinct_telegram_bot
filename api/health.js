// Reports whether the live deployment's settings are present and working,
// without revealing any values. Open /api/health in a browser to check.
export default async function handler(req, res) {
  const env = process.env;
  const report = {
    environment: env.VERCEL_ENV || "unknown",
    variables: {},
    telegram: null,
    gemini: null,
  };

  for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ALLOWED_CHAT_IDS", "GEMINI_API_KEY", "GEMINI_MODEL"]) {
    const value = env[name];
    report.variables[name] = !value
      ? "MISSING"
      : value !== value.trim()
        ? "set, but has spaces around it"
        : "set";
  }
  report.allowedChatCount = (env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).length;

  try {
    const r = await fetch(`https://api.telegram.org/bot${(env.TELEGRAM_BOT_TOKEN || "").trim()}/getMe`);
    const data = await r.json();
    report.telegram = data.ok ? `ok (@${data.result.username})` : `rejected: ${data.description}`;
  } catch (err) {
    report.telegram = `error: ${err.message}`;
  }

  try {
    const model = env.GEMINI_MODEL || "gemini-3.6-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
      headers: { "x-goog-api-key": (env.GEMINI_API_KEY || "").trim() },
    });
    const data = await r.json();
    report.gemini = r.ok ? `ok (${model})` : `rejected: ${data.error?.message || r.status}`;
  } catch (err) {
    report.gemini = `error: ${err.message}`;
  }

  res.status(200).json(report);
}
