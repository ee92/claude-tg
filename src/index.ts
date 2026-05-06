// Boots the Telegram bot, the HTTP intake, and the inbound worker.

import { bot, getActiveSessionId, getActiveCwd } from "./telegram.js";
import { startIntake } from "./intake.js";
import { shortSid } from "./format.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("claudesworth starting…");

  const intake = startIntake();

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
        `claudesworth ready — chat_id=${config.allowedChatId} ` +
        `active_session=${sid ? shortSid(sid) : "-"} cwd=${getActiveCwd() ?? "-"}`
      );
    },
  });
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
