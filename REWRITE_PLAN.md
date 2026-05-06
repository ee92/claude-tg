# Claudesworth TypeScript Rewrite — Implementation Plan

Status: pending implementation
Confidence: ~88%
Estimated size: ~400 lines TS + 60 lines unchanged shell

## Why rewrite

Current Python bridge has multiple bug classes that keep recurring:

1. **Lossy directory decoder.** ClaudeCode encodes `cwd` into the JSONL parent dir name with `/`→`-`, `.`→``, `_`→`-`. Inverse is non-injective: `/home/clawd/projects/cross-chain-arb` and a hypothetical `/home/clawd/projects/cross/chain/arb` both encode the same way. Any project with hyphens silently breaks. Current code reconstructs the path heuristically.
2. **Markdown escape gaps.** Project names with `_` or `.` get sent into Telegram MarkdownV2 unescaped, occasionally tripping the parser and falling back to plain text or double-sending.
3. **Silent-on-success intake.** The HTTP intake logs failures but not successes, so when something doesn't reach Telegram there's no breadcrumb to tell whether the hook fired.
4. **Off-by-one queue log.** A cosmetic bug in the queue position log line.

These are individually small but the lossy decoder is structural — any patch is a workaround. The Claude Agent SDK exposes `listSessions()` / `getSessionInfo()` which return the canonical `cwd` directly, killing the bug class entirely.

## Stack decision

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node v22.22.0 | Already on VPS at `/usr/bin/node` |
| Language | TypeScript → tsc → JS | Type safety on SDK + Telegram API surface |
| Telegram | grammY 1.42 + `@grammyjs/parse-mode` | `fmt` template tag auto-escapes MarkdownV2 — kills bug class #2. Modern, typed, smaller than telegraf |
| Claude SDK | `@anthropic-ai/claude-agent-sdk` 0.2.128 | Feature parity with Python SDK for our needs. Native TS. |
| HTTP intake | Built-in `node:http` | ~30 lines, no dep needed |
| State | Existing `state.json` schema | Atomic write via tmp+rename |

## Project layout

```
~/projects/claudesworth/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        ~30 lines — wire-up
│   ├── config.ts       ~25 lines — env validation
│   ├── state.ts        ~50 lines — atomic load/save state.json
│   ├── sessions.ts     ~25 lines — SDK listSessions wrapper
│   ├── format.ts       ~30 lines — age, truncate, shortSid helpers
│   ├── telegram.ts     ~110 lines — grammY bot + all handlers
│   ├── intake.ts       ~60 lines — http server, /stop + /health
│   └── inbound.ts      ~70 lines — queue + SDK query() worker
├── dist/               (build output, gitignored)
├── hook.sh             unchanged (60 lines)
├── claudesworth.service updated ExecStart line
├── state.json          unchanged schema
└── .env                unchanged
```

## Module responsibilities

### `config.ts`
- Load and validate env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `INTAKE_PORT` (default 8765)
- Throw with clear error on missing/invalid

### `state.ts`
- Schema unchanged from Python: `{ active_session_id?: string, last_seen_per_session?: Record<sid, ISO> }`
- `load()` returns parsed state or empty default
- `save(state)` writes `state.json.tmp` then renames atomically

### `sessions.ts`
- Wraps SDK `listSessions()` and `getSessionInfo(sid)`
- Returns `{ sid, cwd, project, lastModified, summary }[]`
- `project` derived as basename of `cwd` — this replaces the lossy decoder. **Bug class #1 dies here.**

### `format.ts`
- `shortSid(sid)` → first 8 chars
- `age(iso)` → "3m", "2h", "5d"
- `truncate(s, n)` for long summaries

### `telegram.ts`
- grammY `Bot` instance
- Chat-id middleware: ignore everything not from configured chat
- Commands:
  - `/start`, `/help` — usage
  - `/status` — current active session, age, project
  - `/sessions` — list recent sessions with project + age + summary
  - `/use <sid-prefix>` — switch active session by prefix match
  - `/stop` — clear active session
- Free-text messages → enqueue to `inbound` worker
- Reaction ack: `await ctx.react("👀")` on every accepted command/message — eliminates "did it receive my message" anxiety

### `intake.ts`
- `node:http` server bound to `127.0.0.1:INTAKE_PORT`
- `POST /stop` body `{session_id, project, last_message}` — looks up cwd via SDK if not provided, formats, sends to Telegram
- `GET /health` → 200 ok
- **All code paths log INFO** (received, parsed, sent, failed) — kills bug class #3
- Outbound format:
  ```ts
  bot.api.sendMessage(
    chatId,
    fmt`*${bold(project)}* · ${code(shortSid)}\n\n${body}`,
    { parse_mode: "MarkdownV2" }
  )
  ```
  `fmt` auto-escapes — kills bug class #2

### `inbound.ts`
- In-memory FIFO queue per session
- Worker pulls one at a time, calls SDK `query({ prompt, options: { resume: sid } })`
- Streams assistant output but does NOT forward to Telegram itself — relies on Stop hook firing to `intake.ts`, so bridge-driven and external sessions share a single fan-in path
- Logs queue position correctly (off-by-one bug #4 dies here)

### `index.ts`
- Boots config, telegram, intake; starts grammY long-poll
- Handles SIGTERM cleanly

## Stop hook strategy

`hook.sh` and `~/.claude/settings.json` Stop hook registration **stay unchanged**. The bundled CLI inside the SDK respects user `settings.json` hooks, so SDK-spawned turns and external sessions both fire the same hook → POST `/stop` → single fan-in. **Risk:** if the bundled CLI ignores user hooks, fallback is to use the SDK's in-process Stop callback for bridge-driven turns and the system hook only for external. Verify on first turn.

## Workspace + deploy flow

Claudesworth is **not** registered in the deploy CLI (no preview URL, no remote-strategy). Flow:

1. Create task on board (this file). ✓ t_8f5eec6c
2. `workspace start claudesworth t_8f5eec6c` → `.worktrees/t_8f5eec6c/` ✓
3. In workspace: scaffold, `npm install`, `npm run build`, smoke-test locally
4. Commit in chunks: scaffolding → state → sessions → telegram → intake → inbound → service unit
5. Manual fast-forward merge to live (no `deploy promote` available for this app)
6. On live: `npm install` + `npm run build`
7. Swap service unit `ExecStart` from `venv/bin/python bridge.py` to `/usr/bin/node /home/clawd/projects/claudesworth/dist/index.js`. Keep old unit as `claudesworth.service.python.bak`.
8. `systemctl daemon-reload && systemctl restart claudesworth`
9. Verify (see below)
10. Mark task done

## Verification checklist

- `systemctl status claudesworth` → active (running)
- `curl 127.0.0.1:8765/health` → 200
- `journalctl -u claudesworth -f` shows boot logs
- `/status` from Telegram returns active session info
- `/sessions` lists recent sessions with **correctly hyphenated** project names (cross-chain-arb, agent-ui, swap.win)
- Free-text message round-trip: send msg → 👀 reaction → assistant reply arrives → all logs visible at every step
- Markdown edge case: ask Claude to reply with text containing `_underscores_` → arrives intact, no double-send fallback

## Rollback

- Old `bridge.py`, `venv/`, and `claudesworth.service.python.bak` stay on disk through verification window.
- If issues: `cp claudesworth.service.python.bak claudesworth.service && systemctl daemon-reload && systemctl restart claudesworth`

## Open questions (defaults stated)

1. **Bot identity** — keep same Telegram bot token? **Default: yes.**
2. **Logging** — keep `claudesworth.log` file alongside journald, or journald-only? **Default: journald-only.**
3. **Build artifact** — pre-built `dist/` committed to repo or `npm run build` on live? **Default: build-on-live.**
4. **Stale state** — keep current `active_session_id` in `state.json` across the swap, or clear? **Default: keep.**

## Risks

- SDK bundled CLI might not fire user-level Stop hooks (mitigation: in-process Stop callback fallback)
- grammY reactions API in production (low risk — well-supported since Bot API 7.0)
- `npm install` adds ~280MB (SDK bundles full Claude CLI ~238MB). VPS has plenty of disk.

## Bug classes eliminated

| # | Bug | Killed by |
|---|---|---|
| 1 | Lossy `_decode_project_dir` | SDK `listSessions()` returns canonical `cwd` |
| 2 | Markdown escape gaps | grammY `fmt` template tag auto-escapes |
| 3 | Silent-on-success intake | INFO log on every code path |
| 4 | Off-by-one queue log | New worker, fresh implementation |
