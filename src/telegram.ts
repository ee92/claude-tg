// grammY bot wiring. All handlers gated on the configured chat id.
//
// System messages (status, sessions list, startup notice) use the parse-mode
// plugin's `fmt` template tag, which handles MarkdownV2 escaping for us.
// Agent replies route through sendAgentReply, which converts the model's
// Markdown output to Telegram-HTML via ./telegramHtml.

import { Bot, Context, InlineKeyboard } from "grammy";
import { fmt, b, i, code, FormattedString } from "@grammyjs/parse-mode";
import path from "node:path";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { config } from "./config.js";
import {
  listRecentSessions,
  findSessionCwd,
  findSessionsByPrefix,
  getSessionStats,
  listRecentUserMessages,
  findUuidInTranscript,
  countTurnsBetween,
  getLatestUserMessageAnchor,
} from "./sessions.js";
import { age, shortSid, truncate, formatTokens } from "./format.js";
import {
  loadState,
  saveState,
  appendReplyRoutes,
  lookupReplyRouteEntry,
  setModelOverride,
  clearModelOverride,
  getModelOverride,
  setPendingResumeAt,
  clearPendingResumeAt,
  getPendingResumeAt,
  type ReplyRoute,
} from "./state.js";
import { enqueueInbound, cancelActive } from "./inbound.js";
import { renderSessionTodos } from "./sessionTodos.js";
import { isBlocked, blockedReply, parseSlashCommand } from "./slashCommands.js";
import {
  fetchCommandList,
  renderCommandList,
  canonicalizeName,
  commandArgHint,
  clearCommandCache,
} from "./commandList.js";
import { fetchModelList, clearModelCache } from "./modelList.js";
import {
  markdownToTelegramBlocks,
  packBlocks,
  stripTelegramHtml,
  escHtml,
  TELEGRAM_SAFE_CAP,
} from "./telegramHtml.js";

const SESSION_LIST_LIMIT = 10;
const UPLOAD_DIR = "/tmp/claude-code-tg-uploads";

// Telegram's bot API getFile() only serves files up to ~20 MB. Larger
// uploads need a different transport not wired up here, so we reject them
// with a clear message rather than letting getFile() throw a generic error.
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

let state = await loadState();

export const bot = new Bot(config.telegramBotToken);

// Auth gate — silently drop everything from any other chat.
bot.use(async (ctx, next) => {
  if (ctx.chat?.id === config.allowedChatId) {
    await next();
  } else if (ctx.chat) {
    console.warn(`telegram: unauthorized access attempt chat_id=${ctx.chat.id}`);
  }
});

// Best-effort 👀 ack on inbound user messages.
async function ack(ctx: Context): Promise<void> {
  try { await ctx.react("👀"); } catch { /* old client / unsupported */ }
}

const HELP_TEXT =
  "Commands:\n" +
  "/resume [id] – pick a recent session, or jump to one by id\n" +
  "/new – start a fresh session (in $HOME)\n" +
  "/model – pick a model for the connected session (sticky, per-session)\n" +
  "/rewind – pull the session back to a recent message and continue from there\n" +
  "/status – current connection\n" +
  "/compact – compact the connected session\n" +
  "/cancel – stop the in-flight turn and drain the queue\n" +
  "/tasks – show the connected session's TodoWrite list\n" +
  "/commands – list every slash command this session can run (tap to send)\n" +
  "/disconnect – stop following\n" +
  "/help – this message\n\n" +
  "Any other slash command (your skills, /cost, /init, /context, etc.) → " +
  "forwarded to the connected session; output comes back as a chat message.\n" +
  "Plain text → piped into the connected session as a user message.\n" +
  "Photos / documents (PDF, text, markdown, CSV…) → downloaded and shown to " +
  "the session via its Read tool.\n" +
  "Reply to one of the bot's previous messages → switches to the session " +
  "that produced it, just like /resume but one-tap.\n" +
  "Back-to-back messages queue rather than overlap.";

// Pending /new flow: when the user picks a folder via the /new keyboard, we
// stash the cwd here. The next free-text message starts a fresh session in
// that folder (instead of being routed to the connected session) and clears
// the slot. In-memory only — a bridge restart drops the pending state, which
// is fine: the user just reissues /new.
let pendingNewCwd: string | null = null;

// Pending /switch flow: when the user fires bare /switch (so they can tap it
// from the slash-command menu without typing), the next free-text message is
// treated as the session id to switch to. Mutually exclusive with
// pendingNewCwd — setting one clears the other.
let pendingSwitch = false;

// Pending args flow for /commands: tap of a hint-bearing command stashes its
// canonical name here and prompts the user for args. The next text message
// becomes the args and we forward `/{name} {args}`. Cleared on /cancel, any
// other bot command, an inbound photo/document, or after consumption.
let pendingArgs: { canonical: string } | null = null;

// Pending cross-session reply-rewind confirmations. Keyed by short random
// token (embedded in callback_data). Entries expire after REPLY_CONFIRM_TTL_MS;
// also cancelled if the user sends a new message before tapping a button.
// Single-tenant chat, so a plain Map is enough — no per-user partitioning.
interface PendingReplyConfirmation {
  token: string;
  targetSid: string;
  targetCwd: string;
  targetProject: string;
  anchorUuid: string;
  jobText: string;
  userMessageId: number;
  chatId: number;
  promptMsgId: number;
  expiresAt: number;
  // Picks breadcrumb wording on tap: "rewound" for replies, "replaced your
  // message" for edits. Buttons and flow are identical otherwise.
  gestureKind: "reply" | "edit";
}

const REPLY_CONFIRM_TTL_MS = 5 * 60 * 1000;
const pendingReplyConfirmations = new Map<string, PendingReplyConfirmation>();

function makeReplyConfirmToken(): string {
  // 8-char base36, unique enough for the handful of confirmations alive at
  // once. Callback_data caps at 64 bytes; `replyx:<token>:rewind` fits well.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function scheduleReplyConfirmExpiry(token: string): void {
  setTimeout(async () => {
    const pending = pendingReplyConfirmations.get(token);
    if (!pending) return;
    pendingReplyConfirmations.delete(token);
    try {
      await bot.api.editMessageText(
        pending.chatId,
        pending.promptMsgId,
        "Timed out — reply not sent.",
      );
    } catch {
      /* prompt may have been edited / deleted; ignore */
    }
  }, REPLY_CONFIRM_TTL_MS).unref?.();
}

// Drop any pending cross-session confirmations for this chat. Called when
// the user sends a new message before tapping a button — the new message
// supersedes the pending one. Edits the prompt to say "Cancelled." so the
// chat history shows what happened to the buttons.
async function cancelPendingReplyConfirmations(chatId: number): Promise<void> {
  const stale: PendingReplyConfirmation[] = [];
  for (const p of pendingReplyConfirmations.values()) {
    if (p.chatId === chatId) stale.push(p);
  }
  for (const p of stale) {
    pendingReplyConfirmations.delete(p.token);
    try {
      await bot.api.editMessageText(p.chatId, p.promptMsgId, "Cancelled.");
    } catch {
      /* ignore */
    }
  }
}

function clearAllPending(): void {
  pendingNewCwd = null;
  pendingSwitch = false;
  pendingArgs = null;
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Bridge online.\n\n" +
    "/resume to pick a session to follow. Once connected, every end-of-turn " +
    "message from that session lands here, and anything you send back is piped " +
    "into the session.\n\n" +
    HELP_TEXT,
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT);
});

bot.command("status", async (ctx) => {
  const sid = state.active_session_id;
  const cwd = state.active_cwd;
  if (!sid) {
    await ctx.reply("Not connected to any session.\nUse /resume to pick one.");
    return;
  }

  // Best-effort transcript stats — fall back gracefully if the file isn't found.
  const stats = await getSessionStats(sid).catch(() => null);

  const head = cwd
    ? fmt`Connected to session ${code}${shortSid(sid)}${code}\n${i}in ${i}${code}${cwd}${code}`
    : fmt`Connected to session ${code}${shortSid(sid)}${code}`;

  // Surface the per-session model override (set via /model) if present.
  // Show it next to the last-actually-ran model so the user can tell when
  // a pick they just made hasn't taken effect yet (no turn run since).
  const override = getModelOverride(state, sid);
  let msg = head;
  if (override && stats?.model && override !== stats.model) {
    msg = fmt`${msg}\n${b}model${b}: ${code}${override}${code} (override; last turn ran on ${code}${stats.model}${code})`;
  } else if (override && !stats?.model) {
    msg = fmt`${msg}\n${b}model${b}: ${code}${override}${code} (override; not yet used)`;
  } else if (override) {
    msg = fmt`${msg}\n${b}model${b}: ${code}${override}${code} (override)`;
  } else if (stats?.model) {
    msg = fmt`${msg}\n${b}model${b}: ${code}${stats.model}${code}`;
  }
  if (stats) {
    if (stats.contextTokens != null) {
      msg = fmt`${msg}\n${b}context${b}: ${formatTokens(stats.contextTokens)} tokens (last turn)`;
    }
    msg = fmt`${msg}\n${b}user messages${b}: ${String(stats.userMessageCount)}`;
  }
  msg = fmt`${msg}\n(full id: ${code}${sid}${code})`;

  await ctx.reply(msg.text, { entities: msg.entities });
});

// Forward /compact to the connected session. Routed through the inbound
// queue so it serializes behind any in-flight reply rather than
// interrupting it. Bridge surfaces "started" / "complete" notices; the
// CLI's local slash-command handler does the work.
bot.command("compact", async (ctx) => {
  if (!ctx.message || !ctx.chat) return;
  const target = await resolveTarget(ctx);
  if (!target) return;
  await ack(ctx);
  enqueueInbound({
    text: "/compact",
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Universal abort: stops the in-flight turn, drains the queue, and clears
// any half-armed bridge state.
bot.command("cancel", async (ctx) => {
  const hadPending = pendingArgs !== null || pendingSwitch || pendingNewCwd !== null;
  clearAllPending();
  const { cancelledInFlight, queueDrained } = cancelActive();
  if (!cancelledInFlight && queueDrained === 0 && !hadPending) {
    await ctx.reply("Nothing in flight to cancel.");
    return;
  }
  const parts: string[] = [];
  if (cancelledInFlight) parts.push("cancelled in-flight turn");
  if (queueDrained > 0) parts.push(`dropped ${queueDrained} queued`);
  if (hadPending) parts.push("cleared pending input");
  await ctx.reply(`🛑 ${parts.join(", ")}.`);
});

// /new — your next plain-text message starts a fresh session in $HOME.
// We always use the home directory as cwd (matching the agent-ui default)
// rather than asking which folder; ad-hoc sessions don't usually need a
// project-specific cwd, and removing the picker is one fewer tap.
bot.command("new", async (ctx) => {
  const cwd = homedir();
  clearAllPending();
  pendingNewCwd = cwd;
  const m = fmt`Send your first message — it'll start a fresh session in ${code}${cwd}${code}.`;
  await ctx.reply(m.text, { entities: m.entities });
});

// /tasks — show the connected session's in-conversation TodoWrite list,
// extracted from the latest TodoWrite tool_use in its transcript JSONL.
bot.command("tasks", async (ctx) => {
  const sid = state.active_session_id;
  if (!sid) {
    await ctx.reply("Not connected to any session.\nUse /resume to pick one.");
    return;
  }
  try {
    const text = await renderSessionTodos(sid);
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (e) {
    console.error(`telegram: /tasks failed: ${(e as Error).message}`);
    await ctx.reply(`⚠️ couldn't read session todos: ${(e as Error).message}`);
  }
});

// Live-fetched per call (no cache) so plugin / project-skill changes show
// up immediately. ~1s per invocation — CLI process startup dominates.
bot.command("commands", async (ctx) => {
  clearAllPending();
  const target = await resolveTarget(ctx);
  if (!target) return;
  await ack(ctx);
  try {
    const list = await fetchCommandList(target.cwd);
    const body = renderCommandList(list, target.cwd);
    await ctx.reply(body, { link_preview_options: { is_disabled: true } });
  } catch (e) {
    console.error(`telegram: /commands fetch failed: ${(e as Error).message}`);
    await ctx.reply(`⚠️ couldn't fetch commands: ${(e as Error).message}`);
  }
});

bot.command("disconnect", async (ctx) => {
  const prev = state.active_session_id;
  // Preserve reply_routes — they're independent of the active connection,
  // so disconnecting shouldn't invalidate the user's ability to reply to
  // older sessions' messages.
  state = { ...state, active_session_id: null, active_cwd: null };
  await saveState(state);
  if (prev) {
    const m = fmt`Disconnected from ${code}${shortSid(prev)}${code}.`;
    await ctx.reply(m.text, { entities: m.entities });
  } else {
    await ctx.reply("Already disconnected.");
  }
});

// /model — render a tappable keyboard of the connected session's available
// models. Tap a row to set a per-session override; tap Reset to clear.
// The current model gets a green dot — current = override if set, else the
// model the most recent assistant turn ran on. Persisted in state.json so
// the choice survives bridge restarts; per-session, so each session has its
// own pick. Applied at query() time in inbound.ts (see options.model).
bot.command("model", async (ctx) => {
  clearAllPending();
  const target = await resolveTarget(ctx);
  if (!target) return;
  await ack(ctx);
  try {
    const models = await fetchModelList(target.cwd);
    if (models.length === 0) {
      await ctx.reply("No models available for this session.");
      return;
    }

    const override = getModelOverride(state, target.sid);
    const stats = await getSessionStats(target.sid).catch(() => null);
    const effective = override ?? stats?.model ?? null;

    const head = override
      ? fmt`${b}Model for this session${b}\n${i}override active: ${i}${code}${override}${code}`
      : fmt`${b}Model for this session${b}\n${i}no override; last turn ran on ${i}${code}${stats?.model || "?"}${code}`;

    const keyboard = new InlineKeyboard();
    for (const m of models) {
      const marker = effective === m.value ? "🟢 " : "   ";
      keyboard.text(`${marker}${m.displayName}`, `model:${m.value}`).row();
    }
    keyboard.text("✕ Reset to default", "model:reset");

    await ctx.reply(head.text, { entities: head.entities, reply_markup: keyboard });
  } catch (e) {
    console.error(`telegram: /model fetch failed: ${(e as Error).message}`);
    await ctx.reply(`⚠️ couldn't fetch model list: ${(e as Error).message}`);
  }
});

bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
  const value = ctx.match[1];
  await ctx.answerCallbackQuery();
  const sid = state.active_session_id;
  if (!sid) {
    try { await ctx.editMessageText("No connected session — use /resume first."); } catch { /* ignore */ }
    return;
  }
  if (value === "reset") {
    state = clearModelOverride(state, sid);
    await saveState(state);
    const m = fmt`Cleared model override on ${code}${shortSid(sid)}${code}. Subsequent turns use the session's default.`;
    try { await ctx.editMessageText(m.text, { entities: m.entities }); } catch { await ctx.reply(m.text, { entities: m.entities }); }
    return;
  }
  state = setModelOverride(state, sid, value);
  await saveState(state);
  const m = fmt`Model set to ${code}${value}${code} for ${code}${shortSid(sid)}${code}. The next turn will use it.`;
  try { await ctx.editMessageText(m.text, { entities: m.entities }); } catch { await ctx.reply(m.text, { entities: m.entities }); }
});

// /rewind — list the connected session's recent user-typed messages as
// buttons. Tap one → record the resume anchor (parentUuid) on the active
// session; the next typed message is delivered with `resumeSessionAt`,
// which truncates history to that point. Same session id throughout — no
// fork, no clone, no new entry in /resume.
bot.command("rewind", async (ctx) => {
  clearAllPending();
  const target = await resolveTarget(ctx);
  if (!target) return;
  await ack(ctx);
  try {
    const recents = await listRecentUserMessages(target.sid, 5);
    if (recents.length === 0) {
      await ctx.reply("No prior messages to rewind to in this session.");
      return;
    }

    const head = fmt`${b}Rewind to which message?${b}\n${i}The session is pulled back to right before the chosen message; type your next prompt and it continues from there.${i}`;
    const keyboard = new InlineKeyboard();
    for (const msg of recents) {
      // Strip newlines so the button label fits a single Telegram row.
      const snippet = truncate(msg.text.replace(/\s+/g, " "), 40);
      const label = `${age(msg.timestamp)}: ${snippet}`;
      // callback_data carries the parentUuid — the SDK's resume anchor.
      // The picker shows USER messages (recognizable to the user), but the
      // anchor is the assistant entry that immediately precedes them.
      keyboard.text(label, `rewind:${msg.parentUuid}`).row();
    }
    keyboard.text("✕ Cancel", "rewind:cancel");

    await ctx.reply(head.text, { entities: head.entities, reply_markup: keyboard });
  } catch (e) {
    console.error(`telegram: /rewind fetch failed: ${(e as Error).message}`);
    await ctx.reply(`⚠️ couldn't read recent messages: ${(e as Error).message}`);
  }
});

// Cross-session reply confirmation. callback_data shape: replyx:<token>:<action>
// where action ∈ {switch, rewind, cancel}. The token references the
// PendingReplyConfirmation map; switch performs an active-session change
// only, rewind additionally arms `pending_resume_at` after pre-validating
// the anchor in the target's JSONL, and cancel drops the stash silently.
// Any failure (stale token, anchor missing, target's cwd vanished) edits
// the prompt to a refuse-line; the user's text is never delivered.
bot.callbackQuery(/^replyx:([^:]+):(switch|rewind|cancel)$/, async (ctx) => {
  const token = ctx.match[1];
  const action = ctx.match[2] as "switch" | "rewind" | "cancel";
  await ctx.answerCallbackQuery();
  const pending = pendingReplyConfirmations.get(token);
  if (!pending) {
    try { await ctx.editMessageText("Already handled (or timed out)."); } catch { /* ignore */ }
    return;
  }
  pendingReplyConfirmations.delete(token);

  if (action === "cancel") {
    try { await ctx.editMessageText("Cancelled."); } catch { /* ignore */ }
    return;
  }

  // Both switch and rewind paths perform the session switch; only rewind
  // additionally validates+arms the resume anchor.
  if (action === "rewind") {
    const present = await findUuidInTranscript(pending.targetSid, pending.anchorUuid).catch(() => false);
    if (!present) {
      try {
        await ctx.editMessageText(
          "↳ Couldn't rewind — that point is no longer in the conversation. Reply not sent.",
        );
      } catch { /* ignore */ }
      return;
    }
    state = setPendingResumeAt(state, pending.targetSid, pending.anchorUuid);
    await saveState(state);
  }

  // Perform the switch.
  await setActiveSession(pending.targetSid, pending.targetCwd);
  pendingSwitch = false;
  pendingNewCwd = null;

  // Edit the original prompt with the orient breadcrumb so the user can see
  // what happened in the chat history (and the buttons disappear). The verb
  // tracks the original gesture: "rewound" for replies, "replaced your
  // message" for edits.
  let breadcrumb: string;
  if (action === "switch") {
    breadcrumb = `↳ Switched to ${pending.targetProject}.`;
  } else {
    const turns = await countTurnsBetween(pending.targetSid, pending.anchorUuid).catch(() => 0);
    const verb = pending.gestureKind === "edit"
      ? "replaced your message"
      : "rewound";
    breadcrumb = `↳ Switched to ${pending.targetProject} and ${verb}. ${turnsTail(turns)}.`;
  }
  try { await ctx.editMessageText(breadcrumb); } catch { /* ignore */ }

  // Now enqueue the deferred turn against the (now active) target session.
  enqueueInbound({
    text: pending.jobText,
    chatId: pending.chatId,
    userMessageId: pending.userMessageId,
    targetSessionId: pending.targetSid,
    targetCwd: pending.targetCwd,
  });
});

bot.callbackQuery(/^rewind:(.+)$/, async (ctx) => {
  const value = ctx.match[1];
  await ctx.answerCallbackQuery();
  if (value === "cancel") {
    try { await ctx.editMessageText("Rewind cancelled."); } catch { /* ignore */ }
    return;
  }
  const sid = state.active_session_id;
  if (!sid) {
    try { await ctx.editMessageText("No connected session — use /resume first."); } catch { /* ignore */ }
    return;
  }
  try {
    state = setPendingResumeAt(state, sid, value);
    await saveState(state);
    const m = fmt`Rewound ${code}${shortSid(sid)}${code} to the chosen point.\n${i}Type your next message — the conversation continues from there.${i}`;
    try { await ctx.editMessageText(m.text, { entities: m.entities }); } catch { await ctx.reply(m.text, { entities: m.entities }); }
  } catch (e) {
    console.error(`telegram: /rewind state-write failed: ${(e as Error).message}`);
    try { await ctx.editMessageText(`⚠️ rewind failed: ${(e as Error).message}`); } catch { /* ignore */ }
  }
});

// Render the "tap to connect" picker. Shared between /resume (the canonical
// name) and /sessions (legacy alias kept during the deprecation cycle).
async function renderResumePicker(ctx: Context): Promise<void> {
  const sessions = await listRecentSessions(SESSION_LIST_LIMIT);
  if (sessions.length === 0) {
    await ctx.reply("No sessions found yet.");
    return;
  }

  const active = state.active_session_id;
  const parts: FormattedString[] = [fmt`${b}Recent sessions${b} (tap to connect)\n`];
  const keyboard = new InlineKeyboard();
  sessions.forEach((s, idx0) => {
    const idx = idx0 + 1;
    const marker = s.sessionId === active ? "🟢 " : "";
    const preview = truncate(s.lastUserText || "(no user message yet)", 60);
    parts.push(fmt`\n${marker}${idx}. ${b}${s.project}${b} · ${age(s.mtime)}\n   ${i}${preview}${i}`);
    const label = `${idx}. ${s.project} · ${shortSid(s.sessionId)}`;
    keyboard.text(label, `connect:${s.sessionId}`).row();
  });
  keyboard.text("✕ Disconnect", "disconnect");

  // Concatenate the FormattedString fragments.
  let body = parts[0];
  for (let k = 1; k < parts.length; k++) body = fmt`${body}${parts[k]}`;

  await ctx.reply(body.text, { entities: body.entities, reply_markup: keyboard });
}

// /resume — canonical "pick or jump to a session" command. Bare call shows
// the recent-sessions picker (formerly /sessions); with an id arg it
// behaves like the old /switch: prefix-match against the on-disk session
// roster, ambiguity disambiguated, single match connects.
bot.command("resume", async (ctx) => {
  clearAllPending();
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    await renderResumePicker(ctx);
    return;
  }
  await performSwitch(ctx, arg);
});

// Legacy alias: /sessions still shows the picker, with a one-line nudge
// toward the new name.
bot.command("sessions", async (ctx) => {
  clearAllPending();
  await ctx.reply("→ /resume does this now. /sessions still works during the transition.");
  await renderResumePicker(ctx);
});

bot.callbackQuery(/^connect:(.+)$/, async (ctx) => {
  const sid = ctx.match[1];
  await ctx.answerCallbackQuery();
  clearAllPending();
  const cwd = await findSessionCwd(sid);
  if (cwd) {
    await setActiveSession(sid, cwd);
  } else {
    state = { ...state, active_session_id: sid, active_cwd: null };
    await saveState(state);
  }
  const head = fmt`Connected to ${code}${shortSid(sid)}${code}.`;
  const tail = "\nEnd-of-turn messages will arrive here. Send text or photos to talk back.";
  const msg = cwd
    ? fmt`${head}\n${i}in ${i}${code}${cwd}${code}${tail}`
    : fmt`${head}${tail}`;
  try {
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  } catch {
    await ctx.reply(msg.text, { entities: msg.entities });
  }
});

bot.callbackQuery("disconnect", async (ctx) => {
  await ctx.answerCallbackQuery();
  state = { ...state, active_session_id: null, active_cwd: null };
  await saveState(state);
  try { await ctx.editMessageText("Disconnected."); } catch { /* ignore */ }
});

// Legacy alias: /switch still works (with-arg connects, bare arms the
// two-step "send the id next" flow). Behavior preserved for muscle memory;
// /resume is the new canonical name and gets surfaced via the slash menu.
bot.command("switch", async (ctx) => {
  clearAllPending();
  const arg = (ctx.match ?? "").trim();
  await ctx.reply("→ /resume does this now (and shows a picker bare). /switch still works during the transition.");
  if (!arg) {
    pendingSwitch = true;
    await ctx.reply("Send the session id (8-char short form or full UUID).");
    return;
  }
  await performSwitch(ctx, arg);
});

// Look up `arg` as a session-id prefix and act on the result. Replies with
// the appropriate connection notice, ambiguity list, or not-found message.
// Shared by the bot.command("switch") arg path and the pendingSwitch path
// in message:text.
async function performSwitch(ctx: Context, arg: string): Promise<void> {
  if (arg.length < 4) {
    await ctx.reply("Id must be at least 4 characters to avoid collisions.");
    return;
  }

  const matches = await findSessionsByPrefix(arg);
  if (matches.length === 0) {
    const m = fmt`No session found with id starting with ${code}${arg}${code}.`;
    await ctx.reply(m.text, { entities: m.entities });
    return;
  }
  if (matches.length > 1) {
    const lines: FormattedString[] = [
      fmt`${b}Ambiguous${b} — ${String(matches.length)} sessions match ${code}${arg}${code}:`,
    ];
    for (const m of matches.slice(0, 10)) {
      lines.push(fmt`\n• ${code}${m.sessionId}${code} · ${b}${m.project}${b} · ${age(m.mtime)}`);
    }
    if (matches.length > 10) lines.push(fmt`\n…and ${String(matches.length - 10)} more`);
    lines.push(fmt`\n\nRetry with a longer prefix or the full id.`);
    let body = lines[0];
    for (let k = 1; k < lines.length; k++) body = fmt`${body}${lines[k]}`;
    await ctx.reply(body.text, { entities: body.entities });
    return;
  }

  const target = matches[0];
  await setActiveSession(target.sessionId, target.cwd);
  pendingNewCwd = null; // any pending /new is voided by an explicit switch
  const m = fmt`Connected to ${code}${shortSid(target.sessionId)}${code} · ${b}${target.project}${b}\n${i}in ${i}${code}${target.cwd}${code}`;
  await ctx.reply(m.text, { entities: m.entities });
}

// Reply-as-rewind dispatcher. Replaces the older "reply switches sessions"
// shortcut with a richer state machine:
//
//   - No reply / no route entry / reply to a non-bot message → "proceed":
//     the gesture has no special meaning; caller enqueues normally.
//   - Reply to one of the bot's messages we don't track (aged out, breadcrumb,
//     untracked system message) → "refused": breadcrumb sent, caller drops.
//   - Legacy entry (no anchor captured) → "proceed" after a silent switch:
//     same as the old reply-as-switch behavior; preserved during transition.
//   - Same-context entry with anchor (active sid === entry.sid OR no active):
//     pre-validate the anchor in the JSONL; on success arm `pending_resume_at`
//     and post a breadcrumb. Caller enqueues the prepared text.
//   - Cross-session entry with anchor: post a confirmation prompt with two
//     buttons. Caller does NOT enqueue — the callback handler will, after
//     the user picks Switch only / Switch and rewind / Cancel.
//
// `jobText` is the fully-prepared prompt the caller would otherwise enqueue
// (the user's text for plain messages; the Read-tool prompt with attachment
// path baked in for photos/documents). The cross-session branch stashes it
// verbatim so the deferred enqueue lands the same payload after the switch.
type ReplyOutcome =
  | { kind: "proceed" }              // caller enqueues normally
  | { kind: "rewind-armed" }         // pending_resume_at set; caller enqueues
  | { kind: "cross-session-pending" } // confirmation prompt sent; caller drops
  | { kind: "refused" };              // breadcrumb sent; caller drops

// Slash-command / pendingArgs paths use the legacy "reply switches session"
// shortcut — rewinding to anchor a slash command isn't useful, and a
// cross-session confirmation prompt would be surprising for what reads as
// a single command tap. This silent variant is the pre-rewind behavior:
// if a reply hits a tracked entry, switch to that entry's session quietly
// and post the standard "Connected to ..." notice. No-op otherwise.
async function maybeSwitchOnReply(ctx: Context): Promise<void> {
  const replyTo = ctx.message?.reply_to_message?.message_id;
  if (!replyTo) return;
  const entry = lookupReplyRouteEntry(state, replyTo);
  if (!entry) return;
  if (entry.sid === state.active_session_id) return;
  const cwd = await findSessionCwd(entry.sid);
  if (!cwd) {
    console.warn(
      `telegram: reply-route hit but cwd missing on disk sid=${shortSid(entry.sid)} msg_id=${replyTo}`,
    );
    return;
  }
  await setActiveSession(entry.sid, cwd);
  pendingSwitch = false;
  pendingNewCwd = null;
  const project = path.basename(cwd) || cwd;
  const m = fmt`Connected to ${code}${shortSid(entry.sid)}${code} · ${b}${project}${b}\n${i}in ${i}${code}${cwd}${code}`;
  await ctx.reply(m.text, { entities: m.entities });
}

async function sendBreadcrumb(ctx: Context, body: string): Promise<void> {
  try {
    await ctx.reply(`↳ ${body}`);
  } catch (e) {
    console.warn(`telegram: breadcrumb send failed: ${(e as Error).message}`);
  }
}

function turnsTail(n: number): string {
  return `${n} turn${n === 1 ? "" : "s"} dropped`;
}

async function handleReplyGesture(ctx: Context, jobText: string): Promise<ReplyOutcome> {
  const replyTo = ctx.message?.reply_to_message?.message_id;
  if (!replyTo) return { kind: "proceed" };

  const entry = lookupReplyRouteEntry(state, replyTo);

  // Tells "did the user reply to one of our bot's messages" — used to decide
  // whether a missing route entry means "aged out / not-tracked" (refuse) or
  // "they're replying to something we never owned" (proceed). Single-tenant
  // chat, so any bot reply is ours.
  const replyFrom = ctx.message?.reply_to_message?.from;
  const repliedToBot = replyFrom?.is_bot === true;

  if (!entry) {
    if (repliedToBot) {
      await sendBreadcrumb(
        ctx,
        "Don't have a record of that message. Reply not sent. Send a normal message if you want it to land in the connected session.",
      );
      return { kind: "refused" };
    }
    return { kind: "proceed" };
  }

  // Legacy entry (pre-rewind support, or anchor capture failed): preserve
  // the old reply-as-switch behavior. Switch sessions silently if needed,
  // then let the caller enqueue normally.
  if (!entry.anchorUuid || !entry.kind) {
    if (entry.sid !== state.active_session_id) {
      const cwd = await findSessionCwd(entry.sid);
      if (!cwd) {
        console.warn(
          `telegram: legacy reply-route hit but cwd missing sid=${shortSid(entry.sid)}`,
        );
        return { kind: "proceed" };
      }
      await setActiveSession(entry.sid, cwd);
      pendingSwitch = false;
      pendingNewCwd = null;
      const project = path.basename(cwd) || cwd;
      const m = fmt`Connected to ${code}${shortSid(entry.sid)}${code} · ${b}${project}${b}\n${i}in ${i}${code}${cwd}${code}`;
      await ctx.reply(m.text, { entities: m.entities });
    }
    return { kind: "proceed" };
  }

  // Replying to one's own past message has no clear intent — edit-as-rewind
  // covers "replace what I said". Fall through to a normal enqueue. The
  // user-kind route entry stays on disk because the edit handler needs it.
  if (entry.kind === "user") {
    return { kind: "proceed" };
  }

  return dispatchAnchoredGesture(
    ctx,
    entry as ReplyRoute & { kind: "assistant" | "user"; anchorUuid: string },
    jobText,
    "reply",
  );
}

// Shared back-end for reply-as-rewind and edit-as-rewind. The caller has
// already verified the entry has a usable kind + anchorUuid; this routine
// owns the same/cross-session decision and the 0-turn skip.
async function dispatchAnchoredGesture(
  ctx: Context,
  entry: ReplyRoute & { kind: "assistant" | "user"; anchorUuid: string },
  jobText: string,
  gestureKind: "reply" | "edit",
): Promise<ReplyOutcome> {
  const isSameContext =
    state.active_session_id === null || state.active_session_id === entry.sid;

  if (isSameContext) {
    if (state.active_session_id === null) {
      const cwd = await findSessionCwd(entry.sid);
      if (!cwd) {
        await sendBreadcrumb(ctx, "Couldn't find that session on disk. Reply not sent.");
        return { kind: "refused" };
      }
      await setActiveSession(entry.sid, cwd);
    }

    const present = await findUuidInTranscript(entry.sid, entry.anchorUuid).catch(() => false);
    if (!present) {
      await sendBreadcrumb(
        ctx,
        "Couldn't rewind — that point is no longer in the conversation. Reply not sent.",
      );
      return { kind: "refused" };
    }

    state = setPendingResumeAt(state, entry.sid, entry.anchorUuid);
    await saveState(state);

    const turns = await countTurnsBetween(entry.sid, entry.anchorUuid).catch(() => 0);
    const verb = gestureKind === "edit"
      ? "Replaced your message"
      : "Rewound to your reply target";
    await sendBreadcrumb(ctx, `${verb}. ${turnsTail(turns)}.`);
    pendingSwitch = false;
    pendingNewCwd = null;
    return { kind: "rewind-armed" };
  }

  // Cross-session: a single tap would both switch and (potentially)
  // destructively rewind a session the user can't see right now.
  const cwd = await findSessionCwd(entry.sid);
  if (!cwd) {
    await sendBreadcrumb(ctx, "Couldn't find that session on disk. Reply not sent.");
    return { kind: "refused" };
  }
  const project = path.basename(cwd) || cwd;

  // Skip the confirmation prompt when nothing would be dropped — replying to
  // the latest bot message in another session, or editing a user message
  // whose post-anchor turns are already gone, has no destructive effect.
  // Behaves like a silent "Switch only" with a one-line breadcrumb.
  const turns = await countTurnsBetween(entry.sid, entry.anchorUuid).catch(() => 0);
  if (turns === 0) {
    await setActiveSession(entry.sid, cwd);
    pendingSwitch = false;
    pendingNewCwd = null;
    const body = gestureKind === "edit"
      ? `Switched to ${project} and replaced your message.`
      : `Switched to ${project}.`;
    await sendBreadcrumb(ctx, body);
    return { kind: "proceed" };
  }

  const token = makeReplyConfirmToken();
  const expiresAt = Date.now() + REPLY_CONFIRM_TTL_MS;
  const keyboard = new InlineKeyboard()
    .text("Switch only", `replyx:${token}:switch`)
    .text("Switch and rewind", `replyx:${token}:rewind`)
    .row()
    .text("✕ Cancel", `replyx:${token}:cancel`);

  const promptBody = gestureKind === "edit"
    ? `You're editing a message in ${project}.\nWhat do you want to do?`
    : `You're replying to a message in ${project}.\nWhat do you want to do?`;
  let promptMsgId: number;
  try {
    const sent = await ctx.reply(promptBody, { reply_markup: keyboard });
    promptMsgId = sent.message_id;
  } catch (e) {
    console.error(`telegram: cross-session prompt send failed: ${(e as Error).message}`);
    return { kind: "refused" };
  }

  // ctx.msg is the polymorphic accessor — message_id for reply, editedMessage
  // for edit (Telegram preserves the original id across edits).
  pendingReplyConfirmations.set(token, {
    token,
    targetSid: entry.sid,
    targetCwd: cwd,
    targetProject: project,
    anchorUuid: entry.anchorUuid,
    jobText,
    userMessageId: ctx.msg!.message_id,
    chatId: ctx.chat!.id,
    promptMsgId,
    expiresAt,
    gestureKind,
  });
  scheduleReplyConfirmExpiry(token);
  return { kind: "cross-session-pending" };
}

// Resolve the connected session + cwd, replying with a helpful error and
// returning null if not connected. Shared by text, photo, and document
// handlers as the fallback when no reply-route override is in play.
async function resolveTarget(ctx: Context): Promise<{ sid: string; cwd: string } | null> {
  let sid = state.active_session_id;
  let cwd = state.active_cwd;
  if (!sid) {
    await ctx.reply("Not connected to any session.\nUse /resume to pick one.");
    return null;
  }
  if (!cwd) {
    cwd = await findSessionCwd(sid);
    if (cwd) {
      state = { ...state, active_cwd: cwd };
      await saveState(state);
      console.log(`telegram: backfilled active_cwd sid=${shortSid(sid)} cwd=${cwd}`);
    } else {
      await ctx.reply(
        "Couldn't find this session's working directory on disk. " +
        "Try /resume and reconnect to refresh."
      );
      return null;
    }
  }
  return { sid, cwd };
}

// Free text → enqueue for the connected session, OR consume a pending
// /switch / /new / /commands-args follow-through, OR pass through an
// unrecognised slash command to the connected session (after blocklist
// check + display-form canonicalization).
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;

  // Any new inbound message supersedes a pending cross-session reply
  // confirmation — drop those before doing anything else, so the user's
  // newly-typed message takes effect cleanly. The gesture handler below
  // may create a fresh confirmation of its own.
  await cancelPendingReplyConfirmations(ctx.chat.id);

  // pendingArgs wins over the slash-command branch — hints like /loop's
  // "[interval] <prompt>" naturally start with a slash, so we can't gate on
  // text.startsWith("/"). /cancel is the explicit escape hatch.
  if (pendingArgs) {
    // pendingArgs and slash-command paths use the legacy "reply switches
    // session" shortcut; rewinding to anchor a slash command isn't useful.
    await maybeSwitchOnReply(ctx);
    const cmd = pendingArgs.canonical;
    pendingArgs = null;
    const target = await resolveTarget(ctx);
    if (!target) return;
    await ack(ctx);
    enqueueInbound({
      text: `/${cmd} ${text}`,
      chatId: ctx.chat.id,
      userMessageId: ctx.message.message_id,
      targetSessionId: target.sid,
      targetCwd: target.cwd,
    });
    return;
  }

  // Slash-command catch-all: parse, canonicalize the underscored display
  // form, reject blocklisted, arm pendingArgs if a hint exists for a bare
  // tap, otherwise forward to the connected session.
  if (text.startsWith("/")) {
    await maybeSwitchOnReply(ctx);
    const parsed = parseSlashCommand(text);
    if (!parsed) {
      await ctx.reply("That doesn't look like a valid slash command. /help shows what's available.");
      return;
    }
    const canonical = canonicalizeName(parsed.name) ?? parsed.name;
    if (isBlocked(canonical)) {
      await ctx.reply(blockedReply(canonical));
      return;
    }
    if (parsed.rest === "") {
      const hint = commandArgHint(canonical);
      if (hint) {
        pendingArgs = { canonical };
        pendingNewCwd = null;
        pendingSwitch = false;
        await ctx.reply(`What for /${canonical}?  ${hint}`);
        return;
      }
    }
    const target = await resolveTarget(ctx);
    if (!target) return;
    await ack(ctx);
    const forwardText = canonical !== parsed.name
      ? (parsed.rest ? `/${canonical} ${parsed.rest}` : `/${canonical}`)
      : text;
    enqueueInbound({
      text: forwardText,
      chatId: ctx.chat.id,
      userMessageId: ctx.message.message_id,
      targetSessionId: target.sid,
      targetCwd: target.cwd,
    });
    return;
  }

  // /switch follow-through: bare /switch armed pendingSwitch, this message
  // is the id. Consume and dispatch.
  if (pendingSwitch) {
    pendingSwitch = false;
    await performSwitch(ctx, text);
    return;
  }

  // /new follow-through: consume the pending cwd and route through the queue
  // as a new-session job (targetSessionId = null tells inbound to spawn fresh).
  if (pendingNewCwd) {
    const cwd = pendingNewCwd;
    pendingNewCwd = null;
    await ack(ctx);
    enqueueInbound({
      text,
      chatId: ctx.chat.id,
      userMessageId: ctx.message.message_id,
      targetSessionId: null,
      targetCwd: cwd,
    });
    return;
  }

  // Plain-text fallthrough — route through the reply-as-rewind dispatcher.
  // It may switch sessions, arm a rewind anchor, send a refuse breadcrumb,
  // or post a confirmation prompt for a cross-session reply. In the last
  // two cases the user's text is not enqueued here (deferred to the
  // confirmation callback, or refused outright).
  const outcome = await handleReplyGesture(ctx, text);
  if (outcome.kind === "refused" || outcome.kind === "cross-session-pending") return;

  const target = await resolveTarget(ctx);
  if (!target) return;

  await ack(ctx);
  enqueueInbound({
    text,
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Download a Telegram file by its API-relative path to a local file.
async function downloadTelegramFile(filePath: string, savePath: string): Promise<void> {
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(savePath, buf);
}

// Photos → save to disk, build a prompt that points Claude at the file path,
// enqueue same as text. Claude uses its Read tool to view the image.
//
// Why not pass the image natively as a multimodal user-message content block?
// The bundled Claude Code CLI's stream-json input parser intermittently
// rejects long single-line JSON inputs (~150–200 KB base64 fails, smaller
// AND larger work). Until that's fixed upstream, the file-path approach is
// reliable at any size.
bot.on("message:photo", async (ctx) => {
  // New attachment supersedes a pending cross-session confirmation.
  await cancelPendingReplyConfirmations(ctx.chat.id);
  // A non-text inbound aborts a half-armed args prompt — the photo isn't
  // plausibly the args the user was being asked for.
  pendingArgs = null;

  await ack(ctx);

  let localPath: string;
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const file = await ctx.getFile(); // grammY picks the largest PhotoSize
    if (!file.file_path) throw new Error("no file_path in Telegram response");
    const ext = path.extname(file.file_path) || ".jpg";
    localPath = path.join(
      UPLOAD_DIR,
      `${ctx.chat.id}-${ctx.message.message_id}${ext}`,
    );
    await downloadTelegramFile(file.file_path, localPath);
    console.log(`telegram: photo saved path=${localPath}`);
  } catch (e) {
    console.error(`telegram: photo download failed: ${(e as Error).message}`);
    await ctx.reply("⚠️ couldn't fetch that photo from Telegram.");
    return;
  }

  const caption = (ctx.message.caption ?? "").trim();
  const promptText = caption
    ? `The user attached an image at ${localPath}. Read it with the Read tool, then respond.\n\nCaption: ${caption}`
    : `The user attached an image at ${localPath}. Read it with the Read tool, then respond.`;

  // Reply-as-rewind: dispatch the gesture with the prepared prompt. May
  // switch sessions, arm a rewind, or defer enqueue to a button tap.
  const outcome = await handleReplyGesture(ctx, promptText);
  if (outcome.kind === "refused" || outcome.kind === "cross-session-pending") return;

  const target = await resolveTarget(ctx);
  if (!target) return;

  enqueueInbound({
    text: promptText,
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Documents (PDF, text, markdown, CSV, JSON, source files, etc.) → same shape
// as the photo path: download to /tmp, hand Claude a Read-tool prompt with
// the local path. Telegram's getFile() bot endpoint caps at ~20 MB, so we
// reject larger uploads up front rather than letting the download fail with
// a less informative error. The original filename is preserved in both the
// on-disk path and the prompt so the model has useful naming context.
bot.on("message:document", async (ctx) => {
  await cancelPendingReplyConfirmations(ctx.chat.id);
  // See photo handler: a non-text inbound aborts a half-armed args prompt.
  pendingArgs = null;

  const doc = ctx.message.document;
  if (typeof doc.file_size === "number" && doc.file_size > DOCUMENT_MAX_BYTES) {
    const mb = (doc.file_size / 1024 / 1024).toFixed(1);
    await ctx.reply(
      `⚠️ document is ${mb} MB, over the 20 MB Telegram bot limit. ` +
      "Try splitting it or sharing a smaller excerpt.",
    );
    return;
  }

  await ack(ctx);

  let localPath: string;
  let displayName: string;
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("no file_path in Telegram response");

    // Prefer the original Telegram filename for both the on-disk path and
    // the model-facing prompt — gives Claude a concrete name to reference.
    // Fall back to file_path's basename if the document was sent without a
    // filename (rare but possible). Sanitize to a conservative whitelist so
    // odd characters never affect the path we hand the SDK.
    const rawName = doc.file_name ?? path.basename(file.file_path);
    displayName = rawName;
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
    localPath = path.join(
      UPLOAD_DIR,
      `${ctx.chat.id}-${ctx.message.message_id}-${safeName}`,
    );
    await downloadTelegramFile(file.file_path, localPath);
    console.log(
      `telegram: document saved path=${localPath} ` +
      `mime=${doc.mime_type ?? "?"} bytes=${doc.file_size ?? "?"}`,
    );
  } catch (e) {
    console.error(`telegram: document download failed: ${(e as Error).message}`);
    await ctx.reply("⚠️ couldn't fetch that document from Telegram.");
    return;
  }

  const caption = (ctx.message.caption ?? "").trim();
  const head =
    `The user attached a document "${displayName}" at ${localPath}. ` +
    "Read it with the Read tool, then respond.";
  const promptText = caption ? `${head}\n\nCaption: ${caption}` : head;

  const outcome = await handleReplyGesture(ctx, promptText);
  if (outcome.kind === "refused" || outcome.kind === "cross-session-pending") return;

  const target = await resolveTarget(ctx);
  if (!target) return;

  enqueueInbound({
    text: promptText,
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Edit-as-rewind. Telegram fires a separate update on edits, preserving the
// original message_id — we use it to look up the route entry from the turn
// that originally produced the message. Untracked/legacy/unreachable shapes
// are ignored silently so stale edits don't get unsolicited breadcrumbs.
bot.on("edited_message:text", async (ctx) => {
  await cancelPendingReplyConfirmations(ctx.chat.id);
  pendingArgs = null;

  const editedMsgId = ctx.editedMessage.message_id;
  const editedText = ctx.editedMessage.text.trim();

  if (!editedText) {
    await sendBreadcrumb(
      ctx,
      "Edited to nothing — no rewind. Edit again with text to replace.",
    );
    return;
  }

  const entry = lookupReplyRouteEntry(state, editedMsgId);
  if (!entry) return; // Untracked edit (system message, /status reply, aged out).
  if (!entry.anchorUuid || !entry.kind) return; // Legacy entry — can't anchor.
  if (entry.kind === "assistant") {
    // Telegram doesn't allow editing other users' messages; this branch is
    // unreachable in practice. Defensive log + drop if it ever surfaces.
    console.warn(
      `telegram: edited_message hit an assistant-kind route msg_id=${editedMsgId}; ignoring`,
    );
    return;
  }

  const outcome = await dispatchAnchoredGesture(
    ctx,
    entry as ReplyRoute & { kind: "user"; anchorUuid: string },
    editedText,
    "edit",
  );
  if (outcome.kind === "refused" || outcome.kind === "cross-session-pending") return;

  const target = await resolveTarget(ctx);
  if (!target) return;

  await ack(ctx);
  enqueueInbound({
    text: editedText,
    chatId: ctx.chat.id,
    userMessageId: editedMsgId,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Read accessors for other modules.
export function getActiveSessionId(): string | null { return state.active_session_id; }
export function getActiveCwd(): string | null { return state.active_cwd; }

// Per-session model override lookup, read by inbound.ts on every query()
// to apply the user's /model pick. Reads from telegram.ts's in-memory state
// so the value is always fresh (state.ts persists, telegram.ts mutates).
export function getModelOverrideFor(sid: string): string | null {
  return getModelOverride(state, sid);
}

// Reply-as-rewind support — record a route entry for a user-typed Telegram
// message, keyed by its msg_id, so a later reply to that message means
// "rewind to right before this point and replace it." Called by inbound.ts
// once a turn completes successfully — at that point the SDK has written
// the user's JSONL entry, and `getLatestUserMessageAnchor` resolves its
// parentUuid (the resume anchor: history loads up to and including that
// uuid, so the new prompt lands in the dropped message's place).
//
// Best-effort: if the lookup fails (no transcript, no parseable user entry
// at the tail, etc.), no entry is written. Replying then falls into the
// "no entry" branch and refuses cleanly — no silent legacy switch.
export async function recordUserMessageRoute(sid: string, telegramMsgId: number): Promise<void> {
  const anchorUuid = await getLatestUserMessageAnchor(sid).catch(() => null);
  if (!anchorUuid) {
    console.warn(`telegram: user-route skipped sid=${shortSid(sid)} msg_id=${telegramMsgId} (no anchor)`);
    return;
  }
  state = appendReplyRoutes(state, [{ msg_id: telegramMsgId, sid, kind: "user", anchorUuid }]);
  try {
    await saveState(state);
  } catch (e) {
    console.warn(
      `telegram: user-route persist failed sid=${shortSid(sid)} msg_id=${telegramMsgId}: ${(e as Error).message}`,
    );
  }
}

// Single-shot rewind anchor lookup. Reads the pending resumeSessionAt for
// the session, clears it (in memory and on disk) so the next turn isn't
// affected, and returns the anchor uuid (or null if none was pending).
// Called by inbound.ts at the top of each query() — the clear-on-read
// guarantees the rewound history is loaded for exactly one turn.
export async function consumePendingResumeAtFor(sid: string): Promise<string | null> {
  const anchor = getPendingResumeAt(state, sid);
  if (!anchor) return null;
  state = clearPendingResumeAt(state, sid);
  await saveState(state);
  return anchor;
}

// Mutator used by the new-session path in inbound.ts. Sets and persists the
// active connection so the Stop hook's POST is recognised as the active sid.
// Also drops the /commands and /model caches: each is keyed per-cwd, so
// stale entries from the previous session would mistranslate slash taps
// or list the wrong models.
export async function setActiveSession(sid: string, cwd: string): Promise<void> {
  state = { ...state, active_session_id: sid, active_cwd: cwd };
  await saveState(state);
  clearCommandCache();
  clearModelCache();
  console.log(`telegram: active session set sid=${shortSid(sid)} cwd=${cwd}`);
}

// Format an agent's Markdown reply as Telegram-HTML and send it to the
// allowed chat. Handles chunking on safe block boundaries, prepends a small
// session-identifying header to the first chunk, and falls back to plain
// text if Telegram rejects the formatted send. Called from intake on every
// Stop-hook delivery.
//
// `anchorUuid`, when provided, is the assistant entry's JSONL uuid for the
// turn we're delivering. Each chunk's route entry stores it so a later
// reply-to-rewind can use it as `resumeSessionAt`. Multi-chunk turns share
// the SAME anchor (the final assistant entry) — replying to any chunk →
// same rewind result. Pass null for non-turn deliveries (e.g. forwarded
// /cost output) so those entries stay in legacy switch-only mode.
//
// Side effect: each sent chunk's Telegram message_id is recorded in the
// reply-route map. Persisted once per call (after all chunks land) to
// minimize state.json churn.
export async function sendAgentReply(
  sessionId: string,
  projectLabel: string,
  text: string,
  anchorUuid?: string | null,
): Promise<void> {
  const header = `<b>${escHtml(projectLabel || "?")}</b> · <code>${escHtml(shortSid(sessionId))}</code>`;
  const blocks = markdownToTelegramBlocks(text);
  // Defensive: if marked produced no blocks (highly unusual), fall back to
  // the raw text escaped, so we still send something.
  const contentBlocks = blocks.length > 0 ? blocks : [escHtml(text)];
  const chunks = packBlocks([header, ...contentBlocks], TELEGRAM_SAFE_CAP);

  const sentIds: number[] = [];
  for (const chunk of chunks) {
    try {
      const sent = await bot.api.sendMessage(config.allowedChatId, chunk, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sentIds.push(sent.message_id);
    } catch (e) {
      // Telegram rejected the formatted send (unsupported tag, malformed
      // entity). Retry with tags stripped so the content still reaches
      // the user.
      console.warn(
        `telegram: HTML send rejected sid=${shortSid(sessionId)}: ${(e as Error).message}; retrying plain`,
      );
      const sent = await bot.api.sendMessage(
        config.allowedChatId,
        stripTelegramHtml(chunk),
        { link_preview_options: { is_disabled: true } },
      );
      sentIds.push(sent.message_id);
    }
  }

  if (sentIds.length > 0) {
    const routes: ReplyRoute[] = sentIds.map((msg_id) =>
      anchorUuid
        ? { msg_id, sid: sessionId, kind: "assistant" as const, anchorUuid }
        : { msg_id, sid: sessionId },
    );
    state = appendReplyRoutes(state, routes);
    try {
      await saveState(state);
    } catch (e) {
      // A persistence failure here just means future replies-to-this-turn
      // fall back to the active session — annoying but not fatal. Log and
      // move on rather than masking the successful Telegram delivery.
      console.warn(
        `telegram: reply-route persist failed sid=${shortSid(sessionId)}: ${(e as Error).message}`,
      );
    }
  }
}

// Replace the bot's command menu (the slash-command list shown in Telegram clients).
// setMyCommands fully replaces whatever was previously registered for this bot, so
// any legacy commands left over from prior incarnations get cleared.
export async function registerCommandMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "resume",     description: "Pick a recent session, or jump by id" },
    { command: "new",        description: "Start a fresh session in $HOME" },
    { command: "model",      description: "Pick a model for the connected session" },
    { command: "rewind",     description: "Pull the session back to a recent message" },
    { command: "status",     description: "Show current connection" },
    { command: "compact",    description: "Compact the connected session" },
    { command: "cancel",     description: "Stop the in-flight turn and drain the queue" },
    { command: "tasks",      description: "Show the connected session's TodoWrite list" },
    { command: "commands",   description: "List every slash command this session can run" },
    { command: "disconnect", description: "Stop following the current session" },
    { command: "help",       description: "Show available commands" },
  ]);
  console.log("telegram: command menu registered");
}

// Post a one-line "bridge online" notice to the allowed chat on every startup.
// Sent as a plain Telegram message (not piped into the connected session), so
// daemon-restart events stay out of the conversation transcript.
export async function sendStartupNotice(): Promise<void> {
  const sid = state.active_session_id;
  const head = sid
    ? fmt`🔄 ${b}bridge online${b} — connected to ${code}${shortSid(sid)}${code}`
    : fmt`🔄 ${b}bridge online${b} — no session connected`;
  await bot.api.sendMessage(config.allowedChatId, head.text, { entities: head.entities });
}
