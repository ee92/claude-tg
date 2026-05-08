# claude-tg plugin

Claude Code plugin half of [`claude-tg`](https://github.com/ee92/claude-tg). Registers a Stop hook that POSTs each end-of-turn event to the local claude-tg daemon's intake on `127.0.0.1:8765`. The daemon decides whether to forward to Telegram.

The daemon must be installed and running separately — see the main repo's README for setup. This plugin is just the wiring on the Claude Code side.

If the daemon is offline, the hook fails silently and Claude Code is unaffected.
