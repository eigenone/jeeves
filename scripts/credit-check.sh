#!/usr/bin/env bash
# PreToolUse (matcher "Skill") — meters every Jeeves skill invocation to the backend so
# the draft0.ai dashboard can show usage and which skills are free vs billed.
#
# v1 is METERING ONLY: never blocks a skill, always exits 0, fails open on any error.
# Free vs billed is decided server-side; this hook meters ALL Jeeves skills and lets the
# Worker classify. It only touches Jeeves' own plugin-qualified skills ("jeeves:<name>"),
# so other plugins' / personal skills are never metered.
set -u

INPUT=$(cat 2>/dev/null || true)
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# Real Skill payload shape (verified against live transcripts): {"tool_input":{"skill":"jeeves:harden"}}
RAW=$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // empty' 2>/dev/null)
[ -z "$RAW" ] && exit 0

# Only meter Jeeves' own (plugin-qualified) skills; send the bare name to the backend.
case "$RAW" in
  jeeves:*) SKILL="${RAW#jeeves:}" ;;
  *) exit 0 ;;
esac
[ -z "$SKILL" ] && exit 0

# A key is required to attribute usage. Without one there's nothing to meter — the
# session-check hook handles the signup nudge.
# Precedence: the PROJECT-LOCAL key wins over the global one, so a repo with its own
# .jeeves/key (a per-project/use-case labeled key) attributes usage to that key even
# when a global ~/.jeeves/key is also present.
KEY=""
for f in "${CLAUDE_PROJECT_DIR:-.}/.jeeves/key" "${HOME:-}/.jeeves/key"; do
  case "$f" in /.jeeves/key) continue ;; esac   # skip when the base var was empty
  if [ -f "$f" ]; then KEY=$(tr -d ' \t\n\r' < "$f" 2>/dev/null); [ -n "$KEY" ] && break; fi
done
[ -z "$KEY" ] && exit 0

API="${JEEVES_API_URL:-https://server.draft0.ai}"
PAYLOAD=$(jq -cn --arg k "$KEY" --arg s "$SKILL" '{key:$k, skill:$s}' 2>/dev/null) || exit 0

# Log + meter. Detached fire-and-forget so a slow/unreachable backend never delays the
# skill (v1 ignores the response). Tests set JEEVES_CHECK_SYNC=1 to run it foreground.
if [ "${JEEVES_CHECK_SYNC:-}" = "1" ]; then
  curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 || true
else
  ( curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi

exit 0
