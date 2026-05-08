// Reverse the install: stop and remove the service, drop the Stop hook,
// optionally delete the config file.

import { askYesNo, closePrompts } from "./prompts.js";
import { removeHook } from "./hookFile.js";
import { isServiceInstalled, uninstallService } from "./installService.js";
import { configExists, deleteConfig, configFileLocation } from "../configFile.js";

export async function runUninstall(): Promise<void> {
  console.log("Uninstalling claude-code-tg…\n");

  if (isServiceInstalled()) {
    uninstallService();
    console.log("✓ Stopped and removed systemd user service");
  } else {
    console.log("· No systemd user service to remove");
  }

  const hook = removeHook();
  if (hook.removed) {
    console.log("✓ Removed Stop hook from ~/.claude/settings.json");
  } else {
    console.log("· No Stop hook to remove");
  }

  if (configExists()) {
    const drop = await askYesNo(
      `Delete saved config (${configFileLocation()})? Bot token will be lost.`,
      false,
    );
    if (drop) {
      deleteConfig();
      console.log("✓ Deleted config");
    } else {
      console.log("· Kept config in place");
    }
  }

  console.log("\nDone.");
  closePrompts();
  process.exit(0);
}
