#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git commit — return empty JSON and exit
if ! echo "$COMMAND" | grep -q "git commit"; then
  echo '{}'
  exit 0
fi

USAGE_LOG="${JEEVES_USAGE_LOG:-${HOME}/.jeeves-usage.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post_commit project=$(basename "$(pwd)")" >> "$USAGE_LOG" 2>/dev/null

# Run Jeeves to analyze what needs documenting
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
OUTPUT=$(npx tsx "$JEEVES_SCRIPT" 2>/dev/null)

# Only surface medium+ priority (red/yellow). Count low-priority separately.
HIGH=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep "ACTION" | head -5 | sed 's/^.*ACTION/ACTION/' | tr '\n' ' ')
# grep -c already prints 0 on no match; the old `|| echo 0` appended a SECOND
# 0 (exit 1 from grep -c), yielding "0\n0" and an "integer expression" error.
HIGH_COUNT=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep -c "ACTION")
LOW_COUNT=$(echo "$OUTPUT" | grep "🟢" | grep -c "ACTION")

DOC_MSG=""
if [ "$HIGH_COUNT" -gt 0 ]; then
  DOC_MSG="Jeeves: ${HIGH_COUNT} doc action(s) to address."
  [ "$LOW_COUNT" -gt 0 ] && DOC_MSG="${DOC_MSG} (${LOW_COUNT} low-priority skipped — run /jeeves to see all.)"
  DOC_MSG="${DOC_MSG} ${HIGH}"
elif [ "$LOW_COUNT" -gt 0 ]; then
  DOC_MSG="Jeeves: ${LOW_COUNT} low-priority doc items (likely fine). Run /jeeves if you want to review."
fi

# Ride-along reminder: decision captures left uncommitted in thinking/. Three
# guards learned from real use:
#  - Suppressed in SUBAGENTS (agent_id/agent_type present): they never receive
#    the thinking-mode protocol, so to them thinking/ is unaccountable untracked
#    files and they rightly refuse — the nudge only confused/derailed them.
#  - At most ONCE per session (marker keyed on session_id): no per-commit nagging.
#  - Self-identifies thinking/ as Jeeves's own output so a context-light agent
#    doesn't misread it as stray user files.
# Counts only real capture files (not empty bootstrap dirs / INDEX alone).
THINKING_MSG=""
AGENT_CTX=$(echo "$INPUT" | jq -r '.agent_id // .agent_type // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-' | head -c 80)
REMINDED="/tmp/jeeves-${SAFE_ID}-thinking-reminded"
if [ -z "$AGENT_CTX" ] && [ -n "$SAFE_ID" ] && [ ! -f "$REMINDED" ] && [ -d thinking ]; then
  CAP=$(git status --porcelain -uall -- thinking/ 2>/dev/null | grep -cE 'thinking/(decisions|topics|sessions)/.+\.md$')
  if [ "$CAP" -gt 0 ]; then
    THINKING_MSG="Jeeves has ${CAP} uncommitted decision record(s) in thinking/ — Jeeves's own capture output (safe to commit, not stray files). Run git add thinking/ to keep them with your work."
    touch "$REMINDED" 2>/dev/null
  fi
fi

FULL="${THINKING_MSG}${THINKING_MSG:+${DOC_MSG:+ }}${DOC_MSG}"
if [ -n "$FULL" ]; then
  ESC=$(printf '%s' "$FULL" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$ESC"
else
  echo '{}'
fi
exit 0
