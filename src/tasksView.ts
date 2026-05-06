// Read-only task-board renderer for the /tasks command. Reads the canonical
// board file directly (no shell-out) and produces a phone-friendly Telegram-
// HTML summary tuned for scanability:
//   • show every actionable item (active / plan / blocked / review)
//   • show the top of the todo list, summarise the rest by count
//
// The full board lives at ui.bots.town for deeper review.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { escHtml } from "./telegramHtml.js";
import { age } from "./format.js";

const TASKS_PATH = join(homedir(), "tasks.json");
const TODO_PREVIEW_LIMIT = 8;

interface Task {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  updatedAt: string;
  repo?: string | null;
}

interface BoardFile {
  version?: number;
  tasks: Task[];
}

const SECTIONS: { key: string; label: string; emoji: string }[] = [
  { key: "active",  label: "Active",  emoji: "🟢" },
  { key: "review",  label: "Review",  emoji: "👀" },
  { key: "plan",    label: "Plan",    emoji: "📐" },
  { key: "blocked", label: "Blocked", emoji: "⛔" },
];

function ageLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  return age(t);
}

function renderItem(t: Task): string {
  const repoTag = t.repo ? ` <i>[${escHtml(t.repo)}]</i>` : "";
  return `• ${escHtml(t.title)}${repoTag} · <i>${ageLabel(t.updatedAt)}</i>`;
}

export async function renderTaskBoard(): Promise<string> {
  const raw = await fs.readFile(TASKS_PATH, "utf8");
  const board = JSON.parse(raw) as BoardFile;
  const tasks = Array.isArray(board.tasks) ? board.tasks : [];

  const byStatus = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!byStatus.has(t.status)) byStatus.set(t.status, []);
    byStatus.get(t.status)!.push(t);
  }

  const lines: string[] = [`<b>📋 Task Board</b>`];

  for (const section of SECTIONS) {
    const items = byStatus.get(section.key) ?? [];
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`<b>${section.emoji} ${section.label}</b> (${items.length})`);
    for (const t of items) lines.push(renderItem(t));
  }

  const todos = byStatus.get("todo") ?? [];
  if (todos.length > 0) {
    // Top-of-list = lowest `order` value, which the JSON already gives us in
    // file order. No sort needed.
    const head = todos.slice(0, TODO_PREVIEW_LIMIT);
    const rest = todos.length - head.length;
    lines.push("");
    lines.push(`<b>📌 Todo</b> (${todos.length})`);
    for (const t of head) lines.push(renderItem(t));
    if (rest > 0) lines.push(`<i>… and ${rest} more</i>`);
  }

  if (lines.length === 1) lines.push("", "<i>(board is empty)</i>");

  return lines.join("\n");
}
