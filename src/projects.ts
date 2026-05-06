// Project-folder discovery for the /new command. Lists subdirectories of
// ~/projects/, sorted by mtime descending so the user's recently-touched
// folders surface first. Skips dotfiles and non-directories.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), "projects");

export interface ProjectFolder {
  label: string;  // basename, used as the inline-keyboard button label
  path: string;   // absolute, fed back through the callback payload
}

export async function listProjectFolders(limit = 12): Promise<ProjectFolder[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const stats: { name: string; path: string; mtime: number }[] = [];
  await Promise.all(entries.map(async (name) => {
    if (name.startsWith(".")) return;
    const p = join(PROJECTS_DIR, name);
    try {
      const st = await fs.stat(p);
      if (!st.isDirectory()) return;
      stats.push({ name, path: p, mtime: st.mtimeMs });
    } catch { /* skip unreadable */ }
  }));

  stats.sort((a, b) => b.mtime - a.mtime);
  return stats.slice(0, limit).map((s) => ({ label: s.name, path: s.path }));
}
