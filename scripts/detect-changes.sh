#!/bin/bash
# detect-changes.sh — Detect what changed since docs were last updated
#
# Usage: bash scripts/detect-changes.sh [project-root]
#
# Compares the last docs/internal/ commit against HEAD to find:
# 1. New files that might need documentation
# 2. Changed files that might make docs stale
# 3. Deleted files that should be removed from docs
#
# Use this to scope an incremental update.

ROOT="${1:-.}"
DOCS_DIR="$ROOT/docs/internal"

if [ ! -d "$DOCS_DIR" ]; then
  echo "ERROR: No docs/internal/ directory found at $ROOT"
  echo "Run the full bootstrap first (see AGENT-BOOTSTRAP.md)"
  exit 1
fi

# Find the last commit that touched docs/internal/
LAST_DOCS_COMMIT=$(git -C "$ROOT" log --format="%H" -1 -- docs/internal/)

if [ -z "$LAST_DOCS_COMMIT" ]; then
  echo "ERROR: No git history found for docs/internal/"
  exit 1
fi

LAST_DOCS_DATE=$(git -C "$ROOT" log --format="%ai" -1 -- docs/internal/)
echo "=== Docs Last Updated ==="
echo "Commit: $LAST_DOCS_COMMIT"
echo "Date:   $LAST_DOCS_DATE"
echo ""

# Find code changes since last docs update
# Adjust these paths to match your project structure
CODE_PATHS="lib/ app/ apps/ workers/ components/ prisma/ widget/ src/ packages/ server/ services/ modules/"

echo "=== New Files (may need new docs) ==="
git -C "$ROOT" diff --name-only --diff-filter=A "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | head -30
NEW_COUNT=$(git -C "$ROOT" diff --name-only --diff-filter=A "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | wc -l | tr -d ' ')
echo "($NEW_COUNT new files)"
echo ""

echo "=== Modified Files (may make docs stale) ==="
git -C "$ROOT" diff --name-only --diff-filter=M "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | head -30
MOD_COUNT=$(git -C "$ROOT" diff --name-only --diff-filter=M "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | wc -l | tr -d ' ')
echo "($MOD_COUNT modified files)"
echo ""

echo "=== Deleted Files (should be removed from docs) ==="
git -C "$ROOT" diff --name-only --diff-filter=D "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | head -30
DEL_COUNT=$(git -C "$ROOT" diff --name-only --diff-filter=D "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | wc -l | tr -d ' ')
echo "($DEL_COUNT deleted files)"
echo ""

echo "=== Renamed Files (update paths in docs) ==="
git -C "$ROOT" diff --name-only --diff-filter=R "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | head -30
REN_COUNT=$(git -C "$ROOT" diff --name-only --diff-filter=R "$LAST_DOCS_COMMIT"..HEAD -- $CODE_PATHS 2>/dev/null | wc -l | tr -d ' ')
echo "($REN_COUNT renamed files)"
echo ""

# Schema changes (high impact)
echo "=== Schema Changes (high impact) ==="
git -C "$ROOT" diff --name-only "$LAST_DOCS_COMMIT"..HEAD -- "*.prisma" "*/schema.ts" "*/schema.prisma" "drizzle/" "prisma/migrations/" 2>/dev/null | head -10
echo ""

TOTAL=$((NEW_COUNT + MOD_COUNT + DEL_COUNT + REN_COUNT))
echo "=== Summary ==="
echo "Total code changes since last docs update: $TOTAL"
if [ "$TOTAL" -eq 0 ]; then
  echo "Docs are up to date. No incremental update needed."
  echo "You can still run: npx tsx scripts/lint-docs.ts"
elif [ "$TOTAL" -lt 5 ]; then
  echo "Recommendation: Small incremental update (10-20 min)"
elif [ "$TOTAL" -lt 20 ]; then
  echo "Recommendation: Medium incremental update (30-60 min)"
else
  echo "Recommendation: Large incremental update (1-2 hrs) or consider full rebuild"
fi
