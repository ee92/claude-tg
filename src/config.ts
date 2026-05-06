// Env validation. Fails fast at startup with a clear message on missing or
// malformed values rather than blowing up later in a hot path.

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) fatal(`${name} is not set`);
  return v;
}

function needInt(name: string): number {
  const raw = need(name);
  const n = Number(raw);
  if (!Number.isInteger(n)) fatal(`${name} is not an integer: ${raw}`);
  return n;
}

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) fatal(`${name} is not an integer: ${raw}`);
  return n;
}

export const config = {
  telegramBotToken: need("TELEGRAM_BOT_TOKEN"),
  allowedChatId: needInt("ALLOWED_CHAT_ID"),
  intakePort: intEnv("INTAKE_PORT", 8765),
  claudeTimeoutSec: intEnv("CLAUDE_TIMEOUT_SEC", 600),
} as const;
