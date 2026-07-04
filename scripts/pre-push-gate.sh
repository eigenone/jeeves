#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git push — allow silently
if ! echo "$COMMAND" | grep -q "git push"; then
  echo '{}'
  exit 0
fi

# Prefer the plugin's lint-docs.ts over a stale project-local copy (mirrors the
# jeeves.ts resolution in session-check.sh — a plugin update can't refresh a copy
# committed into the repo). Fall back to local only when there's no plugin root.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts" ]; then
  LINT_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts"
else
  LINT_SCRIPT="scripts/lint-docs.ts"
fi
if [ -f "$LINT_SCRIPT" ]; then
  npx tsx "$LINT_SCRIPT" > /dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "Doc lint failed. Run: npx tsx scripts/lint-docs.ts" >&2
    exit 2
  fi
fi

echo '{}'
exit 0
