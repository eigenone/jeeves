#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Not a git push — allow silently
if ! echo "$COMMAND" | grep -q "git push"; then
  echo '{}'
  exit 0
fi

# Prefer a PROJECT-LOCAL lint-docs.ts over the plugin's. This is DELIBERATELY the
# opposite of the jeeves.ts resolution in the other hooks. jeeves.ts is the engine
# (never customized; a stale copy is slow -> hook timeout) and heal-docs writes fixes
# (a stale copy makes bad edits) — for both, the plugin copy must win. lint-docs is
# different: it is a CUSTOMIZATION POINT. Projects tighten its file-path heuristic to
# stop false positives on URL routes, schema.table identifiers, <placeholders>, and
# bare filenames. Forcing the generic plugin linter over an intentional local one
# blocks EVERY push on false positives (UBQT report 2026-07-04: local 384/384 vs
# generic 627 failures on the same docs). A stale local lint-docs is low-risk (it only
# reports), so the project-local copy wins; fall back to the plugin only when absent.
if [ -f "scripts/lint-docs.ts" ]; then
  LINT_SCRIPT="scripts/lint-docs.ts"
else
  LINT_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts"
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
