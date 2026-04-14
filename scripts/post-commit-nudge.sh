#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git commit — return empty JSON and exit
if ! echo "$COMMAND" | grep -q "git commit"; then
  echo '{}'
  exit 0
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post_commit project=$(basename "$(pwd)")" >> "${HOME}/.jeeves-usage.log" 2>/dev/null

# Run Jeeves to analyze what needs documenting — only surface medium+ priority
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
OUTPUT=$(npx tsx "$JEEVES_SCRIPT" 2>/dev/null)
ACTION_COUNT=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep -c "ACTION" 2>/dev/null || echo "0")

if [ "$ACTION_COUNT" -gt 0 ]; then
  ACTIONS=$(echo "$OUTPUT" | grep -E "🔴|🟡" | grep "ACTION" | head -5 | sed 's/^.*ACTION/ACTION/' | tr '\n' ' ' | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Jeeves found %s doc action(s) after your commit. Execute them now: %s"}}\n' "$ACTION_COUNT" "$ACTIONS"
else
  echo '{}'
fi
exit 0
