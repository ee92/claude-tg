// /commands support: live-fetch the connected session's slash-command roster
// from the SDK, drop pure expertise-style skills (skills with no declared
// argumentHint — those are agent-internal), and render the rest as an
// alphabetical, tappable list. Display names substitute `_` for hyphens and
// colons because Telegram only auto-links /[\w]+ tokens; the catch-all in
// telegram.ts reverses the mapping before forwarding.
//
// supportedCommands() is a control request, only available in streaming-input
// mode, so we feed query() an idle generator that resolves on abort.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { claudeBinaryPath } from "./sdkBinary.js";
import { BLOCKED_COMMANDS, BOT_HANDLED_COMMANDS } from "./slashCommands.js";

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

export function toDisplayName(canonical: string): string {
  return canonical.replace(/[-:]/g, "_");
}

let displayToCanonical = new Map<string, string>();
let hintByCanonical = new Map<string, string>();

export function canonicalizeName(input: string): string | null {
  return displayToCanonical.get(input.toLowerCase()) ?? null;
}

export function commandArgHint(canonicalName: string): string {
  return hintByCanonical.get(canonicalName.toLowerCase()) ?? "";
}

export function clearCommandCache(): void {
  displayToCanonical = new Map();
  hintByCanonical = new Map();
}

// Idle prompt source: holds the SDK session open until the controller aborts,
// then resolves so the generator returns cleanly (rather than parking its
// frame indefinitely).
async function* idleInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Walk every on-disk location that can host a skill (user, plugin caches,
// project-scoped) and return the lowercase set of skill names. Names are
// taken from folder basenames — verified to match the SDK's reported names.
async function discoverSkillNames(cwd: string): Promise<Set<string>> {
  const userRoot = path.join(homedir(), ".claude", "skills");
  const projectRoot = path.join(cwd, ".claude", "skills");
  const pluginsCache = path.join(homedir(), ".claude", "plugins", "cache");

  // Plugin layout: <cache>/<marketplace>/<plugin>/<version>/skills/. Each
  // level is fanned out concurrently so a slow disk doesn't serialize.
  const marketplaces = await listSubdirs(pluginsCache);
  const plugins = (await Promise.all(marketplaces.map(listSubdirs))).flat();
  const versions = (await Promise.all(plugins.map(listSubdirs))).flat();
  const pluginSkillRoots = versions.map((v) => path.join(v, "skills"));

  const allRoots = [userRoot, projectRoot, ...pluginSkillRoots];
  const dirsByRoot = await Promise.all(allRoots.map(listSubdirs));

  const names = new Set<string>();
  for (const dirs of dirsByRoot) {
    for (const d of dirs) names.add(path.basename(d).toLowerCase());
  }
  return names;
}

export async function fetchCommandList(cwd: string): Promise<SlashCommandInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("commands-timeout"), 30_000);

  // Kick off the skill walk in parallel with the SDK process startup.
  const skillsPromise = discoverSkillNames(cwd);

  try {
    const q = query({
      prompt: idleInput(controller.signal),
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
    try { for await (const _ of q) { /* discard */ } } catch { /* aborted */ }

    const skillNames = await skillsPromise;

    // A skill with an empty argumentHint is agent-internal; everything else
    // (built-ins, traditional commands, plugin commands, hint-declaring
    // skills) stays. We also drop blocklisted names and any entry whose
    // name or alias collides with a bot-handled command.
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
        description: c.description.replace(/\s*\((?:user|plugin|builtin|project)\)\s*$/i, ""),
        argumentHint: c.argumentHint || "",
      });
    }

    collected.sort((a, b) => a.name.localeCompare(b.name));

    displayToCanonical = new Map();
    hintByCanonical = new Map();
    for (const c of collected) {
      const lower = c.name.toLowerCase();
      hintByCanonical.set(lower, c.argumentHint);
      const display = toDisplayName(c.name).toLowerCase();
      if (display !== lower) displayToCanonical.set(display, c.name);
    }

    return collected;
  } finally {
    clearTimeout(timer);
  }
}

export function renderCommandList(commands: SlashCommandInfo[], cwd: string): string {
  if (commands.length === 0) return "No commands available in this session.";

  const lines: string[] = [
    `🧭 ${commands.length} commands · ${cwd}`,
    "Tap any. Args-required commands will ask you for args next.",
    "",
  ];
  for (const c of commands) {
    const display = toDisplayName(c.name);
    if (c.argumentHint) {
      lines.push(`/${display}  ${c.argumentHint}`);
    } else {
      lines.push(`/${display}`);
    }
  }
  return lines.join("\n");
}
