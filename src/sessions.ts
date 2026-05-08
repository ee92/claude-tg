// Session discovery. Walks ~/.claude/projects/<encoded>/<sid>.jsonl and reads
// each transcript's first `user` entry to recover the canonical `cwd` —
// bypassing ClaudeCode's lossy directory-name encoding entirely.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface SessionSummary {
  sessionId: string;
  cwd: string;          // canonical, from JSONL
  project: string;      // basename(cwd) — display label
  mtime: number;        // epoch ms
  lastUserText: string; // for /sessions preview
}

interface JsonlEntry {
  type?: string;
  cwd?: string;
  message?: { content?: unknown };
}

// Read a transcript and pull (cwd from first user entry, last user-typed text).
async function readTranscript(path: string): Promise<{ cwd: string | null; lastUserText: string }> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    return { cwd: null, lastUserText: "" };
  }
  const lines = text.split("\n");

  let cwd: string | null = null;
  let lastUserText = "";

  // Forward pass for first cwd; reverse pass for last user-typed text.
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: JsonlEntry;
    try { obj = JSON.parse(line) as JsonlEntry; } catch { continue; }
    if ((obj.type === "user" || obj.type === "assistant") && typeof obj.cwd === "string") {
      cwd = obj.cwd;
      break;
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let obj: JsonlEntry;
    try { obj = JSON.parse(line) as JsonlEntry; } catch { continue; }
    if (obj.type !== "user") continue;
    const content = obj.message?.content;
    let candidate: string | null = null;
    if (typeof content === "string") {
      candidate = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string") { candidate = t; break; }
        }
        // tool_result blocks are not user-typed; abort this entry
        if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
          candidate = null; break;
        }
      }
    }
    if (candidate) { lastUserText = candidate.trim(); break; }
  }

  return { cwd, lastUserText };
}

export async function listRecentSessions(limit = 10): Promise<SessionSummary[]> {
  let projDirs: string[];
  try {
    projDirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  // Gather (mtime, transcriptPath) pairs across all project dirs.
  const candidates: { mtime: number; path: string }[] = [];
  await Promise.all(projDirs.map(async (proj) => {
    const projPath = join(PROJECTS_DIR, proj);
    let entries: string[];
    try {
      const stat = await fs.stat(projPath);
      if (!stat.isDirectory()) return;
      entries = await fs.readdir(projPath);
    } catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(projPath, name);
      try {
        const st = await fs.stat(p);
        candidates.push({ mtime: st.mtimeMs, path: p });
      } catch { /* skip */ }
    }
  }));

  candidates.sort((a, b) => b.mtime - a.mtime);

  const out: SessionSummary[] = [];
  // Over-fetch in case some transcripts have no parseable user entry.
  for (const c of candidates.slice(0, limit * 2)) {
    const sid = basename(c.path, ".jsonl");
    const { cwd, lastUserText } = await readTranscript(c.path);
    if (!cwd) continue;
    out.push({
      sessionId: sid,
      cwd,
      project: basename(cwd) || cwd,
      mtime: c.mtime,
      lastUserText,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function findSessionCwd(sid: string): Promise<string | null> {
  const recent = await listRecentSessions(50);
  return recent.find((s) => s.sessionId === sid)?.cwd ?? null;
}

// Look up sessions whose id starts with `prefix`. Walks every project dir on
// disk (not just the recent N), so /switch can resume an arbitrarily old
// session — the use case for this command is precisely that the target is
// not in the /sessions list. Returns matches sorted newest-first.
export async function findSessionsByPrefix(prefix: string): Promise<SessionSummary[]> {
  if (!prefix) return [];
  let projDirs: string[];
  try {
    projDirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const candidates: { mtime: number; path: string; sid: string }[] = [];
  await Promise.all(projDirs.map(async (proj) => {
    const projPath = join(PROJECTS_DIR, proj);
    let entries: string[];
    try {
      const stat = await fs.stat(projPath);
      if (!stat.isDirectory()) return;
      entries = await fs.readdir(projPath);
    } catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.slice(0, -".jsonl".length);
      if (!sid.startsWith(prefix)) continue;
      const p = join(projPath, name);
      try {
        const st = await fs.stat(p);
        candidates.push({ mtime: st.mtimeMs, path: p, sid });
      } catch { /* skip */ }
    }
  }));

  candidates.sort((a, b) => b.mtime - a.mtime);

  const out: SessionSummary[] = [];
  for (const c of candidates) {
    const { cwd, lastUserText } = await readTranscript(c.path);
    if (!cwd) continue;
    out.push({
      sessionId: c.sid,
      cwd,
      project: basename(cwd) || cwd,
      mtime: c.mtime,
      lastUserText,
    });
  }
  return out;
}

// /status enrichment — model, last-turn context size, and count of user-typed
// messages. Walks all project dirs to locate <sid>.jsonl, then linear-scans.
export interface SessionStats {
  model: string | null;
  // Sum of input + cache_read + cache_creation tokens on the latest assistant
  // turn — i.e. the prompt size of the most recent round-trip. Not the same
  // as "context size of the next turn", but a close enough proxy.
  contextTokens: number | null;
  userMessageCount: number;
}

interface AssistantEntry extends JsonlEntry {
  message?: {
    content?: unknown;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

// Exported for callers that want to read the on-disk JSONL directly (e.g.
// pre-validation in the reply-as-rewind path).
export async function findTranscriptPath(sid: string): Promise<string | null> {
  let projDirs: string[];
  try { projDirs = await fs.readdir(PROJECTS_DIR); } catch { return null; }
  const target = `${sid}.jsonl`;
  for (const proj of projDirs) {
    const p = join(PROJECTS_DIR, proj, target);
    try { await fs.access(p); return p; } catch { /* not in this dir */ }
  }
  return null;
}

// /rewind support — surface the connected session's most recent user-typed
// messages, newest-first. For each user message we capture both its own
// uuid (transparent to the caller) AND its `parentUuid` — the JSONL entry
// immediately above it in the conversation tree. The parent is what the
// SDK's `resumeSessionAt` wants: history is loaded "up to and including"
// that uuid, so the user's next prompt lands right before the rewound
// message. User messages with parentUuid === null are session roots and
// can't be rewound past — skipped here so the picker only shows actionable
// choices. Excludes tool_result entries (tool output, not user-typed) and
// meta/operation lines.
export interface UserMessageEntry {
  uuid: string;
  parentUuid: string;  // anchor passed to resumeSessionAt
  timestamp: number;   // epoch ms (parsed from ISO string in JSONL)
  text: string;        // first text-block of the message, untruncated
}

interface UserJsonlEntry extends JsonlEntry {
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
}

export async function listRecentUserMessages(sid: string, limit: number): Promise<UserMessageEntry[]> {
  const path = await findTranscriptPath(sid);
  if (!path) return [];
  let text: string;
  try { text = await fs.readFile(path, "utf8"); } catch { return []; }
  const lines = text.split("\n");

  const out: UserMessageEntry[] = [];
  // Reverse-walk so we can stop early once we have `limit` matches.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let obj: UserJsonlEntry;
    try { obj = JSON.parse(line) as UserJsonlEntry; } catch { continue; }
    if (obj.type !== "user") continue;
    if (typeof obj.uuid !== "string" || typeof obj.timestamp !== "string") continue;
    // Session-root entries have parentUuid === null; rewinding past them
    // isn't expressible in the SDK's resume model, so skip them.
    if (typeof obj.parentUuid !== "string" || obj.parentUuid.length === 0) continue;

    const content = obj.message?.content;
    let textVal: string | null = null;
    if (typeof content === "string") {
      textVal = content;
    } else if (Array.isArray(content)) {
      let hasToolResult = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const t = (block as { type?: string }).type;
        if (t === "tool_result") { hasToolResult = true; break; }
        if (t === "text" && textVal === null) {
          const tx = (block as { text?: unknown }).text;
          if (typeof tx === "string") textVal = tx;
        }
      }
      if (hasToolResult) continue; // tool result, not user-typed
    }
    if (!textVal) continue;

    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;
    out.push({ uuid: obj.uuid, parentUuid: obj.parentUuid, timestamp: ts, text: textVal.trim() });
  }
  return out;
}

// Reply-as-rewind support — confirm a uuid still exists in this session's
// JSONL before passing it to `resumeSessionAt`. Cheap linear scan; returns
// false if the session's transcript is missing entirely.
export async function findUuidInTranscript(sid: string, uuid: string): Promise<boolean> {
  const path = await findTranscriptPath(sid);
  if (!path) return false;
  let text: string;
  try { text = await fs.readFile(path, "utf8"); } catch { return false; }
  // Cheap substring pre-check before paying for JSON parse on every line.
  // Uuids are 36-char hyphenated; the transcript stores them quoted, so this
  // is a strict-enough first pass to skip the parse loop on most misses.
  if (!text.includes(uuid)) return false;
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes(uuid)) continue;
    let obj: { uuid?: string };
    try { obj = JSON.parse(line) as { uuid?: string }; } catch { continue; }
    if (obj.uuid === uuid) return true;
  }
  return false;
}

// Reply-as-rewind support — count user-typed turns between an anchor uuid
// (exclusive) and the current HEAD (inclusive). Used to render the "N turns
// dropped" tail of the orient breadcrumb. tool_result entries don't count;
// only true user prompts do. Returns 0 if the anchor isn't found, the
// transcript is missing, or no user turns sit after the anchor.
export async function countTurnsBetween(sid: string, anchorUuid: string): Promise<number> {
  const path = await findTranscriptPath(sid);
  if (!path) return 0;
  let text: string;
  try { text = await fs.readFile(path, "utf8"); } catch { return 0; }
  const lines = text.split("\n");

  let pastAnchor = false;
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: UserJsonlEntry;
    try { obj = JSON.parse(line) as UserJsonlEntry; } catch { continue; }
    if (!pastAnchor) {
      if (obj.uuid === anchorUuid) pastAnchor = true;
      continue;
    }
    if (obj.type !== "user") continue;
    const c = obj.message?.content;
    if (typeof c === "string") { count++; continue; }
    if (Array.isArray(c)) {
      let hasToolResult = false;
      let hasText = false;
      for (const block of c) {
        if (block && typeof block === "object") {
          const t = (block as { type?: string }).type;
          if (t === "tool_result") { hasToolResult = true; break; }
          if (t === "text") hasText = true;
        }
      }
      if (!hasToolResult && hasText) count++;
    }
  }
  return count;
}

// Reply-as-rewind support — resolve the latest assistant entry's uuid in
// this session's JSONL. Used after a Stop hook fires to anchor newly-sent
// agent-reply chunks. Returns null if the transcript is missing or has no
// assistant entry yet.
export async function getLatestAssistantUuid(sid: string): Promise<string | null> {
  const path = await findTranscriptPath(sid);
  if (!path) return null;
  let text: string;
  try { text = await fs.readFile(path, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: { type?: string; uuid?: string };
    try { obj = JSON.parse(line) as typeof obj; } catch { continue; }
    if (obj.type === "assistant" && typeof obj.uuid === "string" && obj.uuid.length > 0) {
      return obj.uuid;
    }
  }
  return null;
}

// Reply-as-rewind support — resolve the parentUuid of the most recent
// user-typed entry in this session's JSONL. That parentUuid is what the SDK
// wants as `resumeSessionAt` to mean "rewind to right before this user
// message". tool_result entries are skipped; only true user prompts count.
// Session-root entries (parentUuid === null) are skipped because rewinding
// past them isn't expressible in the resume model.
export async function getLatestUserMessageAnchor(sid: string): Promise<string | null> {
  const recents = await listRecentUserMessages(sid, 1);
  return recents[0]?.parentUuid ?? null;
}

export async function getSessionStats(sid: string): Promise<SessionStats | null> {
  const path = await findTranscriptPath(sid);
  if (!path) return null;
  let text: string;
  try { text = await fs.readFile(path, "utf8"); } catch { return null; }
  const lines = text.split("\n");

  let model: string | null = null;
  let contextTokens: number | null = null;

  // Reverse scan for the most recent assistant entry that carries usage.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: AssistantEntry;
    try { obj = JSON.parse(line) as AssistantEntry; } catch { continue; }
    if (obj.type !== "assistant") continue;
    const u = obj.message?.usage;
    if (!u) continue;
    model = obj.message?.model ?? null;
    contextTokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    break;
  }

  // Forward scan to count user-typed messages (excluding tool_result entries).
  let userMessageCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: JsonlEntry;
    try { obj = JSON.parse(line) as JsonlEntry; } catch { continue; }
    if (obj.type !== "user") continue;
    const c = obj.message?.content;
    if (typeof c === "string") { userMessageCount++; continue; }
    if (Array.isArray(c)) {
      let hasToolResult = false;
      let hasText = false;
      for (const block of c) {
        if (block && typeof block === "object") {
          const t = (block as { type?: string }).type;
          if (t === "tool_result") { hasToolResult = true; break; }
          if (t === "text") hasText = true;
        }
      }
      if (!hasToolResult && hasText) userMessageCount++;
    }
  }

  return { model, contextTokens, userMessageCount };
}
