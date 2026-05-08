// Persistent active-session pointer. JSON on disk, written atomically via
// tmp + rename so a mid-write crash never leaves a half-written file.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// state.json sits at the repo root, one level up from the compiled dist/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "..", "state.json");
const TMP_PATH = STATE_PATH + ".tmp";

// Reply-to-route map cap. Each entry maps a Telegram message_id to a session,
// optionally with the JSONL anchor needed to rewind to that point. Two flavors:
//   kind: 'assistant' — entry was a chunk of an agent reply. Replying = "rewind
//     to include this assistant message". anchorUuid is the assistant entry's
//     own uuid (passed to resumeSessionAt as-is).
//   kind: 'user' — entry was the user's own typed message. Replying = "rewind
//     to right before this message; new text replaces it". anchorUuid is the
//     user JSONL entry's parentUuid (the assistant entry above it in the tree).
// Old entries on disk that pre-date this extension carry neither kind nor
// anchorUuid; they keep working in legacy "switch only" mode.
// Bounded FIFO so the map can't grow without limit; 500 covers many days.
const REPLY_ROUTES_LIMIT = 500;

export interface ReplyRoute {
  msg_id: number;
  sid: string;
  kind?: "assistant" | "user";
  anchorUuid?: string;
}

export interface State {
  active_session_id: string | null;
  active_cwd: string | null;
  reply_routes: ReplyRoute[]; // ordered oldest→newest, FIFO eviction at cap
  // Per-session model override. Keys are session ids (sid), values are the
  // model alias or full id the user picked via /model. Absent or null means
  // "let the SDK use the session's default." Sticky across bridge restarts;
  // each session remembers its own pick independently. Trimmed lazily as
  // sessions go away — see compactModelOverrides() if it ever grows large.
  model_overrides: Record<string, string>;
  // Single-shot rewind anchor. Keys are session ids (sid), values are the
  // assistant message uuid the user picked via /rewind — passed as
  // `resumeSessionAt` on the very next turn, then cleared. The SDK truncates
  // history "up to and including" that uuid, so the next user message lands
  // there and the post-anchor branch is dropped. Persisted so a /rewind tap
  // survives a bridge restart before the user types their next prompt.
  pending_resume_at: Record<string, string>;
}

const empty: State = {
  active_session_id: null,
  active_cwd: null,
  reply_routes: [],
  model_overrides: {},
  pending_resume_at: {},
};

export async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    const routes = sanitizeReplyRoutes(parsed.reply_routes);
    return {
      active_session_id: parsed.active_session_id ?? null,
      active_cwd: parsed.active_cwd ?? null,
      reply_routes: routes.slice(-REPLY_ROUTES_LIMIT),
      // Defensive: only accept string-valued entries, drop the rest. Older
      // state.json files won't have this field at all — initialise empty.
      model_overrides: sanitizeStringMap(parsed.model_overrides),
      pending_resume_at: sanitizeStringMap(parsed.pending_resume_at),
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...empty, reply_routes: [], model_overrides: {}, pending_resume_at: {} };
    console.warn(`state: could not parse state.json (${e.message}); starting fresh`);
    return { ...empty, reply_routes: [], model_overrides: {}, pending_resume_at: {} };
  }
}

function sanitizeStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// Drop malformed entries from a possibly-untrusted reply_routes array. Each
// surviving entry has {msg_id, sid} guaranteed; kind/anchorUuid pass through
// only when shaped correctly. Old-format entries (no kind, no anchor) survive
// unchanged so legacy reply-as-switch keeps working during the transition.
function sanitizeReplyRoutes(input: unknown): ReplyRoute[] {
  if (!Array.isArray(input)) return [];
  const out: ReplyRoute[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.msg_id !== "number" || !Number.isFinite(r.msg_id)) continue;
    if (typeof r.sid !== "string" || r.sid.length === 0) continue;
    const entry: ReplyRoute = { msg_id: r.msg_id, sid: r.sid };
    if (r.kind === "assistant" || r.kind === "user") entry.kind = r.kind;
    if (typeof r.anchorUuid === "string" && r.anchorUuid.length > 0) entry.anchorUuid = r.anchorUuid;
    out.push(entry);
  }
  return out;
}

export async function saveState(s: State): Promise<void> {
  await fs.writeFile(TMP_PATH, JSON.stringify(s, null, 2));
  await fs.rename(TMP_PATH, STATE_PATH);
}

// Pure helper: append routes and trim FIFO. Caller persists. Accepts full
// route objects so callers can attach kind/anchorUuid where available.
export function appendReplyRoutes(
  state: State,
  routes: ReplyRoute[],
): State {
  if (routes.length === 0) return state;
  const next = [...state.reply_routes, ...routes];
  const trimmed = next.length > REPLY_ROUTES_LIMIT
    ? next.slice(-REPLY_ROUTES_LIMIT)
    : next;
  return { ...state, reply_routes: trimmed };
}

// Newest-first lookup. Returns the full entry so callers can branch on
// kind/anchorUuid; old-format entries surface with kind/anchorUuid undefined.
export function lookupReplyRouteEntry(state: State, msgId: number): ReplyRoute | null {
  for (let i = state.reply_routes.length - 1; i >= 0; i--) {
    if (state.reply_routes[i].msg_id === msgId) return state.reply_routes[i];
  }
  return null;
}

// Pure helpers for the per-session /model override map. Caller persists.
export function setModelOverride(state: State, sid: string, model: string): State {
  return { ...state, model_overrides: { ...state.model_overrides, [sid]: model } };
}

export function clearModelOverride(state: State, sid: string): State {
  if (!(sid in state.model_overrides)) return state;
  const next = { ...state.model_overrides };
  delete next[sid];
  return { ...state, model_overrides: next };
}

export function getModelOverride(state: State, sid: string): string | null {
  return state.model_overrides[sid] ?? null;
}

// Pure helpers for the per-session pending-rewind anchor. Caller persists.
// Single-shot: read once on the next turn, clear after the SDK has consumed
// it. The /rewind callback writes here; inbound.ts reads + clears.
export function setPendingResumeAt(state: State, sid: string, anchorUuid: string): State {
  return { ...state, pending_resume_at: { ...state.pending_resume_at, [sid]: anchorUuid } };
}

export function clearPendingResumeAt(state: State, sid: string): State {
  if (!(sid in state.pending_resume_at)) return state;
  const next = { ...state.pending_resume_at };
  delete next[sid];
  return { ...state, pending_resume_at: next };
}

export function getPendingResumeAt(state: State, sid: string): string | null {
  return state.pending_resume_at[sid] ?? null;
}
