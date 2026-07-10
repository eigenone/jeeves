#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only gate real `git push`. Skip dry-runs and incidental mentions (`echo "git push"`).
case "$COMMAND" in
  *--dry-run*) echo '{}'; exit 0 ;;
esac
printf '%s' "$COMMAND" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)' || { echo '{}'; exit 0; }

# Run from the session's project root if the hook provided one (parity with session-check).
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] && cd "$CWD" 2>/dev/null

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
[ -f "$LINT_SCRIPT" ] || { echo '{}'; exit 0; }

# Resolve tsx to a direct binary. FAIL OPEN if the toolchain can't run — a missing or
# broken runner (offline npx, tsx absent, node error) must NEVER block a push; only
# genuine lint findings do. lint-docs exits 1 for findings and fails open (exit 0) on
# its own internal errors, so a non-zero exit here unambiguously means broken paths.
if command -v tsx >/dev/null 2>&1; then TSX="tsx"
elif [ -x "node_modules/.bin/tsx" ]; then TSX="node_modules/.bin/tsx"
else TSX="npx --no-install tsx"; fi
if ! $TSX --version >/dev/null 2>&1; then echo '{}'; exit 0; fi

OUT=$($TSX "$LINT_SCRIPT" 2>&1); CODE=$?
if [ "$CODE" -ne 0 ]; then
  FINDINGS=$(printf '%s\n' "$OUT" | grep -iE 'not found|FAILURE|✗' | head -20)
  printf 'Doc lint failed (%s) — fix these broken paths before pushing:\n%s\n' "$LINT_SCRIPT" "$FINDINGS" >&2
  exit 2
fi

echo '{}'
exit 0
