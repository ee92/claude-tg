# Claudesworth

A small Telegram bridge for [Claude Code](https://claude.com/claude-code).

DM the bot, pick a Claude Code session to follow, and from then on you get the
end-of-turn messages from that session in Telegram. Anything you send back —
text or photos — gets piped into the session as a user message. Switch
sessions with one tap; only one session is followed at a time.

## Architecture

Two directions, one delivery path:

```
                    Telegram ──user input──► grammY bot ──► inbound queue
                                                                  │
                                                            SDK query()
                                                                  ▼
                                                            Claude Code
                                                                  │
                                                          end of turn
                                                                  │
       Telegram ◄──── intake :8765 ◄──HTTP POST── Stop hook ◄─────┘
                          (only when posted session
                           matches the connected one)
```

- **`src/telegram.ts`** — grammY bot. Handles `/sessions`, `/status`,
  `/disconnect`, free-text, and photo messages. All handlers are gated on a
  single configured chat id. Owns `sendAgentReply` — the shared Markdown→
  Telegram-HTML formatter used by intake on every delivery.
- **`src/inbound.ts`** — FIFO queue + worker. For each Telegram message, calls
  `query({ prompt, options: { resume, cwd, … } })` on the
  `@anthropic-ai/claude-agent-sdk` to drive the agent. It does **not** deliver
  the reply — it just drains the iterator to detect failures. Delivery is
  always handled by the Stop hook → intake path so external turns and
  bridge-driven turns share a single channel.
- **`src/intake.ts`** — minimal `node:http` server bound to `127.0.0.1:8765`.
  Receives Stop-hook payloads and forwards them to Telegram only when the
  posted session matches the currently-connected one.
- **`src/sessions.ts`** — walks `~/.claude/projects/*/<sid>.jsonl` to surface
  recent sessions for `/sessions` and to recover a session's canonical `cwd`
  on demand.
- **`src/state.ts`** — atomic JSON read/write of `state.json` (active session
  id + cwd).
- **`hook.sh`** — shell-only Claude Code Stop hook. Pulls the assistant text
  from the `last_assistant_message` field on the event JSON (Anthropic added
  this specifically to avoid the JSONL-flush race), POSTs it to the intake.
  Silent no-op if the daemon is down. Never blocks Claude.
- **`src/index.ts`** — wires it all up, handles `SIGTERM`/`SIGINT`.

## Telegram commands

- `/sessions` — list ten most-recent sessions, tap a button to connect
- `/status` — show current connection
- `/disconnect` — stop following
- `/help` — command summary

Plain text → goes to the connected session as a user message.
Photos → downloaded, saved to `/tmp/claudesworth-uploads/`, and shown to the
session as a path the assistant reads with its Read tool. (Native multimodal
input is on the SDK roadmap; today the bundled CLI's stream-json parser
mishandles long single-line JSON inputs, so the file-path path is more
reliable.)

## Setup

Requires Node ≥ 22 and `jq` + `curl` in `$PATH` for the Stop hook.

```sh
# 1. install + build
npm install
npm run build

# 2. configure
cp .env.example .env
$EDITOR .env       # set TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID

# 3. register the Stop hook in Claude Code's settings
#    (~/.claude/settings.json), pointing at hook.sh:
#
#    {
#      "hooks": {
#        "Stop": [
#          { "hooks": [{ "type": "command",
#                        "command": "/abs/path/to/hook.sh",
#                        "timeout": 5 }] }
#        ]
#      }
#    }

# 4. run it
npm start
```

`/health` on `127.0.0.1:8765` returns `{ "ok": true }` once the intake is
listening.

## Running as a service

`claudesworth.service` is a stock systemd unit that runs `node dist/index.js`
under your user, restart-on-failure, with logs going to journald.

```sh
sudo cp claudesworth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claudesworth
journalctl -u claudesworth -f
```

Edit the unit's `User=`, `WorkingDirectory=`, and `EnvironmentFile=` if your
checkout lives elsewhere.

## Configuration

All via environment variables (loaded from `.env` by the systemd unit, or by
your shell when running `npm start`):

| Var                     | Required | Default | Notes                                                        |
|-------------------------|----------|---------|--------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`    | yes      | —       | From [@BotFather](https://t.me/BotFather).                   |
| `ALLOWED_CHAT_ID`       | yes      | —       | Numeric Telegram chat id; the only chat the bot will answer. |
| `INTAKE_PORT`           | no       | `8765`  | Local port the Stop hook posts to.                           |
| `CLAUDE_TIMEOUT_SEC`    | no       | `600`   | Per-turn timeout for SDK invocations.                        |

## Auth

- **Telegram side:** locked to a single numeric `ALLOWED_CHAT_ID`. Anyone
  else's messages are silently dropped at a grammY middleware.
- **Intake side:** bound to `127.0.0.1` only — never exposed off-host.

There is no per-session ACL: anything the configured user can do in their
own Claude Code, the bot can do on their behalf. The bridge is a personal
tool, not a multi-tenant service.

## Limitations

- One subscription slot. Switching sessions is a pointer flip; the previous
  session is silently dropped (its Stop-hook posts simply no longer match).
- End-of-turn delivery only — no streaming partials.
- Photo input goes through a Read-tool detour rather than native multimodal
  blocks; works, but every photo turn pays one extra tool call.
- The bundled Claude Code CLI is pinned by the agent SDK version; upgrading
  the SDK upgrades the Claude Code runtime in lockstep.
