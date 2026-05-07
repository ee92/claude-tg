// Source of truth for slash-command routing in the Telegram bridge.
//
// Every `/cmd` typed by the user falls into one of five buckets, checked in
// priority order:
//
//   distinct  — bridge-only command, no CLI counterpart. Owned by telegram.ts.
//   override  — CLI ships this command but we replace it with a Telegram-
//               native handler (CLI version is TTY-only).
//   wrap      — CLI command runs underneath, bot adds chrome. Owned by
//               telegram.ts (e.g. /compact, /status, /tasks).
//   block     — TTY/browser-required, can't usefully run over the bridge.
//   passthrough (default) — forward to the connected session as-is, capture
//               local_command_output messages back to Telegram.
//
// telegram.ts handles distinct/override/wrap via grammY's `bot.command()`
// (those route by name and short-circuit before reaching the catch-all).
// What's encoded HERE is the block list (so the catch-all can reject early)
// and the alias map (so legacy /sessions and /switch keep redirecting to
// /resume during the deprecation window).
//
// Bucket roster derived from a CLI-binary audit on 2026-05-07. Update when
// upstream Claude Code adds or removes built-ins. The block list is
// conservative: any new built-in defaults to passthrough unless it lands
// here.
//
// Phase-3 candidates (commands worth a Telegram-native UX later):
//   /model, /agents, /skills, /memory, /permissions
// They sit on the block list for now and graduate to override when their
// dedicated UX ships.

// CLI commands that need a real terminal, browser, or are otherwise unusable
// over a bridge daemon. Listed without the leading slash; lookup normalises.
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  // Auth flows (browser launch, would log out the daemon, etc.)
  "account", "api-key", "login", "logout", "signin", "signout", "upgrade",
  // TUI pickers / editors
  "agents", "config", "hooks", "memory", "model", "output-style",
  "permissions", "plugins", "skills",
  // Unavailable in non-interactive SDK mode (CLI rejects with "not available
  // in this environment" — verified by probe); revisit when the native MCP
  // browser ships in Phase 3.
  "mcp",
  // Setup / onboarding wizards
  "doctor", "ide", "migrate-installer", "onboarding", "setup",
  "terminal-setup", "trust",
  // Internal / debug / lifecycle
  "bug", "debug", "exit", "export", "feedback", "heapdump", "quit",
  // External: Egor's own deploy CLI — not bridgeable, runs on the host directly
  "deploy",
]);

// Legacy bot commands that still resolve, redirected to their replacement
// during a one-cycle deprecation window. Bare command (no arg) shows the
// /resume picker; with arg, behaves like /resume <id>.
export const LEGACY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["sessions", "resume"],
  ["switch", "resume"],
]);

// Commands the bot handles itself — distinct (bridge-only), override
// (Telegram-native replacement), and wrap (chrome around the CLI version).
// /menu uses this set to drop these from the auto-discovered list so it
// doesn't surface duplicate or no-op entries. Stored without leading slash.
export const BOT_HANDLED_COMMANDS: ReadonlySet<string> = new Set([
  // Distinct
  "new", "cancel", "disconnect", "menu",
  // Override
  "resume",
  // Legacy aliases (still resolve during deprecation)
  "sessions", "switch",
  // Wrap (CLI runs underneath but bot adds chrome)
  "compact", "status", "tasks", "help", "start",
]);

// User-facing reply when a blocked command is typed. Kept short — the goal
// is to redirect, not lecture.
export function blockedReply(cmd: string): string {
  const hint = blockedHints[cmd];
  const head = `⛔ /${cmd} can't run over Telegram — it needs a real terminal.`;
  return hint ? `${head}\n${hint}` : head;
}

const blockedHints: Record<string, string> = {
  "login": "The bridge already runs as your logged-in session.",
  "logout": "Would disconnect the bridge daemon itself. Do this on the host instead.",
  "signin": "The bridge already runs as your signed-in session.",
  "signout": "Would disconnect the bridge daemon itself. Do this on the host instead.",
  "model": "Native model picker is on the roadmap.",
  "agents": "Native agents browser is on the roadmap.",
  "skills": "Native skills browser is on the roadmap.",
  "memory": "Native memory editor is on the roadmap.",
  "permissions": "Native permissions UI is on the roadmap.",
  "mcp": "Native MCP browser (status + connect/disconnect) is on the roadmap.",
  "deploy": "The deploy CLI runs on the host — open a terminal session.",
};

// Normalise raw user input to a bare command name. Strips leading slash,
// trailing args, surrounding whitespace, lowercases. `/Cost   foo` → `cost`.
export function parseSlashCommand(text: string): { name: string; rest: string } | null {
  const m = text.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: (m[2] ?? "").trim() };
}

export function isBlocked(name: string): boolean {
  return BLOCKED_COMMANDS.has(name.toLowerCase());
}

export function legacyAliasOf(name: string): string | undefined {
  return LEGACY_ALIASES.get(name.toLowerCase());
}
