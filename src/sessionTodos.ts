// Read-only view of the connected session's TodoWrite list. Walks the
// session's transcript JSONL, finds the most recent TodoWrite tool_use, and
// renders its `todos` array as Telegram-HTML. TodoWrite always passes the
// full list (not patches), so the latest call is the canonical state.
//
// Status values from the tool: "pending", "in_progress", "completed".

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { escHtml } from "./telegramHtml.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface Todo {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | string;
}

async function findTranscriptPath(sid: string): Promise<string | null> {
  let projDirs: string[];
  try { projDirs = await fs.readdir(PROJECTS_DIR); } catch { return null; }
  const target = `${sid}.jsonl`;
  for (const proj of projDirs) {
    const p = join(PROJECTS_DIR, proj, target);
    try { await fs.access(p); return p; } catch { /* not in this dir */ }
  }
  return null;
}

interface JsonlEntry {
  message?: { content?: unknown };
}

// Reverse-scan for the last TodoWrite tool_use; return its todos array, or
// null if the session has never called TodoWrite.
async function readLatestTodos(transcriptPath: string): Promise<Todo[] | null> {
  let text: string;
  try { text = await fs.readFile(transcriptPath, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: JsonlEntry;
    try { obj = JSON.parse(line) as JsonlEntry; } catch { continue; }
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      const b = blk as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;
      const input = b.input as { todos?: Todo[] } | undefined;
      if (input?.todos && Array.isArray(input.todos)) return input.todos;
    }
  }
  return null;
}

const STATUS_EMOJI: Record<string, string> = {
  in_progress: "🔵",
  pending: "⚪",
  completed: "✅",
};

// Render a single todo line, preferring `activeForm` when the item is
// in-progress (TodoWrite encourages "Doing X" phrasing for live items).
function renderTodo(t: Todo): string {
  const emoji = STATUS_EMOJI[t.status] ?? "•";
  const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
  return `${emoji} ${escHtml(text)}`;
}

export async function renderSessionTodos(sid: string): Promise<string> {
  const path = await findTranscriptPath(sid);
  if (!path) return "Couldn't find this session's transcript on disk.";

  const todos = await readLatestTodos(path);
  if (!todos) return "<i>This session hasn't used the TodoWrite tool yet.</i>";
  if (todos.length === 0) return "<i>(todo list is empty)</i>";

  const order = ["in_progress", "pending", "completed"];
  const grouped = new Map<string, Todo[]>();
  for (const t of todos) {
    const key = order.includes(t.status) ? t.status : "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }

  const lines: string[] = [`<b>📋 Session todos</b>`];
  for (const key of order) {
    const items = grouped.get(key);
    if (!items || items.length === 0) continue;
    lines.push("");
    for (const t of items) lines.push(renderTodo(t));
  }
  // Surface any unknown statuses at the end so we never silently swallow data.
  const other = grouped.get("other");
  if (other && other.length > 0) {
    lines.push("");
    for (const t of other) lines.push(renderTodo(t));
  }
  return lines.join("\n");
}
