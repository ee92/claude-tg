// Read/write the daemon's config file at ~/.config/claude-code-tg/config.json.
// Used by the init wizard, the status subcommand, and the daemon's config
// loader (via src/config.ts).

import fs from "node:fs";
import { configDir, configFilePath } from "./paths.js";

export interface DaemonConfig {
  telegramBotToken: string;
  allowedChatId: number;
  intakePort?: number;
  claudeTimeoutSec?: number;
}

export function readConfig(): DaemonConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const token = typeof parsed.telegramBotToken === "string" ? parsed.telegramBotToken : "";
    const chatId = typeof parsed.allowedChatId === "number" ? parsed.allowedChatId : NaN;
    if (!token || !Number.isInteger(chatId)) return null;
    const out: DaemonConfig = { telegramBotToken: token, allowedChatId: chatId };
    if (typeof parsed.intakePort === "number" && Number.isInteger(parsed.intakePort)) {
      out.intakePort = parsed.intakePort;
    }
    if (typeof parsed.claudeTimeoutSec === "number" && Number.isInteger(parsed.claudeTimeoutSec)) {
      out.claudeTimeoutSec = parsed.claudeTimeoutSec;
    }
    return out;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: DaemonConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = configFilePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, configFilePath());
  // Tighten perms on the directory too — the bot token is sensitive.
  try {
    fs.chmodSync(configDir(), 0o700);
  } catch {
    // best-effort
  }
}

export function deleteConfig(): boolean {
  try {
    fs.unlinkSync(configFilePath());
    return true;
  } catch {
    return false;
  }
}

export function configExists(): boolean {
  try {
    fs.accessSync(configFilePath(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Used by the daemon's config loader. Quietly returns null on miss; the
// daemon's env-override layer can still satisfy the values from process.env.
export function readPartialConfigForDaemon(): Partial<DaemonConfig> {
  const cfg = readConfig();
  if (cfg) return cfg;
  // Even if validation failed, try to surface whatever fields we can parse —
  // the env layer may fill in the rest.
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Partial<DaemonConfig> = {};
      if (typeof parsed.telegramBotToken === "string" && parsed.telegramBotToken.trim()) {
        out.telegramBotToken = parsed.telegramBotToken.trim();
      }
      if (typeof parsed.allowedChatId === "number" && Number.isInteger(parsed.allowedChatId)) {
        out.allowedChatId = parsed.allowedChatId;
      }
      if (typeof parsed.intakePort === "number" && Number.isInteger(parsed.intakePort)) {
        out.intakePort = parsed.intakePort;
      }
      if (typeof parsed.claudeTimeoutSec === "number" && Number.isInteger(parsed.claudeTimeoutSec)) {
        out.claudeTimeoutSec = parsed.claudeTimeoutSec;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

export function configFileLocation(): string {
  return configFilePath();
}

export function configDirLocation(): string {
  return configDir();
}

// Re-exported for symmetry. Avoids callers having to know the path module shape.
export { configFilePath } from "./paths.js";
