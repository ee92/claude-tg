// Filesystem paths the CLI and daemon both need. Centralised so the
// renaming and XDG-conformance logic live in one place.

import os from "node:os";
import path from "node:path";

const APP_NAME = "claude-code-tg";

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
}

export function configDir(): string {
  return path.join(xdgConfigHome(), APP_NAME);
}

export function configFilePath(): string {
  return process.env.CLAUDE_CODE_TG_CONFIG?.trim() || path.join(configDir(), "config.json");
}

export function dataDir(): string {
  return path.join(xdgDataHome(), APP_NAME);
}

export function uploadsDir(): string {
  return `/tmp/${APP_NAME}-uploads`;
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function systemdUserUnitDir(): string {
  return path.join(xdgConfigHome(), "systemd", "user");
}

export function systemdUnitName(): string {
  return `${APP_NAME}.service`;
}

export function systemdUnitPath(): string {
  return path.join(systemdUserUnitDir(), systemdUnitName());
}
