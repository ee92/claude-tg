// Show current install state: config file? Stop hook? Service installed/active?

import { configExists, readConfig, configFileLocation } from "../configFile.js";
import { isHookInstalled } from "./hookFile.js";
import { claudeSettingsPath } from "../paths.js";
import { isServiceActive, isServiceInstalled } from "./installService.js";

export function runStatus(): void {
  const cfg = readConfig();
  console.log("claude-code-tg status\n");
  if (configExists() && cfg) {
    console.log(`config:  ${configFileLocation()}`);
    console.log(`         chat_id=${cfg.allowedChatId}`);
    console.log(`         intake_port=${cfg.intakePort ?? 8765}`);
  } else {
    console.log(`config:  not configured (run \`npx claude-code-tg init\`)`);
  }
  console.log(
    `hook:    ${isHookInstalled() ? `registered in ${claudeSettingsPath()}` : `not registered`}`,
  );
  if (isServiceInstalled()) {
    console.log(`service: installed (${isServiceActive() ? "active" : "inactive"})`);
  } else {
    console.log(`service: not installed`);
  }
}
