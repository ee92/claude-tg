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
