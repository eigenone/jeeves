#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git commit — return empty JSON and exit
if ! echo "$COMMAND" | grep -q "git commit"; then
  echo '{}'
  exit 0
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post_commit project=$(basename "$(pwd)")" >> "${HOME}/.jeeves-usage.log" 2>/dev/null

# Run Jeeves to analyze what needs documenting
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
OUTPUT=$(npx tsx "$JEEVES_SCRIPT" 2>/dev/null)

# Only surface medium+ priority (red/yellow). Count low-priority separately.
HIGH=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep "ACTION" | head -5 | sed 's/^.*ACTION/ACTION/' | tr '\n' ' ' | sed 's/"/\\"/g')
HIGH_COUNT=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep -c "ACTION" 2>/dev/null || echo "0")
LOW_COUNT=$(echo "$OUTPUT" | grep "🟢" | grep -c "ACTION" 2>/dev/null || echo "0")

if [ "$HIGH_COUNT" -gt 0 ]; then
  MSG="Jeeves: ${HIGH_COUNT} doc action(s) to address."
  [ "$LOW_COUNT" -gt 0 ] && MSG="${MSG} (${LOW_COUNT} low-priority skipped — run /jeeves to see all.)"
  MSG="${MSG} ${HIGH}"
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$MSG"
elif [ "$LOW_COUNT" -gt 0 ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Jeeves: %s low-priority doc items (likely fine). Run /jeeves if you want to review."}}\n' "$LOW_COUNT"
else
  echo '{}'
fi
exit 0
