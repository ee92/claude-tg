// Interactive first-run wizard. Asks for the bot token + chat id, registers
// the Stop hook in ~/.claude/settings.json, and offers to install a systemd
// user unit. Idempotent: re-running after a partial setup updates fields
// without breaking earlier state.

import { configExists, readConfig, writeConfig, configFileLocation, type DaemonConfig } from "../configFile.js";
import { ask, askInt, askRequired, askYesNo, closePrompts } from "./prompts.js";
import { installHook, isHookInstalled } from "./hookFile.js";
import { installService, isServiceInstalled } from "./installService.js";
import { claudeSettingsPath } from "../paths.js";

const TOKEN_HINT = "Get one from @BotFather on Telegram. Looks like 123456:AAH...";
const CHAT_ID_HINT = "Your numeric Telegram chat id. Get it from @userinfobot.";

export async function runInit(): Promise<void> {
  const existing = readConfig();
  if (existing) {
    console.log(`A configuration already exists at ${configFileLocation()}.`);
    const update = await askYesNo("Update it?", false);
    if (!update) {
      console.log("Leaving existing config in place.");
      return;
    }
  }

  console.log("\nclaude-code-tg setup\n--------------------\n");
  console.log(TOKEN_HINT);
  const tokenDefault = existing?.telegramBotToken;
  const token = tokenDefault
    ? await ask("Telegram bot token", maskToken(tokenDefault))
    : await askRequired("Telegram bot token:");
  // If the user accepted the default, ask() returns the masked version —
  // detect that and substitute the real value.
  const finalToken =
    tokenDefault && token === maskToken(tokenDefault) ? tokenDefault : token;

  console.log("\n" + CHAT_ID_HINT);
  const chatIdDefault = existing?.allowedChatId;
  const chatId =
    chatIdDefault !== undefined
      ? await askInt("Allowed Telegram chat id", chatIdDefault)
      : await askInt("Allowed Telegram chat id:");

  const cfg: DaemonConfig = {
    telegramBotToken: finalToken,
    allowedChatId: chatId,
  };
  if (existing?.intakePort) cfg.intakePort = existing.intakePort;
  if (existing?.claudeTimeoutSec) cfg.claudeTimeoutSec = existing.claudeTimeoutSec;

  writeConfig(cfg);
  console.log(`\n✓ Saved config to ${configFileLocation()}`);

  if (isHookInstalled()) {
    console.log(`✓ Claude Code Stop hook already registered in ${claudeSettingsPath()}`);
    // Re-install anyway so the hook URL matches the current intakePort if it changed.
    installHook(cfg.intakePort ?? 8765);
  } else {
    installHook(cfg.intakePort ?? 8765);
    console.log(`✓ Registered Claude Code Stop hook in ${claudeSettingsPath()}`);
  }

  if (isServiceInstalled()) {
    console.log(`✓ systemd user service already installed; restart it with:`);
    console.log(`    systemctl --user restart claude-code-tg`);
  } else {
    const wantService = await askYesNo(
      "\nInstall a systemd user service so the bridge auto-starts on login?",
      true,
    );
    if (wantService) {
      try {
        const { unitPath, lingerHint } = installService();
        console.log(`✓ Installed and started service at ${unitPath}`);
        console.log(`\n${lingerHint}`);
      } catch (e) {
        console.warn(`Could not install service: ${(e as Error).message}`);
        console.log("Run the bridge manually with:  npx claude-code-tg start");
      }
    } else {
      console.log("Run the bridge manually with:  npx claude-code-tg start");
    }
  }

  console.log(
    "\nDone. DM your bot from Telegram, then use /resume in Telegram to pick a session to follow.\n",
  );

  // The init command is one-shot — close prompts and exit cleanly so the parent
  // shell prompt returns instead of the readline keeping the event loop alive.
  closePrompts();
  process.exit(configExists() ? 0 : 1);
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
