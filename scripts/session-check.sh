#!/bin/bash
cat > /dev/null
F=/tmp/ak-$(basename "$(pwd)")-session-$PPID
if [ -f "$F" ]; then
  echo '{}'
  exit 0
fi
touch "$F"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session_start project=$(basename "$(pwd)")" >> "${HOME}/.jeeves-usage.log" 2>/dev/null

# Resolve Jeeves script — check project first, then plugin root
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
OUTPUT=$(npx tsx "$JEEVES_SCRIPT" --check 2>/dev/null)
if [ -n "$OUTPUT" ]; then
  CLEAN=$(echo "$OUTPUT" | grep -v "^$" | grep -v "^📋" | tr '\n' ' ' | sed 's/  */ /g' | head -c 500)
  ESCAPED=$(echo "$CLEAN" | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Jeeves session check: %s"}}\n' "$ESCAPED"
  exit 0
fi

# Fallback if Jeeves not available
MSG=""
if [ -d docs/internal ]; then
  L=$(grep "^## \\[" docs/internal/log.md 2>/dev/null | head -1 | sed 's/^## //')
  [ -n "$L" ] && MSG="${MSG}Last: ${L}. "
  PT=$(find docs/internal/patterns -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  DC=$(find docs/internal/decisions -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  MSG="${MSG}KB: ${PT} patterns, ${DC} decisions. "
fi
if [ -d thinking ]; then
  TP=$(find thinking/topics -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  TS=$(find thinking/sessions -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  MSG="${MSG}Brainstorm: ${TP} topics, ${TS} sessions."
fi
if [ -n "$MSG" ]; then
  ESCAPED=$(echo "$MSG" | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESCAPED"
else
  echo '{}'
fi
exit 0
