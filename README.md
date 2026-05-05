# Claudesworth

Tiny Telegram bridge for Claude Code on the VPS.

You DM `@claudesworth_bot`, pick a Claude session to follow, and from then on
the final assistant message at the end of every turn lands in your DMs. Pick a
different session and the previous one is silently dropped. One subscription
slot, no streaming, no media, no inbound message piping (yet).

## Architecture

```
Claude Code session ──Stop hook──▶ localhost:8765 ──▶ daemon ──▶ Telegram DM
                                                       │
                                                  state.json
                                                  (active_session_id)
```

- **`bridge.py`** — single-file daemon. Holds the bot connection, the active
  session pointer, and an HTTP intake on `127.0.0.1:8765`. State persists to
  `state.json` next to the script.
- **`hook.sh`** — Claude Code Stop hook. Reads the hook event on stdin, finds
  the last assistant entry's text blocks, POSTs them to the daemon. Silent
  no-op if the daemon is down. Never blocks Claude.
- **`claudesworth.service`** — systemd unit; auto-restarts.

## Telegram commands

- `/sessions` — list 10 latest sessions, tap a button to connect
- `/status` — show current connection
- `/disconnect` — stop following
- `/help` — command list

Switching sessions is a pointer flip in `state.json`. There's nothing per-session
to "clean up" — old hook posts that don't match the active id are dropped at
intake.

## Setup

```sh
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# Fill in token + chat_id
cp .env.example .env

# Smoke-test:
venv/bin/python bridge.py

# Install as a service (after promote → live folder):
sudo cp claudesworth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claudesworth
```

The Claude Code Stop hook gets registered in `~/.claude/settings.json` to point
at `hook.sh`. The hook uses `jq` and `curl` (both already on the VPS).

## Auth

- Telegram side: locked to a single numeric `ALLOWED_CHAT_ID`. Anyone else's
  messages are silently ignored.
- Intake side: bound to `127.0.0.1` only.

## Extending later

The base is intentionally minimal. Likely future bolt-ons:

- Inbound: pipe Telegram messages back into the connected session
- Per-project subscriptions (follow all sessions in project X)
- Streaming partial output instead of end-of-turn only
- Voice / image / document support
- Multi-user with per-user active session
