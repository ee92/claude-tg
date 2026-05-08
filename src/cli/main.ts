// CLI entry point. Routed via the bin wrapper at bin/claude-code-tg.mjs.
//
// Subcommands:
//   init             — interactive setup (token, chat id, hook, optional service)
//   start            — start the daemon in the foreground
//   install-service  — install systemd user unit and start it
//   uninstall        — remove service + hook, optionally drop config
//   status           — show config / hook / service state
//   help             — show usage
//
// No subcommand: smart default — run init if not configured, otherwise start.

import { configExists } from "../configFile.js";

const HELP = `
claude-code-tg — Telegram bridge for Claude Code

Usage:
  npx claude-code-tg [command]

Commands:
  init                Interactive setup (token, chat id, Stop hook, service)
  start               Start the bridge in the foreground
  install-service     Install systemd user unit so the bridge auto-starts
  uninstall           Remove service + Stop hook + (optionally) config
  status              Show install state
  help                This message

Run with no command to set up on first use, or to start the bridge after.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] ?? "").toLowerCase();

  switch (cmd) {
    case "":
    case undefined: {
      // Smart default: init if not configured, else start.
      if (!configExists()) {
        const { runInit } = await import("./init.js");
        await runInit();
      } else {
        const { runStart } = await import("./start.js");
        await runStart();
      }
      return;
    }
    case "init": {
      const { runInit } = await import("./init.js");
      await runInit();
      return;
    }
    case "start": {
      const { runStart } = await import("./start.js");
      await runStart();
      return;
    }
    case "install-service": {
      const { installService } = await import("./installService.js");
      const { unitPath, lingerHint } = installService();
      console.log(`✓ Installed and started service at ${unitPath}`);
      console.log(`\n${lingerHint}`);
      return;
    }
    case "uninstall": {
      const { runUninstall } = await import("./uninstall.js");
      await runUninstall();
      return;
    }
    case "status": {
      const { runStatus } = await import("./status.js");
      runStatus();
      return;
    }
    case "help":
    case "-h":
    case "--help": {
      console.log(HELP.trim());
      return;
    }
    default: {
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP.trim());
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
