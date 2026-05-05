#!/usr/bin/env bash
# Claudesworth Stop hook.
#
# Triggered by Claude Code when an assistant turn ends.
# Reads the hook event JSON on stdin, pulls session_id + transcript_path, finds
# the LAST assistant entry in the transcript, concatenates its text blocks
# (skipping tool_use / thinking), and POSTs the result to the Claudesworth
# intake on localhost.
#
# The daemon decides whether to forward to Telegram (only when this session is
# the connected one). If the daemon is down, the hook silently no-ops — it
# must never block Claude.
#
# Hook event JSON shape (Stop hook):
#   { "session_id": "...", "transcript_path": "...", "cwd": "...", ... }

set -u

INTAKE_URL="${CLAUDESWORTH_INTAKE_URL:-http://127.0.0.1:8765/stop}"
DEBUG_LOG="${CLAUDESWORTH_HOOK_DEBUG:-/tmp/claudesworth-hook-debug.log}"

# Breadcrumb 1: hook fired at all. Capture ppid (parent process) so we can tell
# bot-daemon-spawned vs interactively-spawned vs other.
_now() { date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'; }
_ppid_cmd() {
  local p
  p="$(awk '{print $4}' /proc/$$/stat 2>/dev/null)"
  [[ -z "$p" ]] && { echo "?"; return; }
  tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | sed 's/ $//' || echo "?"
}
{
  printf '%s FIRED pid=%s ppid_cmd=%q\n' "$(_now)" "$$" "$(_ppid_cmd)"
} >> "$DEBUG_LOG" 2>/dev/null || true

event="$(cat)"
[[ -z "${event}" ]] && {
  printf '%s EXIT empty-stdin\n' "$(_now)" >> "$DEBUG_LOG" 2>/dev/null || true
  exit 0
}

session_id="$(printf '%s' "$event" | jq -r '.session_id // empty')"
transcript="$(printf '%s' "$event" | jq -r '.transcript_path // empty')"
cwd="$(printf '%s' "$event" | jq -r '.cwd // empty')"

if [[ -z "$session_id" || -z "$transcript" || ! -f "$transcript" ]]; then
  printf '%s EXIT bad-event sid=%q transcript=%q exists=%s\n' \
    "$(_now)" "${session_id:0:8}" "$transcript" \
    "$([[ -f "$transcript" ]] && echo yes || echo no)" \
    >> "$DEBUG_LOG" 2>/dev/null || true
  exit 0
fi

# Project shortname: basename of cwd, "~" if it's $HOME.
if [[ "$cwd" == "$HOME" ]]; then
  project="~"
else
  project="$(basename "$cwd")"
fi

# Slurp the JSONL, take the LAST assistant entry, join its text blocks.
# If there are no text blocks (e.g. last turn ended with only tool_use), result
# is empty and the daemon will drop it.
text="$(jq -rs '
  [ .[] | select(.type=="assistant") ]
  | if length == 0 then ""
    else
      ( (.[-1].message.content // [])
        | map(select(.type=="text") | .text)
        | join("\n\n")
      )
    end
' "$transcript" 2>/dev/null)"

# Breadcrumb 2: what jq actually extracted.
{
  text_len=${#text}
  text_preview="${text:0:60}"
  printf '%s EXTRACTED sid=%s text_len=%s preview=%q\n' \
    "$(_now)" "${session_id:0:8}" "$text_len" "$text_preview"
} >> "$DEBUG_LOG" 2>/dev/null || true

# Build payload (jq handles JSON escaping for embedded newlines / quotes).
payload="$(jq -nc \
  --arg sid "$session_id" \
  --arg project "$project" \
  --arg text "$text" \
  '{session_id:$sid, project:$project, text:$text}')"

# POST, capturing HTTP response code into the breadcrumb. Short timeout, never
# fail the hook on transport errors.
http_code="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$INTAKE_URL" 2>/dev/null || echo "curl-err-$?")"

# Breadcrumb 3: what the intake said.
printf '%s POSTED sid=%s http=%s\n' \
  "$(_now)" "${session_id:0:8}" "$http_code" \
  >> "$DEBUG_LOG" 2>/dev/null || true

exit 0
