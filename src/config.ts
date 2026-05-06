// Env validation. Fails fast with a clear message on missing/invalid vars.

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FATAL: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.error(`FATAL: ${name} is not an integer: ${raw}`);
    process.exit(1);
  }
  return n;
}

export const config = {
  telegramBotToken: need("TELEGRAM_BOT_TOKEN"),
  allowedChatId: intEnv("ALLOWED_CHAT_ID", 0) || (() => {
    console.error("FATAL: ALLOWED_CHAT_ID is not set");
    process.exit(1);
  })(),
  intakePort: intEnv("INTAKE_PORT", 8765),
  claudeTimeoutSec: intEnv("CLAUDE_TIMEOUT_SEC", 600),
} as const;
