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
import { listRecentSessions, findSessionCwd, findSessionsByPrefix, getSessionStats } from "./sessions.js";
import { age, shortSid, truncate, formatTokens } from "./format.js";
import { loadState, saveState, appendReplyRoutes, lookupReplyRoute } from "./state.js";
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
import {
  markdownToTelegramBlocks,
  packBlocks,
  stripTelegramHtml,
  escHtml,
  TELEGRAM_SAFE_CAP,
} from "./telegramHtml.js";

const SESSION_LIST_LIMIT = 10;
const UPLOAD_DIR = "/tmp/claudesworth-uploads";

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

function clearAllPending(): void {
  pendingNewCwd = null;
  pendingSwitch = false;
  pendingArgs = null;
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Claudesworth online.\n\n" +
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

  let msg = head;
  if (stats) {
    if (stats.model) msg = fmt`${msg}\n${b}model${b}: ${code}${stats.model}${code}`;
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

// Reply-to-switch: if the inbound message is a reply to one of the bot's
// previous agent-reply chunks, treat that as an implicit /switch — connect
// to the session that produced the chunk and acknowledge with the same
// notice the explicit /switch command sends. Idempotent if we're already
// on that session, and a no-op if there's no reply / no matching route.
//
// After this returns, normal active-session resolution will pick up the
// (possibly newly-set) active session and the rest of the handler runs
// against it. Inbound dispatch and outbound delivery both stay consistent
// because everything keys off `active_session_id`.
async function maybeSwitchOnReply(ctx: Context): Promise<void> {
  const replyTo = ctx.message?.reply_to_message?.message_id;
  if (!replyTo) return;
  const sid = lookupReplyRoute(state, replyTo);
  if (!sid) return;
  if (sid === state.active_session_id) return; // already on it
  const cwd = await findSessionCwd(sid);
  if (!cwd) {
    console.warn(
      `telegram: reply-route hit but cwd missing on disk sid=${shortSid(sid)} msg_id=${replyTo}`,
    );
    return;
  }
  console.log(
    `telegram: reply-driven switch sid=${shortSid(sid)} msg_id=${replyTo}`,
  );
  await setActiveSession(sid, cwd);
  // An explicit reply-driven switch supersedes any half-armed /switch or /new.
  pendingSwitch = false;
  pendingNewCwd = null;
  const project = path.basename(cwd) || cwd;
  const m = fmt`Connected to ${code}${shortSid(sid)}${code} · ${b}${project}${b}\n${i}in ${i}${code}${cwd}${code}`;
  await ctx.reply(m.text, { entities: m.entities });
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

  // Reply-driven switch first: a reply to a tracked agent-reply chunk is
  // treated as an implicit /switch and supersedes any half-armed /switch
  // or /new. Sets active_session_id + posts the same "Connected to ..."
  // notice the /switch command does. Runs for both text and slash-command
  // dispatches because the user may want to re-target a slash command at
  // an older session by replying to one of its messages.
  await maybeSwitchOnReply(ctx);

  // pendingArgs wins over the slash-command branch — hints like /loop's
  // "[interval] <prompt>" naturally start with a slash, so we can't gate on
  // text.startsWith("/"). /cancel is the explicit escape hatch.
  if (pendingArgs) {
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
  await maybeSwitchOnReply(ctx);
  // A non-text inbound aborts a half-armed args prompt — the photo isn't
  // plausibly the args the user was being asked for.
  pendingArgs = null;
  const target = await resolveTarget(ctx);
  if (!target) return;

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
    console.log(`telegram: photo saved sid=${shortSid(target.sid)} path=${localPath}`);
  } catch (e) {
    console.error(`telegram: photo download failed: ${(e as Error).message}`);
    await ctx.reply("⚠️ couldn't fetch that photo from Telegram.");
    return;
  }

  const caption = (ctx.message.caption ?? "").trim();
  const promptText = caption
    ? `The user attached an image at ${localPath}. Read it with the Read tool, then respond.\n\nCaption: ${caption}`
    : `The user attached an image at ${localPath}. Read it with the Read tool, then respond.`;

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
  await maybeSwitchOnReply(ctx);
  // See photo handler: a non-text inbound aborts a half-armed args prompt.
  pendingArgs = null;
  const target = await resolveTarget(ctx);
  if (!target) return;

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
      `telegram: document saved sid=${shortSid(target.sid)} path=${localPath} ` +
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

  enqueueInbound({
    text: promptText,
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Read accessors for other modules.
export function getActiveSessionId(): string | null { return state.active_session_id; }
export function getActiveCwd(): string | null { return state.active_cwd; }

// Mutator used by the new-session path in inbound.ts. Sets and persists the
// active connection so the Stop hook's POST is recognised as the active sid.
// Also drops the /commands cache: its display→canonical map is per-cwd, so
// stale entries from the previous session would mistranslate slash taps.
export async function setActiveSession(sid: string, cwd: string): Promise<void> {
  state = { ...state, active_session_id: sid, active_cwd: cwd };
  await saveState(state);
  clearCommandCache();
  console.log(`telegram: active session set sid=${shortSid(sid)} cwd=${cwd}`);
}

// Format an agent's Markdown reply as Telegram-HTML and send it to the
// allowed chat. Handles chunking on safe block boundaries, prepends a small
// session-identifying header to the first chunk, and falls back to plain
// text if Telegram rejects the formatted send. Called from intake on every
// Stop-hook delivery.
//
// Side effect: each sent chunk's Telegram message_id is recorded in the
// reply-route map so a later "reply to" of any chunk routes the next turn
// back to this session. Persisted once per call (after all chunks land) to
// minimize state.json churn.
export async function sendAgentReply(
  sessionId: string,
  projectLabel: string,
  text: string,
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
    state = appendReplyRoutes(state, sentIds, sessionId);
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
