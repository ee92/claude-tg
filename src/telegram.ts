// grammY bot wiring. All handlers gated on the configured chat id.
// MarkdownV2 escapes are handled by the parse-mode plugin's `fmt` template tag,
// so dynamic strings (project names, summaries) cannot break the parser.

import { Bot, Context, InlineKeyboard } from "grammy";
import { fmt, b, i, code, FormattedString } from "@grammyjs/parse-mode";
import path from "node:path";
import { config } from "./config.js";
import { listRecentSessions, findSessionCwd } from "./sessions.js";
import { age, shortSid, truncate } from "./format.js";
import { loadState, saveState } from "./state.js";
import { enqueueInbound, type ImageMediaType } from "./inbound.js";

const SESSION_LIST_LIMIT = 10;

let state = await loadState();

export const bot = new Bot(config.telegramBotToken);

// Auth gate — silently drop everything from any other chat.
bot.use(async (ctx, next) => {
  if (ctx.chat?.id === config.allowedChatId) {
    await next();
  } else if (ctx.chat) {
    console.warn(`unauthorized access attempt chat_id=${ctx.chat.id}`);
  }
});

// Best-effort 👀 ack on inbound user messages.
async function ack(ctx: Context): Promise<void> {
  try { await ctx.react("👀"); } catch { /* old client / unsupported */ }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Claudesworth online.\n\n" +
    "/sessions to pick a session to follow. Once connected:\n" +
    "  • every end-of-turn message from that session lands here\n" +
    "  • anything you type back (no slash) gets piped into the session\n\n" +
    "/status – show current connection\n" +
    "/disconnect – stop following"
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Commands:\n" +
    "/sessions – list recent sessions, tap to connect\n" +
    "/status – current connection\n" +
    "/disconnect – stop following\n" +
    "/help – this message\n\n" +
    "Plain text (no slash) → piped into the connected session.\n" +
    "Back-to-back messages queue rather than overlap."
  );
});

bot.command("status", async (ctx) => {
  const sid = state.active_session_id;
  const cwd = state.active_cwd;
  if (!sid) {
    await ctx.reply("Not connected to any session.\nUse /sessions to pick one.");
    return;
  }
  const msg = cwd
    ? fmt`Connected to session ${code}${shortSid(sid)}${code}\n${i}in ${i}${code}${cwd}${code}\n(full id: ${code}${sid}${code})`
    : fmt`Connected to session ${code}${shortSid(sid)}${code}\n(full id: ${code}${sid}${code})`;
  await ctx.reply(msg.text, { entities: msg.entities });
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
  const tail = "\nEnd-of-turn messages will arrive here. Type freely to send messages back.";
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
      console.log(`backfilled active_cwd for sid=${shortSid(sid)}: ${cwd}`);
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

// Free text → enqueue for the connected session.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.startsWith("/")) return; // commands handled above

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

// Download a Telegram file by its API-relative path into memory as a Buffer.
async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

function mediaTypeFromExt(filePath: string): ImageMediaType {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":  return "image/png";
    case ".gif":  return "image/gif";
    case ".webp": return "image/webp";
    default:      return "image/jpeg";
  }
}

// Photos → fetch bytes, enqueue with native multimodal payload. Claude
// receives the image as a content block on the user message — no Read tool,
// no file path injection.
bot.on("message:photo", async (ctx) => {
  const target = await resolveTarget(ctx);
  if (!target) return;

  await ack(ctx);

  let bytes: Buffer;
  let mediaType: ImageMediaType;
  try {
    const file = await ctx.getFile(); // grammY picks the largest PhotoSize
    if (!file.file_path) throw new Error("no file_path in Telegram response");
    mediaType = mediaTypeFromExt(file.file_path);
    bytes = await downloadTelegramFile(file.file_path);
    console.log(
      `photo fetched sid=${shortSid(target.sid)} ${mediaType} bytes=${bytes.length}`,
    );
  } catch (e) {
    console.error(`photo download failed: ${(e as Error).message}`);
    await ctx.reply("⚠️ couldn't fetch that photo from Telegram.");
    return;
  }

  const caption = (ctx.message.caption ?? "").trim();

  enqueueInbound({
    photo: { mediaType, bytes, caption: caption || undefined },
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    targetSessionId: target.sid,
    targetCwd: target.cwd,
  });
});

// Read accessors for other modules.
export function getActiveSessionId(): string | null { return state.active_session_id; }
export function getActiveCwd(): string | null { return state.active_cwd; }
