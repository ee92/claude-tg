// Persistent active-session pointer. JSON on disk, written atomically via
// tmp + rename so a mid-write crash never leaves a half-written file.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// state.json sits at the repo root, one level up from the compiled dist/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "..", "state.json");
const TMP_PATH = STATE_PATH + ".tmp";

export interface State {
  active_session_id: string | null;
  active_cwd: string | null;
}

const empty: State = { active_session_id: null, active_cwd: null };

export async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      active_session_id: parsed.active_session_id ?? null,
      active_cwd: parsed.active_cwd ?? null,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...empty };
    console.warn(`state: could not parse state.json (${e.message}); starting fresh`);
    return { ...empty };
  }
}

export async function saveState(s: State): Promise<void> {
  await fs.writeFile(TMP_PATH, JSON.stringify(s, null, 2));
  await fs.rename(TMP_PATH, STATE_PATH);
}
