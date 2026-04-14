#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git push — skip
if ! echo "$COMMAND" | grep -q "git push"; then
  echo '{}'
  exit 0
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post_push project=$(basename "$(pwd)")" >> "${HOME}/.jeeves-usage.log" 2>/dev/null

# Run full Jeeves — all priorities, no filtering
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
OUTPUT=$(npx tsx "$JEEVES_SCRIPT" 2>/dev/null)
ACTION_COUNT=$(echo "$OUTPUT" | grep -c "ACTION" 2>/dev/null || echo "0")

if [ "$ACTION_COUNT" -gt 0 ]; then
  ACTIONS=$(echo "$OUTPUT" | grep "ACTION" | head -10 | sed 's/^.*ACTION/ACTION/' | tr '\n' ' ' | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just pushed. Jeeves found %s doc action(s) that need attention before you move on. Address these now — stale docs that ship are stale docs that mislead the next person. Actions: %s"}}\n' "$ACTION_COUNT" "$ACTIONS"
else
  echo '{}'
fi
exit 0
