#!/usr/bin/env bash
# Claudesworth Stop hook.
#
# Triggered by Claude Code when an assistant turn ends. Reads the hook event
# JSON on stdin, pulls session_id + last_assistant_message + cwd, and POSTs
# to the Claudesworth intake on localhost.
#
# The daemon decides whether to forward to Telegram (only when this session is
# the connected one). If the daemon is down, the hook silently no-ops — it
# must never block Claude.
#
# Hook event JSON shape (Stop hook):
#   { "session_id", "transcript_path", "cwd", "last_assistant_message", ... }
#
# We use `last_assistant_message` (added by Anthropic specifically to avoid
# the JSONL-flush race) instead of slurping the transcript file ourselves.

set -u

INTAKE_URL="${CLAUDESWORTH_INTAKE_URL:-http://127.0.0.1:8765/stop}"

event="$(cat)"
[[ -z "${event}" ]] && exit 0

session_id="$(printf '%s' "$event" | jq -r '.session_id // empty')"
cwd="$(printf '%s' "$event" | jq -r '.cwd // empty')"
text="$(printf '%s' "$event" | jq -r '.last_assistant_message // empty')"

if [[ -z "$session_id" ]]; then
  exit 0
fi

# Project shortname: basename of cwd, "~" if it's $HOME.
if [[ "$cwd" == "$HOME" ]]; then
  project="~"
else
  project="$(basename "$cwd")"
fi

# Build payload (jq handles JSON escaping for embedded newlines / quotes).
payload="$(jq -nc \
  --arg sid "$session_id" \
  --arg project "$project" \
  --arg text "$text" \
  '{session_id:$sid, project:$project, text:$text}')"

# Fire-and-forget POST. Short timeout, swallow all output, never fail the hook.
curl -sS -m 3 \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$INTAKE_URL" >/dev/null 2>&1 || true

exit 0
