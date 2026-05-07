// /menu support: fetch the connected session's slash-command roster live
// from the SDK, then filter + group + render it as a Telegram message that
// shows each command on its own line. Telegram auto-detects /cmd text in
// bot messages and makes it tappable in DMs, so the user can fire any
// listed command in one tap without typing.
//
// We don't cache — the list changes when skills are installed, plugins
// added, or the session's cwd implies project-scoped commands. Fetch is
// cheap (single-digit-hundred ms — the SDK emits init before any prompt
// processing, so we abort right after).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeBinaryPath } from "./sdkBinary.js";
import { BLOCKED_COMMANDS, BOT_HANDLED_COMMANDS } from "./slashCommands.js";

export interface AvailableCommands {
  skills: string[];   // names that appear in init.skills
  builtins: string[]; // everything else in init.slash_commands
}

interface InitPayload {
  slash_commands?: string[];
  skills?: string[];
}

// Spawn an ephemeral SDK session in the given cwd, wait for the init
// message, abort. The connected session's transcript is untouched.
export async function fetchAvailableCommands(cwd: string): Promise<AvailableCommands> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("menu-timeout"), 30_000);
  let init: InitPayload = {};

  try {
    const q = query({
      prompt: " ",
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: claudeBinaryPath,
      },
    });

    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          init = msg as InitPayload;
          controller.abort("menu-got-init");
          break;
        }
      }
    } catch (e) {
      // AbortError on a clean abort-after-init is expected; rethrow real ones.
      if (controller.signal.reason !== "menu-got-init") throw e;
    }
  } finally {
    clearTimeout(timer);
  }

  const all = (init.slash_commands ?? []).map((s) => s.replace(/^\//, ""));
  const skillSet = new Set((init.skills ?? []).map((s) => s.replace(/^\//, "")));

  const skills: string[] = [];
  const builtins: string[] = [];
  for (const name of all) {
    const lower = name.toLowerCase();
    if (BLOCKED_COMMANDS.has(lower)) continue;
    if (BOT_HANDLED_COMMANDS.has(lower)) continue;
    if (skillSet.has(name)) skills.push(name);
    else builtins.push(name);
  }
  skills.sort((a, b) => a.localeCompare(b));
  builtins.sort((a, b) => a.localeCompare(b));

  return { skills, builtins };
}

// Build the Telegram message body. Plain text — Telegram clients auto-link
// any `/cmd` token in a bot message, so each line becomes tappable in DMs
// without us emitting any inline-keyboard plumbing. Header gives a quick
// summary; tail nudges that args-required commands need typing not tapping.
export function renderCommandMenu(c: AvailableCommands, cwd: string): string {
  const total = c.skills.length + c.builtins.length;
  if (total === 0) {
    return "No extra commands available in this session.";
  }

  const lines: string[] = [
    `🧭 ${total} commands available · ${cwd}`,
    "Tap any to send. (Some take args — type those out.)",
  ];

  if (c.skills.length > 0) {
    lines.push("", `Skills & custom (${c.skills.length}):`);
    for (const name of c.skills) lines.push(`/${name}`);
  }

  if (c.builtins.length > 0) {
    lines.push("", `Built-ins (${c.builtins.length}):`);
    for (const name of c.builtins) lines.push(`/${name}`);
  }

  return lines.join("\n");
}
