// Persistent active-session pointer. JSON on disk, written atomically via
// tmp + rename so a mid-write crash never leaves a half-written file.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// state.json sits at the repo root, one level up from the compiled dist/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "..", "state.json");
const TMP_PATH = STATE_PATH + ".tmp";

// Reply-to-route map cap. Each entry maps a Telegram message_id (one of the
// chunks of an agent reply) to the session that produced it; if the user
// later replies to that chunk, the next turn is routed to that session
// regardless of which one is currently connected. Bounded FIFO so the map
// can't grow without limit; 500 covers many days of normal use.
const REPLY_ROUTES_LIMIT = 500;

export interface ReplyRoute {
  msg_id: number;
  sid: string;
}

export interface State {
  active_session_id: string | null;
  active_cwd: string | null;
  reply_routes: ReplyRoute[]; // ordered oldest→newest, FIFO eviction at cap
}

const empty: State = { active_session_id: null, active_cwd: null, reply_routes: [] };

export async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    const routes = Array.isArray(parsed.reply_routes) ? parsed.reply_routes : [];
    return {
      active_session_id: parsed.active_session_id ?? null,
      active_cwd: parsed.active_cwd ?? null,
      reply_routes: routes.slice(-REPLY_ROUTES_LIMIT),
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...empty, reply_routes: [] };
    console.warn(`state: could not parse state.json (${e.message}); starting fresh`);
    return { ...empty, reply_routes: [] };
  }
}

export async function saveState(s: State): Promise<void> {
  await fs.writeFile(TMP_PATH, JSON.stringify(s, null, 2));
  await fs.rename(TMP_PATH, STATE_PATH);
}

// Pure helper: append routes and trim FIFO. Caller persists.
export function appendReplyRoutes(
  state: State,
  msgIds: number[],
  sid: string,
): State {
  if (msgIds.length === 0) return state;
  const next = [...state.reply_routes, ...msgIds.map((msg_id) => ({ msg_id, sid }))];
  const trimmed = next.length > REPLY_ROUTES_LIMIT
    ? next.slice(-REPLY_ROUTES_LIMIT)
    : next;
  return { ...state, reply_routes: trimmed };
}

export function lookupReplyRoute(state: State, msgId: number): string | null {
  // Iterate newest-first — typical reply targets the most recent chunks.
  for (let i = state.reply_routes.length - 1; i >= 0; i--) {
    if (state.reply_routes[i].msg_id === msgId) return state.reply_routes[i].sid;
  }
  return null;
}
