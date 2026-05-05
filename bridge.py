"""
Claudesworth — Telegram bridge for Claude Code.

A single always-on daemon that:
  - holds a Telegram bot connection (single owner: ALLOWED_CHAT_ID)
  - tracks one "connected" Claude session at a time (active_session_id)
  - receives end-of-turn POSTs from a Claude Stop hook on a localhost intake port
  - forwards the assistant's final text to Telegram only when it matches the
    currently connected session

Telegram commands (single user, locked by chat_id):
  /start        - hello
  /status       - show current connection
  /sessions     - list 10 latest Claude sessions, with inline Connect buttons
  /disconnect   - clear active session
  /help         - command list

Switching sessions is just a pointer flip in state.json — no per-session
poller, no leftover connections, nothing to clean up.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
STATE_PATH = HERE / "state.json"
LOG_PATH = HERE / "claudesworth.log"

CLAUDE_PROJECTS_DIR = Path(os.path.expanduser("~/.claude/projects"))
SESSION_LIST_LIMIT = 10
INTAKE_HOST = "127.0.0.1"

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
ALLOWED_CHAT_ID_RAW = os.environ.get("ALLOWED_CHAT_ID", "").strip()
INTAKE_PORT = int(os.environ.get("INTAKE_PORT", "8765"))

if not TELEGRAM_BOT_TOKEN:
    sys.exit("FATAL: TELEGRAM_BOT_TOKEN not set")
if not ALLOWED_CHAT_ID_RAW:
    sys.exit("FATAL: ALLOWED_CHAT_ID not set")
try:
    ALLOWED_CHAT_ID = int(ALLOWED_CHAT_ID_RAW)
except ValueError:
    sys.exit(f"FATAL: ALLOWED_CHAT_ID is not an int: {ALLOWED_CHAT_ID_RAW!r}")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_PATH),
    ],
)
log = logging.getLogger("claudesworth")
# python-telegram-bot is chatty at INFO
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)

# ---------------------------------------------------------------------------
# State (persisted across restarts)
# ---------------------------------------------------------------------------


@dataclass
class State:
    active_session_id: Optional[str] = None

    @classmethod
    def load(cls) -> "State":
        if not STATE_PATH.exists():
            return cls()
        try:
            data = json.loads(STATE_PATH.read_text())
            return cls(active_session_id=data.get("active_session_id") or None)
        except Exception as e:
            log.warning(f"could not parse state.json ({e}); starting fresh")
            return cls()

    def save(self) -> None:
        tmp = STATE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"active_session_id": self.active_session_id}, indent=2))
        tmp.replace(STATE_PATH)


state = State.load()
state_lock = threading.Lock()  # guards state.json writes from any thread

# ---------------------------------------------------------------------------
# Session discovery
# ---------------------------------------------------------------------------


@dataclass
class SessionSummary:
    session_id: str
    project: str          # human-readable cwd, e.g. "claudesworth"
    cwd: str              # full cwd path
    mtime: float          # epoch seconds
    last_user_text: str   # short preview
    transcript_path: Path


def _decode_project_dir(name: str) -> str:
    # ~/.claude/projects/-home-clawd-projects-claudesworth → /home/clawd/projects/claudesworth
    if name.startswith("-"):
        return "/" + name[1:].replace("-", "/")
    return name


def _shortname(cwd: str) -> str:
    # /home/clawd/projects/foo → "foo"; /home/clawd → "~"
    p = Path(cwd)
    if str(p) == os.path.expanduser("~"):
        return "~"
    return p.name or str(p)


def _read_last_user_text(transcript: Path, max_lines: int = 2000) -> str:
    """Walk JSONL lines, find the most recent user-typed message."""
    try:
        # cheap: read whole file but cap at last N lines
        lines = transcript.read_text(errors="replace").splitlines()
    except Exception:
        return ""
    for line in reversed(lines[-max_lines:]):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "user":
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        text = None
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text")
                    break
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    # not a user-typed message; skip this record entirely
                    text = None
                    break
        if text:
            return text.strip()
    return ""


def list_recent_sessions(limit: int = SESSION_LIST_LIMIT) -> list[SessionSummary]:
    """Walk ~/.claude/projects/*/<uuid>.jsonl, return most-recent N."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return []
    candidates: list[tuple[float, Path, str]] = []
    for proj_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for f in proj_dir.iterdir():
            if not f.is_file() or f.suffix != ".jsonl":
                continue
            try:
                mtime = f.stat().st_mtime
            except OSError:
                continue
            candidates.append((mtime, f, proj_dir.name))
    candidates.sort(key=lambda x: x[0], reverse=True)

    out: list[SessionSummary] = []
    for mtime, f, proj_dir_name in candidates[: limit * 2]:  # over-fetch in case of empties
        sid = f.stem
        cwd = _decode_project_dir(proj_dir_name)
        last_text = _read_last_user_text(f)
        out.append(
            SessionSummary(
                session_id=sid,
                project=_shortname(cwd),
                cwd=cwd,
                mtime=mtime,
                last_user_text=last_text,
                transcript_path=f,
            )
        )
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _fmt_age(epoch: float) -> str:
    delta = datetime.now(timezone.utc).timestamp() - epoch
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    return f"{int(delta // 86400)}d ago"


def _truncate(s: str, n: int) -> str:
    s = " ".join(s.split())  # collapse whitespace
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _short_sid(sid: str) -> str:
    return sid.split("-", 1)[0] if "-" in sid else sid[:8]


# ---------------------------------------------------------------------------
# Telegram auth
# ---------------------------------------------------------------------------


def _is_authorized(update: Update) -> bool:
    chat = update.effective_chat
    if not chat:
        return False
    return chat.id == ALLOWED_CHAT_ID


async def _gate(update: Update) -> bool:
    if _is_authorized(update):
        return True
    log.warning(
        f"unauthorized access attempt chat_id={update.effective_chat.id if update.effective_chat else '?'}"
    )
    return False


# ---------------------------------------------------------------------------
# Telegram command handlers
# ---------------------------------------------------------------------------


async def cmd_start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _gate(update):
        return
    await update.message.reply_text(
        "👋 Claudesworth online.\n\n"
        "Use /sessions to pick a session to follow. Once connected, "
        "every end-of-turn message from that session lands here.\n\n"
        "/sessions – list 10 latest\n"
        "/status – show current connection\n"
        "/disconnect – stop following"
    )


async def cmd_status(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _gate(update):
        return
    sid = state.active_session_id
    if not sid:
        await update.message.reply_text("Not connected to any session.\nUse /sessions to pick one.")
        return
    await update.message.reply_text(
        f"Connected to session `{_short_sid(sid)}`\n(full id: `{sid}`)",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_disconnect(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _gate(update):
        return
    with state_lock:
        prev = state.active_session_id
        state.active_session_id = None
        state.save()
    if prev:
        await update.message.reply_text(f"Disconnected from `{_short_sid(prev)}`.", parse_mode=ParseMode.MARKDOWN)
    else:
        await update.message.reply_text("Already disconnected.")


async def cmd_help(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _gate(update):
        return
    await update.message.reply_text(
        "Commands:\n"
        "/sessions – list 10 latest sessions, tap to connect\n"
        "/status – current connection\n"
        "/disconnect – stop following\n"
        "/help – this message"
    )


async def cmd_sessions(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _gate(update):
        return
    sessions = list_recent_sessions(SESSION_LIST_LIMIT)
    if not sessions:
        await update.message.reply_text("No sessions found yet.")
        return

    active = state.active_session_id
    lines: list[str] = ["*Recent sessions* (tap to connect)\n"]
    keyboard: list[list[InlineKeyboardButton]] = []
    for i, s in enumerate(sessions, start=1):
        marker = "🟢 " if s.session_id == active else ""
        preview = _truncate(s.last_user_text or "(no user message yet)", 60)
        lines.append(f"{marker}{i}. *{s.project}* · {_fmt_age(s.mtime)}\n   _{preview}_")
        # button label: short id + project; payload: connect:<sid>
        label = f"{i}. {s.project} · {_short_sid(s.session_id)}"
        keyboard.append([InlineKeyboardButton(label, callback_data=f"connect:{s.session_id}")])
    keyboard.append([InlineKeyboardButton("✕ Disconnect", callback_data="disconnect")])

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def on_callback(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        return
    query = update.callback_query
    if not query or not query.data:
        return
    await query.answer()
    data = query.data
    if data == "disconnect":
        with state_lock:
            state.active_session_id = None
            state.save()
        await query.edit_message_text("Disconnected.")
        return
    if data.startswith("connect:"):
        sid = data.split(":", 1)[1]
        with state_lock:
            state.active_session_id = sid
            state.save()
        await query.edit_message_text(
            f"Connected to `{_short_sid(sid)}`.\nEnd-of-turn messages will arrive here.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return


# ---------------------------------------------------------------------------
# HTTP intake (Stop hook posts here)
# ---------------------------------------------------------------------------


def _make_handler(application: Application, loop: asyncio.AbstractEventLoop):
    """Build a request handler bound to the running asyncio loop + bot."""

    class IntakeHandler(BaseHTTPRequestHandler):
        # silence default logging
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
            log.debug("intake " + fmt, *args)

        def _send(self, code: int, body: bytes = b"") -> None:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send(200, b'{"ok":true}')
                return
            self._send(404)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/stop":
                self._send(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            try:
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                log.warning(f"intake: bad json: {e}")
                self._send(400, b'{"ok":false,"error":"bad json"}')
                return

            session_id = (payload.get("session_id") or "").strip()
            text = (payload.get("text") or "").strip()
            project = (payload.get("project") or "").strip()
            if not session_id:
                self._send(400, b'{"ok":false,"error":"missing session_id"}')
                return

            active = state.active_session_id
            if not active or active != session_id:
                # not the connected session — drop silently
                log.info(f"intake: drop sid={_short_sid(session_id)} (active={_short_sid(active) if active else '-'})")
                self._send(202, b'{"ok":true,"forwarded":false}')
                return

            if not text:
                # nothing to forward; ack
                self._send(202, b'{"ok":true,"forwarded":false,"reason":"empty text"}')
                return

            # Forward to Telegram on the bot's event loop
            future = asyncio.run_coroutine_threadsafe(
                _forward_to_telegram(application, session_id, project, text),
                loop,
            )
            try:
                future.result(timeout=10)
                self._send(202, b'{"ok":true,"forwarded":true}')
            except Exception as e:
                log.error(f"forward failed: {e}")
                self._send(500, b'{"ok":false,"error":"forward failed"}')

    return IntakeHandler


async def _forward_to_telegram(
    application: Application, session_id: str, project: str, text: str
) -> None:
    header = f"*{project or '?'}* · `{_short_sid(session_id)}`"
    # Telegram message hard cap is ~4096 chars; keep some headroom for the header.
    BODY_CAP = 3500
    body = text if len(text) <= BODY_CAP else text[:BODY_CAP].rstrip() + "\n…(truncated)"
    msg = f"{header}\n\n{body}"
    try:
        await application.bot.send_message(
            chat_id=ALLOWED_CHAT_ID,
            text=msg,
            parse_mode=ParseMode.MARKDOWN,
            disable_web_page_preview=True,
        )
    except Exception:
        # Markdown can break on stray underscores / asterisks. Retry plain.
        await application.bot.send_message(
            chat_id=ALLOWED_CHAT_ID,
            text=f"[{project or '?'} · {_short_sid(session_id)}]\n\n{body}",
            disable_web_page_preview=True,
        )


def _start_intake_server(application: Application, loop: asyncio.AbstractEventLoop) -> ThreadingHTTPServer:
    handler_cls = _make_handler(application, loop)
    httpd = ThreadingHTTPServer((INTAKE_HOST, INTAKE_PORT), handler_cls)
    t = threading.Thread(target=httpd.serve_forever, name="intake-http", daemon=True)
    t.start()
    log.info(f"intake listening on http://{INTAKE_HOST}:{INTAKE_PORT}")
    return httpd


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def _post_init(application: Application) -> None:
    # Once the bot loop is up, start the intake HTTP server bound to this loop.
    loop = asyncio.get_running_loop()
    application.bot_data["intake_httpd"] = _start_intake_server(application, loop)
    log.info(
        f"claudesworth ready — chat_id={ALLOWED_CHAT_ID} "
        f"active_session={_short_sid(state.active_session_id) if state.active_session_id else '-'}"
    )


def main() -> None:
    app = (
        ApplicationBuilder()
        .token(TELEGRAM_BOT_TOKEN)
        .post_init(_post_init)
        .build()
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("disconnect", cmd_disconnect))
    app.add_handler(CommandHandler("sessions", cmd_sessions))
    app.add_handler(CallbackQueryHandler(on_callback))

    log.info("claudesworth starting…")
    app.run_polling(drop_pending_updates=True, allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
