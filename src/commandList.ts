// /commands support: live-fetch the connected session's slash-command roster
// from the SDK with full per-command metadata (description + argumentHint +
// aliases), then render it as a single alphabetical, tappable list. Telegram
// auto-links `/cmd` tokens in bot messages; underscores are allowed but
// hyphens and colons are not, so display names substitute `_` for both. The
// bridge translates back to the canonical hyphen/colon form before forwarding
// to the SDK.
//
// Why the rich path: the init message's `slash_commands: string[]` is just
// names — it has no argumentHint or alias info. The SDK exposes the full
// SlashCommand[] via the `query.supportedCommands()` control request, but
// control requests only work in streaming-input mode, so we feed query() an
// idle generator that hangs forever and abort once the data is in.
//
// Skills vs commands: the SDK reports both under one shape with no type
// field. We distinguish them by walking the on-disk skill folders (user,
// plugin caches, project-scoped) and intersecting against the SDK roster.
// A skill with no argumentHint is dropped — those are "expertise modules"
// the agent uses autonomously, not user-invokable commands. Skills WITH a
// declared argumentHint are kept (the author signalled "expect direct
// invocation"). Everything else (built-ins, traditional commands, plugin
// commands) stays.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { claudeBinaryPath } from "./sdkBinary.js";
import { BLOCKED_COMMANDS, BOT_HANDLED_COMMANDS } from "./slashCommands.js";

export interface SlashCommandInfo {
  name: string;          // canonical (hyphens and colons preserved)
  description: string;
  argumentHint: string;  // "" if none
}

export interface CommandList {
  // Alphabetical, blocked + bot-handled removed, alias-deduped.
  commands: SlashCommandInfo[];
}

// Telegram only auto-links /[\w]+ in bot messages — hyphens and colons break
// the link and leave the rest non-tappable. So display names substitute `_`
// for both. Reverse mapping is stored in displayToCanonical.
export function toDisplayName(canonical: string): string {
  return canonical.replace(/[-:]/g, "_");
}

// Cache populated by fetchCommandList. Read by the catch-all in telegram.ts
// to translate underscored display forms back to canonical (for forwarding)
// and to decide whether a bare-tap should arm a follow-up args prompt.
let cachedCwd: string | null = null;
let displayToCanonical = new Map<string, string>(); // display (underscored, lowercase) → canonical
let hintByCanonical = new Map<string, string>();    // canonical (lowercase) → argumentHint

// If `input` (lowercased) is a known underscored display form for a canonical
// command with hyphens or colons, return the canonical. Else null.
export function canonicalizeName(input: string): string | null {
  return displayToCanonical.get(input.toLowerCase()) ?? null;
}

// Non-empty argumentHint (e.g. "<instruction>") means the SDK has a documented
// arg signature for this command — caller can prompt for it. Returns "" both
// for "no hint" and for "unknown command" (caller should default to firing
// the command bare).
export function commandArgHint(canonicalName: string): string {
  return hintByCanonical.get(canonicalName.toLowerCase()) ?? "";
}

export function clearCommandCache(): void {
  cachedCwd = null;
  displayToCanonical = new Map();
  hintByCanonical = new Map();
}

export function getCachedCwd(): string | null {
  return cachedCwd;
}

// Idle prompt source: never yields. Keeps the SDK session alive so the
// supportedCommands() control request can complete; the caller's abort
// terminates it once the data is in.
async function* idleInput(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>(() => { /* hang */ });
}

// Collect skill names by walking on-disk skill folders. Each "name" is the
// skill folder's basename (which is also the canonical skill name the SDK
// reports — verified against the SKILL.md frontmatter on this machine).
// Folders walked:
//   1. The user's personal skills dir.
//   2. Each installed plugin's `skills/` subfolder under the plugin cache.
//   3. The connected session's project-scoped skills dir, if present.
// Missing dirs are silently ignored — a fresh install with no plugins is
// the common case and shouldn't error.
async function discoverSkillNames(cwd: string): Promise<Set<string>> {
  const roots: string[] = [];
  roots.push(path.join(homedir(), ".claude", "skills"));
  roots.push(path.join(cwd, ".claude", "skills"));

  // Plugin layout: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/
  const pluginsCache = path.join(homedir(), ".claude", "plugins", "cache");
  try {
    const marketplaces = await fs.readdir(pluginsCache, { withFileTypes: true });
    for (const mp of marketplaces) {
      if (!mp.isDirectory()) continue;
      const mpPath = path.join(pluginsCache, mp.name);
      const plugins = await fs.readdir(mpPath, { withFileTypes: true }).catch(() => []);
      for (const pl of plugins) {
        if (!pl.isDirectory()) continue;
        const plPath = path.join(mpPath, pl.name);
        const versions = await fs.readdir(plPath, { withFileTypes: true }).catch(() => []);
        for (const v of versions) {
          if (!v.isDirectory()) continue;
          roots.push(path.join(plPath, v.name, "skills"));
        }
      }
    }
  } catch { /* no plugins cache, fine */ }

  const names = new Set<string>();
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) names.add(e.name.toLowerCase());
      }
    } catch { /* missing root, skip */ }
  }
  return names;
}

// Spawn an ephemeral SDK session, call supportedCommands(), abort. Roughly
// 800ms on this machine — CLI process startup dominates. The connected
// session's transcript is untouched.
export async function fetchCommandList(cwd: string): Promise<CommandList> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("commands-timeout"), 30_000);

  try {
    const q = query({
      prompt: idleInput(),
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: claudeBinaryPath,
      },
    });

    const all = await q.supportedCommands();
    controller.abort("commands-got-list");

    // Drain any stragglers so the underlying CLI process exits cleanly.
    try {
      for await (const _ of q) { /* discard */ }
    } catch { /* AbortError expected */ }

    // Walk skill folders concurrently with the SDK fetch — small directory
    // reads, dwarfed by the SDK roundtrip, but still worth not serializing.
    const skillNames = await discoverSkillNames(cwd);

    // Filter + alias-dedupe. The SDK reports one entry per canonical command,
    // but if alias names ever surface as separate entries we drop them.
    // Also drop any entry whose canonical OR any alias collides with a
    // bot-owned command — forwarding those would either no-op (bot.command
    // intercepts first) or surprise the user.
    //
    // Skills filter: a name appearing in the on-disk skill set is dropped
    // unless it has a non-empty argumentHint (the author opted into direct
    // invocation by declaring args). Pure expertise-style skills are agent-
    // internal and clutter the menu.
    const seen = new Set<string>();
    const collected: SlashCommandInfo[] = [];
    for (const c of all) {
      const lower = c.name.toLowerCase();
      if (BLOCKED_COMMANDS.has(lower)) continue;
      if (BOT_HANDLED_COMMANDS.has(lower)) continue;
      if (c.aliases?.some((a) => BOT_HANDLED_COMMANDS.has(a.toLowerCase()))) continue;
      if (skillNames.has(lower) && !c.argumentHint) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      if (c.aliases) for (const a of c.aliases) seen.add(a.toLowerCase());
      collected.push({
        name: c.name,
        // Strip the `(user)` / `(plugin)` source-marker suffix the SDK appends
        // — it's UI clutter, the source is implicit.
        description: c.description.replace(/\s*\((?:user|plugin|builtin|project)\)\s*$/i, ""),
        argumentHint: c.argumentHint || "",
      });
    }

    collected.sort((a, b) => a.name.localeCompare(b.name));

    cachedCwd = cwd;
    displayToCanonical = new Map();
    hintByCanonical = new Map();
    for (const c of collected) {
      const lower = c.name.toLowerCase();
      hintByCanonical.set(lower, c.argumentHint);
      const display = toDisplayName(c.name).toLowerCase();
      if (display !== lower) displayToCanonical.set(display, c.name);
    }

    return { commands: collected };
  } finally {
    clearTimeout(timer);
  }
}

// Render the menu body. Plain text, single alphabetical list. Each line is
// `/{display_name}` plus the argumentHint inline if the SDK has one. Telegram
// clients auto-link the `/foo_bar` token, making each line one-tap-to-send.
// The catch-all on the inbound side translates the display form back to the
// canonical name and (for hint-bearing commands) arms a follow-up prompt
// when the user taps with no args.
export function renderCommandList(list: CommandList, cwd: string): string {
  if (list.commands.length === 0) return "No commands available in this session.";

  const lines: string[] = [
    `🧭 ${list.commands.length} commands · ${cwd}`,
    "Tap any. Args-required commands will ask you for args next.",
    "",
  ];
  for (const c of list.commands) {
    const display = toDisplayName(c.name);
    if (c.argumentHint) {
      lines.push(`/${display}  ${c.argumentHint}`);
    } else {
      lines.push(`/${display}`);
    }
  }
  return lines.join("\n");
}
