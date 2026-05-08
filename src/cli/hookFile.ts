// Idempotent Stop-hook registration in ~/.claude/settings.json.
//
// The hook is identical to what the old plugin shipped — a fire-and-forget
// curl POST to the local intake. Identifying our entry on un-install is by
// matching the intake URL substring; we never touch other Stop hooks.

import fs from "node:fs";
import path from "node:path";
import { claudeSettingsPath } from "../paths.js";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: { Stop?: HookEntry[] } & Record<string, unknown>;
  [k: string]: unknown;
}

const HOOK_MARKER = "claude-code-tg-stop-hook";

export function buildHookCommand(intakePort: number): string {
  // The marker comment lets us identify our own hook for clean removal even
  // if the user has multiple Stop hooks. Shell ignores it but we substring-match.
  return (
    `# ${HOOK_MARKER}\n` +
    `curl -fsS --max-time 3 -X POST -H 'Content-Type: application/json' ` +
    `--data-binary @- http://127.0.0.1:${intakePort}/stop >/dev/null 2>&1 || true`
  );
}

function readSettings(): ClaudeSettings {
  try {
    const raw = fs.readFileSync(claudeSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" ? parsed : {}) as ClaudeSettings;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

function writeSettings(settings: ClaudeSettings): void {
  const file = claudeSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function isHookInstalled(): boolean {
  const settings = readSettings();
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return false;
  for (const entry of stop) {
    for (const h of entry.hooks ?? []) {
      if (typeof h.command === "string" && h.command.includes(HOOK_MARKER)) return true;
    }
  }
  return false;
}

export function installHook(intakePort: number): { changed: boolean } {
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const hooksBlock = settings.hooks as { Stop?: HookEntry[] };
  if (!Array.isArray(hooksBlock.Stop)) hooksBlock.Stop = [];
  const stop = hooksBlock.Stop;

  // Replace any prior claude-code-tg entry to keep the file clean across
  // re-runs of init (e.g. user changed intake port).
  const filtered: HookEntry[] = [];
  let removedExisting = false;
  for (const entry of stop) {
    const innerKept = (entry.hooks ?? []).filter(
      (h) => !(typeof h.command === "string" && h.command.includes(HOOK_MARKER)),
    );
    if (innerKept.length === entry.hooks?.length) {
      filtered.push(entry);
    } else {
      removedExisting = true;
      if (innerKept.length > 0) filtered.push({ ...entry, hooks: innerKept });
    }
  }

  filtered.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(intakePort),
        timeout: 5,
      },
    ],
  });

  hooksBlock.Stop = filtered;
  writeSettings(settings);
  return { changed: true || removedExisting };
}

export function removeHook(): { removed: boolean } {
  const settings = readSettings();
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return { removed: false };

  const filtered: HookEntry[] = [];
  let removed = false;
  for (const entry of stop) {
    const innerKept = (entry.hooks ?? []).filter(
      (h) => !(typeof h.command === "string" && h.command.includes(HOOK_MARKER)),
    );
    if (innerKept.length === entry.hooks?.length) {
      filtered.push(entry);
    } else {
      removed = true;
      if (innerKept.length > 0) filtered.push({ ...entry, hooks: innerKept });
    }
  }

  if (!removed) return { removed: false };

  if (filtered.length === 0) {
    // Drop the empty Stop array entirely so we don't leave noise in the file.
    if (settings.hooks) delete (settings.hooks as { Stop?: unknown }).Stop;
  } else {
    (settings.hooks as { Stop?: HookEntry[] }).Stop = filtered;
  }
  writeSettings(settings);
  return { removed };
}
