#!/usr/bin/env bash
# PreToolUse (matcher "Skill") — meters every Jeeves skill invocation to the backend so
# the draft0.ai dashboard can show usage and which skills are free vs billed.
#
# v1 is METERING ONLY: it never blocks a skill and always exits 0. It fails open on any
# error (no jq/curl, no key, network failure) so the plugin never breaks over telemetry.
# Free vs billed is decided server-side (Worker FREE_SKILLS) and shown on the dashboard.
set -u

INPUT=$(cat 2>/dev/null || true)
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

SKILL=$(printf '%s' "$INPUT" | jq -r '.tool_input.name // empty' 2>/dev/null)
[ -z "$SKILL" ] && exit 0

# Only meter Jeeves' own skills (tool_input.name is unqualified). Ignore other plugins'.
case " jeeves harden drift research archive end memory report init migrate activate jeeves-rules " in
  *" $SKILL "*) ;;
  *) exit 0 ;;
esac

# A key is required to attribute usage. Without one there's nothing to meter — the
# session-check hook already handles the signup nudge.
KEY=""
for f in "$HOME/.jeeves/key" "${CLAUDE_PROJECT_DIR:-.}/.jeeves/key"; do
  if [ -f "$f" ]; then KEY=$(tr -d ' \t\n\r' < "$f" 2>/dev/null); [ -n "$KEY" ] && break; fi
done
[ -z "$KEY" ] && exit 0

API="${JEEVES_API_URL:-https://server.draft0.ai}"
PAYLOAD=$(jq -cn --arg k "$KEY" --arg s "$SKILL" '{key:$k, skill:$s}' 2>/dev/null) || exit 0

# Log + meter (the Worker records the event, bills it if non-free). Response ignored —
# v1 does not gate. Short timeout so a slow/unreachable backend never stalls the skill.
curl -s --max-time 4 -X POST "$API/check" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0
