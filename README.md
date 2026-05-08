# claude-code-tg

A small Telegram bridge for [Claude Code](https://claude.com/claude-code).

DM the bot, pick a Claude Code session to follow, and from then on every
end-of-turn message from that session lands in Telegram. Anything you send
back — text, photos, or documents — is piped into the session as a user
message. Switch sessions with one tap, or just **reply** to any of the bot's
previous messages to switch to the session that produced it. Only one
session is followed at a time.

## Install

```sh
npx claude-code-tg
```

That's it. On first run it walks you through three things:

1. Your Telegram bot token (from [@BotFather](https://t.me/BotFather)).
2. Your numeric Telegram chat id (from [@userinfobot](https://t.me/userinfobot)) — the only chat the bot will answer.
3. Whether to install a systemd user service so the bridge auto-starts on
   login. (Skip this and run it in a terminal if you'd rather.)

The same command also registers a one-line Stop hook in your
`~/.claude/settings.json` so Claude Code reports end-of-turn events back to
the bridge. No plugin install, no `.env`, no daemon to manage by hand.

## Requirements

- Node ≥ 22
- `curl` on your `$PATH` (the Stop hook is one line of curl)
- A Telegram bot — ask [@BotFather](https://t.me/BotFather), takes about 30 seconds

## Subcommands

`npx claude-code-tg` with no arguments runs `init` if you haven't configured
anything yet, otherwise starts the bridge in the foreground. The named
subcommands are useful for scripting:

- `npx claude-code-tg init` — run the setup wizard (re-runnable; updates fields without breaking earlier state).
- `npx claude-code-tg start` — start the bridge in the foreground.
- `npx claude-code-tg install-service` — install (or reinstall) the systemd user unit and start it.
- `npx claude-code-tg uninstall` — stop and remove the service, drop the Stop hook from Claude Code's settings, and optionally delete the saved config.
- `npx claude-code-tg status` — show what's currently configured / installed / running.

For headless boxes, run `sudo loginctl enable-linger $USER` once so the
service stays up after you log out. The installer reminds you of this.

## Telegram commands

- `/resume [id]` — pick a recent session (tap from list) or jump to one by id.
- `/new` — start a fresh session in `$HOME`.
- `/status` — current connection (model, last-turn context, message count).
- `/compact` — compact the connected session.
- `/cancel` — stop the in-flight turn and drop everything queued behind it.
- `/tasks` — show the connected session's TodoWrite list.
- `/commands` — list every slash command this session can run, each tappable.
- `/disconnect` — stop following.
- `/help` — command summary.

`/sessions` and `/switch` keep working as aliases for `/resume`.

Any other slash command — your installed skills, project-scoped custom
commands, and most Claude Code built-ins — gets forwarded to the connected
session. Local-command output (e.g. `/cost`, `/usage`) is sent back as one
Telegram message; commands that invoke the model deliver via the
end-of-turn path. Interactive built-ins that need a real terminal (auth
flows, TUI pickers, etc.) are politely refused with a hint pointing at the
bridge equivalent where one exists.

Plain text → goes to the connected session as a user message.
Photos and documents (PDF, text, markdown, CSV, source files…) →
downloaded to `/tmp/claude-code-tg-uploads/` and shown to the session as a
path the assistant reads with its Read tool. Documents larger than
Telegram's 20 MB bot-API cap are rejected with a clear error.

Reply to any of the bot's previous reply chunks → switches to the session
that produced it (same effect as `/switch`, no typing) and your message
goes to that session as the first turn post-switch. The last 500 chunks
the bot has sent are tracked.

## Architecture

```
              Telegram ──user input──► grammY bot ──► inbound queue
                                                            │
                                                      SDK query()
                                                            ▼
                                                      Claude Code
                                                            │
                                                    end of turn
                                                            │
 Telegram ◄──── intake :8765 ◄──HTTP POST── Stop hook ◄────┘
                    (only when posted session
                     matches the connected one)
```

The bridge is a single Node process. Inbound Telegram messages drive the
agent via the Claude Agent SDK; the agent's end-of-turn events come back
through a Stop hook (a one-line curl) that posts to a localhost-only
intake server on the same process. Delivery to Telegram only fires when
the posted session matches the one you're following.

There's no Anthropic API key — the bridge runs your locally-installed
Claude Code binary as a subprocess, riding whatever login you already have.

## Auth model

- **Telegram side:** locked to a single numeric chat id. Messages from
  anyone else are silently dropped.
- **Intake side:** bound to `127.0.0.1` only — never exposed off-host.

There is no per-session ACL: anything you can do in your own Claude Code,
the bot can do on your behalf. Practical implication: if your Telegram
account is compromised, so is the bridge. Keep Telegram 2FA on.

## Limitations

- One subscription slot. Switching sessions is a pointer flip; the previous
  session is silently dropped (its Stop-hook posts simply no longer match).
- End-of-turn delivery only — no streaming partials.
- Photo input goes through a Read-tool detour rather than native multimodal
  blocks; works, but every photo turn pays one extra tool call.
- The bundled Claude Code CLI is pinned by the agent SDK version;
  upgrading the SDK upgrades the Claude Code runtime in lockstep.

## Development

```sh
git clone git@github.com:ee92/claude-code-tg.git
cd claude-code-tg
npm install
npm run build
node bin/claude-code-tg.mjs init
node bin/claude-code-tg.mjs start
```

Env vars (`TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID`, `INTAKE_PORT`,
`CLAUDE_TIMEOUT_SEC`) override the saved config at runtime. See
`.env.example`.

## License

MIT — see [`LICENSE`](LICENSE).
