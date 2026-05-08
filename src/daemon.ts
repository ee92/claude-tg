// Boots the Telegram bot, the HTTP intake, and the inbound worker.

import { bot, getActiveSessionId, getActiveCwd, registerCommandMenu, sendStartupNotice } from "./telegram.js";
import { startIntake } from "./intake.js";
import { shortSid } from "./format.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("claude-code-tg starting…");

  const intake = startIntake();

  // Replace any legacy command menu entries left over on this bot token.
  // Failure here is non-fatal — log and keep starting.
  try {
    await registerCommandMenu();
  } catch (e) {
    console.warn(`telegram: failed to register command menu: ${(e as Error).message}`);
  }

  // Post a "bridge online" notice to the allowed chat. Pure system signal —
  // never injected into the connected session's transcript.
  try {
    await sendStartupNotice();
  } catch (e) {
    console.warn(`telegram: failed to send startup notice: ${(e as Error).message}`);
  }

  const shutdown = (sig: string) => {
    console.log(`received ${sig}, shutting down`);
    intake.close();
    void bot.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Start long-poll. drop_pending_updates avoids a flood after a restart.
  await bot.start({
    drop_pending_updates: true,
    onStart: () => {
      const sid = getActiveSessionId();
      console.log(
        `claude-code-tg ready — chat_id=${config.allowedChatId} ` +
        `active_session=${sid ? shortSid(sid) : "-"} cwd=${getActiveCwd() ?? "-"}`
      );
    },
  });
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
