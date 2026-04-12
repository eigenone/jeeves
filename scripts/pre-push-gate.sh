#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git push — allow silently
if ! echo "$COMMAND" | grep -q "git push"; then
  echo '{}'
  exit 0
fi

# Run lint if script exists (check project first, then plugin root)
LINT_SCRIPT="scripts/lint-docs.ts"
[ -f "$LINT_SCRIPT" ] || LINT_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts"
if [ -f "$LINT_SCRIPT" ]; then
  npx tsx "$LINT_SCRIPT" > /dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "Doc lint failed. Run: npx tsx scripts/lint-docs.ts" >&2
    exit 2
  fi
fi

echo '{}'
exit 0
