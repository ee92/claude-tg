// Daemon config. Two layers, env wins:
//   1) JSON file at ~/.config/claude-code-tg/config.json (written by `claude-code-tg init`)
//   2) process.env overrides (TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, …)
//
// Eager-evaluated at module import — only the daemon imports this. The CLI's
// non-`start` subcommands must not transitively import this file, or they
// will fail when run before the user has configured anything.

import { readPartialConfigForDaemon } from "./configFile.js";

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`);
  console.error(
    `\nFix this by running:\n  npx claude-code-tg init\n` +
      `Or set the missing env vars (TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID).\n`,
  );
  process.exit(1);
}

function envStr(name: string): string | undefined {
  const v = (process.env[name] ?? "").trim();
  return v ? v : undefined;
}

function envInt(name: string): number | undefined {
  const v = envStr(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) fatal(`${name} is not an integer: ${v}`);
  return n;
}

const file = readPartialConfigForDaemon();

const telegramBotToken = envStr("TELEGRAM_BOT_TOKEN") ?? file.telegramBotToken;
if (!telegramBotToken) fatal("TELEGRAM_BOT_TOKEN is not set");

const allowedChatId = envInt("ALLOWED_CHAT_ID") ?? file.allowedChatId;
if (allowedChatId === undefined) fatal("ALLOWED_CHAT_ID is not set");

const intakePort = envInt("INTAKE_PORT") ?? file.intakePort ?? 8765;
const claudeTimeoutSec = envInt("CLAUDE_TIMEOUT_SEC") ?? file.claudeTimeoutSec ?? 600;

export const config = {
  telegramBotToken,
  allowedChatId,
  intakePort,
  claudeTimeoutSec,
} as const;
