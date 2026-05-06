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
import { loadState, saveState } from "./state.js";
import { enqueueInbound, cancelActive } from "./inbound.js";
import { renderTaskBoard } from "./tasksView.js";
import {
  markdownToTelegramBlocks,
  packBlocks,
  stripTelegramHtml,
  escHtml,
  TELEGRAM_SAFE_CAP,
} from "./telegramHtml.js";

const SESSION_LIST_LIMIT = 10;
const UPLOAD_DIR = "/tmp/claudesworth-uploads";

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
  "/sessions – list recent sessions, tap to connect\n" +
  "/switch <id> – connect to any session by short or full id\n" +
  "/new – start a fresh session (in $HOME)\n" +
  "/status – current connection\n" +
  "/compact – compact the connected session\n" +
  "/cancel – stop the in-flight turn and drain the queue\n" +
  "/tasks – read-only view of the task board\n" +
  "/disconnect – stop following\n" +
  "/help – this message\n\n" +
  "Plain text → piped into the connected session as a user message.\n" +
  "Photos → downloaded and shown to the session via its Read tool.\n" +
  "Back-to-back messages queue rather than overlap.";

// Pending /new flow: when the user picks a folder via the /new keyboard, we
// stash the cwd here. The next free-text message starts a fresh session in
// that folder (instead of being routed to the connected session) and clears
// the slot. In-memory only — a bridge restart drops the pending state, which
// is fine: the user just reissues /new.
let pendingNewCwd: string | null = null;

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Claudesworth online.\n\n" +
    "/sessions to pick a session to follow. Once connected, every end-of-turn " +
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
    await ctx.reply("Not connected to any session.\nUse /sessions to pick one.");
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

// Stop the in-flight turn (if any) and drop everything still queued. The
// queue is single-flight, so this is enough to interrupt Claude. Reports
// what was cancelled.
bot.command("cancel", async (ctx) => {
  const { cancelledInFlight, queueDrained } = cancelActive();
  if (!cancelledInFlight && queueDrained === 0) {
    await ctx.reply("Nothing in flight to cancel.");
    return;
  }
  const parts: string[] = [];
  if (cancelledInFlight) parts.push("cancelled in-flight turn");
  if (queueDrained > 0) parts.push(`dropped ${queueDrained} queued`);
  await ctx.reply(`🛑 ${parts.join(", ")}.`);
});

// /new — your next plain-text message starts a fresh session in $HOME.
// We always use the home directory as cwd (matching the agent-ui default)
// rather than asking which folder; ad-hoc sessions don't usually need a
// project-specific cwd, and removing the picker is one fewer tap.
bot.command("new", async (ctx) => {
  const cwd = homedir();
  pendingNewCwd = cwd;
  const m = fmt`Send your first message — it'll start a fresh session in ${code}${cwd}${code}.`;
  await ctx.reply(m.text, { entities: m.entities });
});

// /tasks — read-only view of /home/clawd/tasks.json. Compact summary tuned
// for phone reading: shows everything in active/plan/blocked/review, plus a
// short top-of-todo preview and a count for the rest.
bot.command("tasks", async (ctx) => {
  try {
    const text = await renderTaskBoard();
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (e) {
    console.error(`telegram: /tasks failed: ${(e as Error).message}`);
    await ctx.reply(`⚠️ couldn't read task board: ${(e as Error).message}`);
  }
});

bot.command("disconnect", async (ctx) => {
  const prev = state.active_session_id;
  state = { active_session_id: null, active_cwd: null };
  await saveState(state);
  if (prev) {
    const m = fmt`Disconnected from ${code}${shortSid(prev)}${code}.`;
    await ctx.reply(m.text, { entities: m.entities });
  } else {
    await ctx.reply("Already disconnected.");
  }
});

bot.command("sessions", async (ctx) => {
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
});

bot.callbackQuery(/^connect:(.+)$/, async (ctx) => {
  const sid = ctx.match[1];
  await ctx.answerCallbackQuery();
  const cwd = await findSessionCwd(sid);
  state = { active_session_id: sid, active_cwd: cwd };
  await saveState(state);
  const head = fmt`Connected to ${code}${shortSid(sid)}${code}.`;
  const tail = "\nEnd-of-turn messages will arrive here. Send text or photos to talk back.";
  const msg = cwd
    ? fmt`${head}\n${i}in ${i}${code}${cwd}${code}${tail}`
    : fmt`${head}${tail}`;
  try {
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  } catch {
    // message too old to edit, etc — fall back
    await ctx.reply(msg.text, { entities: msg.entities });
  }
});

bot.callbackQuery("disconnect", async (ctx) => {
  await ctx.answerCallbackQuery();
  state = { active_session_id: null, active_cwd: null };
  await saveState(state);
  try { await ctx.editMessageText("Disconnected."); } catch { /* ignore */ }
});

// /switch <id> — connect to any session by id (full UUID or short prefix,
// 4+ chars). Walks every project dir on disk so you can resume sessions
// older than the /sessions top-N. Disambiguates if a prefix matches more
// than one session. The short id shown in every reply header is what the
// user will most often paste back here.
bot.command("switch", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    await ctx.reply("Usage: /switch <id>\nThe id can be the 8-char short form (shown in reply headers) or the full UUID.");
    return;
  }
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
});

// Resolve the connected session + cwd, replying with a helpful error and
// returning null if not connected. Shared by text and photo handlers.
async function resolveTarget(ctx: Context): Promise<{ sid: string; cwd: string } | null> {
  let sid = state.active_session_id;
  let cwd = state.active_cwd;
  if (!sid) {
    await ctx.reply("Not connected to any session.\nUse /sessions to pick one.");
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
        "Try /sessions and reconnect to refresh."
      );
      return null;
    }
  }
  return { sid, cwd };
}

// Free text → enqueue for the connected session, OR start a new session if
// the user just picked a folder via /new.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.startsWith("/")) return; // commands handled above

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

// Read accessors for other modules.
export function getActiveSessionId(): string | null { return state.active_session_id; }
export function getActiveCwd(): string | null { return state.active_cwd; }

// Mutator used by the new-session path in inbound.ts. Sets and persists the
// active connection so the Stop hook's POST is recognised as the active sid.
export async function setActiveSession(sid: string, cwd: string): Promise<void> {
  state = { active_session_id: sid, active_cwd: cwd };
  await saveState(state);
  console.log(`telegram: active session set sid=${shortSid(sid)} cwd=${cwd}`);
}

// Format an agent's Markdown reply as Telegram-HTML and send it to the
// allowed chat. Handles chunking on safe block boundaries, prepends a small
// session-identifying header to the first chunk, and falls back to plain
// text if Telegram rejects the formatted send. Called from intake on every
// Stop-hook delivery.
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

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(config.allowedChatId, chunk, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      // Telegram rejected the formatted send (unsupported tag, malformed
      // entity). Retry with tags stripped so the content still reaches
      // the user.
      console.warn(
        `telegram: HTML send rejected sid=${shortSid(sessionId)}: ${(e as Error).message}; retrying plain`,
      );
      await bot.api.sendMessage(config.allowedChatId, stripTelegramHtml(chunk), {
        link_preview_options: { is_disabled: true },
      });
    }
  }
}

// Replace the bot's command menu (the slash-command list shown in Telegram clients).
// setMyCommands fully replaces whatever was previously registered for this bot, so
// any legacy commands left over from prior incarnations get cleared.
export async function registerCommandMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "sessions",   description: "List recent sessions, tap to connect" },
    { command: "switch",     description: "Connect to any session by id" },
    { command: "new",        description: "Start a fresh session in $HOME" },
    { command: "status",     description: "Show current connection" },
    { command: "compact",    description: "Compact the connected session" },
    { command: "cancel",     description: "Stop the in-flight turn and drain the queue" },
    { command: "tasks",      description: "Read-only view of the task board" },
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
