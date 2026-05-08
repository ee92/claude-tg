// Install / uninstall a user-mode systemd unit so the daemon auto-starts
// on login (and on boot, if the user has enabled lingering).
//
// User-mode systemd avoids needing sudo for the install itself. The one
// caveat — needing `sudo loginctl enable-linger $USER` for headless boxes
// where the user isn't logged in — is printed to the console at install
// time so the user can act on it.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  systemdUnitName,
  systemdUnitPath,
  systemdUserUnitDir,
} from "../paths.js";

function whichNode(): string {
  return process.execPath;
}

function resolveCliEntry(): string {
  // bin/claude-code-tg.mjs is the wrapper; we prefer pointing at it because
  // its location is stable across npm reinstalls. argv[1] is the bin file
  // when invoked as `claude-code-tg`, or the dist/cli/main.js when invoked
  // as `node dist/cli/main.js` during dev.
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Cannot resolve CLI entry: process.argv[1] is empty");
  }
  return path.resolve(argv1);
}

export function isSystemdAvailable(): boolean {
  const probe = spawnSync("systemctl", ["--user", "status"], { stdio: "ignore" });
  return probe.error === undefined;
}

export function isServiceInstalled(): boolean {
  return fs.existsSync(systemdUnitPath());
}

export function isServiceActive(): boolean {
  const r = spawnSync("systemctl", ["--user", "is-active", systemdUnitName()], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "active";
}

function buildUnit(execStart: string): string {
  return [
    `[Unit]`,
    `Description=claude-code-tg — Telegram bridge for Claude Code`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${execStart}`,
    `Restart=always`,
    `RestartSec=5`,
    `StandardOutput=journal`,
    `StandardError=journal`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

export function installService(): { unitPath: string; lingerHint: string } {
  if (!isSystemdAvailable()) {
    throw new Error(
      "systemd --user is not available on this system. Run `claude-code-tg` in your shell (e.g. inside tmux/screen) for always-on use.",
    );
  }
  const node = whichNode();
  const cli = resolveCliEntry();
  const execStart = `${node} ${cli} start`;

  fs.mkdirSync(systemdUserUnitDir(), { recursive: true });
  fs.writeFileSync(systemdUnitPath(), buildUnit(execStart));

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", systemdUnitName()], {
    stdio: "inherit",
  });

  const user = os.userInfo().username;
  const lingerHint =
    `For the bridge to keep running when you're logged out (e.g. on a VPS),\n` +
    `enable user-service lingering once:\n\n  sudo loginctl enable-linger ${user}\n`;

  return { unitPath: systemdUnitPath(), lingerHint };
}

export function uninstallService(): { removed: boolean } {
  if (!isServiceInstalled()) return { removed: false };
  if (!isSystemdAvailable()) {
    // Best-effort cleanup of the unit file if systemd commands aren't reachable.
    try {
      fs.unlinkSync(systemdUnitPath());
    } catch {
      // ignore
    }
    return { removed: true };
  }
  // disable --now stops + disables in one go. Allow non-zero exit — the unit
  // may already be inactive or unknown to systemd if the user touched things.
  spawnSync("systemctl", ["--user", "disable", "--now", systemdUnitName()], {
    stdio: "inherit",
  });
  try {
    fs.unlinkSync(systemdUnitPath());
  } catch {
    // already gone
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  return { removed: true };
}
