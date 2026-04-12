#!/bin/bash
# rebuild-index.sh — Verify and rebuild SYSTEM-MAP.md indexes
#
# Scans docs/internal/patterns/ and docs/internal/decisions/ directories,
# then checks if SYSTEM-MAP.md's Pattern Index and Decision Index sections
# list every file. Reports missing entries and optionally adds them.
#
# Usage:
#   bash scripts/rebuild-index.sh              # Check mode (report only)
#   bash scripts/rebuild-index.sh --fix        # Add missing entries
#
# This does NOT replace the entire system map. It only touches Sections 5 and 6
# (Pattern Index and Decision Index). The rest of the system map is untouched.

ROOT="${1:-.}"
DOCS_DIR="$ROOT/docs/internal"
SYSTEM_MAP="$DOCS_DIR/SYSTEM-MAP.md"
FIX_MODE=false

for arg in "$@"; do
  if [ "$arg" = "--fix" ]; then
    FIX_MODE=true
  fi
done

if [ ! -f "$SYSTEM_MAP" ]; then
  echo "ERROR: $SYSTEM_MAP not found"
  exit 1
fi

echo "=== Index Rebuild Check ==="
echo ""

MISSING_PATTERNS=()
MISSING_DECISIONS=()

# Check pattern docs
echo "── Pattern Docs ──"
for f in "$DOCS_DIR/patterns/"*.md; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")

  if ! grep -q "patterns/$BASENAME" "$SYSTEM_MAP" 2>/dev/null; then
    echo "  ✗ patterns/$BASENAME — NOT in SYSTEM-MAP.md"
    MISSING_PATTERNS+=("$BASENAME")
  else
    echo "  ✓ patterns/$BASENAME"
  fi
done

echo ""

# Check decision docs
echo "── Decision Docs ──"
for f in "$DOCS_DIR/decisions/"*.md; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")

  if ! grep -q "decisions/$BASENAME" "$SYSTEM_MAP" 2>/dev/null; then
    echo "  ✗ decisions/$BASENAME — NOT in SYSTEM-MAP.md"
    MISSING_DECISIONS+=("$BASENAME")
  else
    echo "  ✓ decisions/$BASENAME"
  fi
done

echo ""

# Check for docs listed in SYSTEM-MAP that don't exist on disk
echo "── Orphan References (in index but file missing) ──"
ORPHANS=0

# Extract pattern references from system map
grep -oE "patterns/[a-zA-Z0-9_-]+\.md" "$SYSTEM_MAP" 2>/dev/null | sort -u | while read -r ref; do
  if [ ! -f "$DOCS_DIR/$ref" ]; then
    echo "  ✗ $ref — referenced in SYSTEM-MAP.md but file doesn't exist"
    ORPHANS=$((ORPHANS + 1))
  fi
done

grep -oE "decisions/[a-zA-Z0-9_-]+\.md" "$SYSTEM_MAP" 2>/dev/null | sort -u | while read -r ref; do
  if [ ! -f "$DOCS_DIR/$ref" ]; then
    echo "  ✗ $ref — referenced in SYSTEM-MAP.md but file doesn't exist"
    ORPHANS=$((ORPHANS + 1))
  fi
done

if [ $ORPHANS -eq 0 ] 2>/dev/null; then
  echo "  ✓ No orphan references"
fi

echo ""

# Summary
TOTAL_MISSING=$((${#MISSING_PATTERNS[@]} + ${#MISSING_DECISIONS[@]}))

if [ "$TOTAL_MISSING" -eq 0 ]; then
  echo "All docs are indexed. Nothing to fix."
  exit 0
fi

echo "Missing from index: ${#MISSING_PATTERNS[@]} patterns, ${#MISSING_DECISIONS[@]} decisions"
echo ""

# Fix mode: append missing entries
if [ "$FIX_MODE" = true ]; then
  echo "=== Applying Fixes ==="
  echo ""

  if [ ${#MISSING_PATTERNS[@]} -gt 0 ]; then
    echo "Adding ${#MISSING_PATTERNS[@]} pattern entries to SYSTEM-MAP.md..."

    # Find the line "All pattern docs live in" and insert before it
    for BASENAME in "${MISSING_PATTERNS[@]}"; do
      # Extract the "What this is" line from the doc for the description
      SUMMARY=$(head -10 "$DOCS_DIR/patterns/$BASENAME" | grep -A1 "What this is" | tail -1 | sed 's/^[[:space:]]*//' | head -c 80)
      NAME=$(echo "$BASENAME" | sed 's/\.md$//' | sed 's/-/ /g')

      # Insert a new row into the pattern index table
      # We use sed to insert before "All pattern docs live in"
      if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "/All pattern docs live in/i\\
| Work with $NAME | \`patterns/$BASENAME\` |
" "$SYSTEM_MAP"
      else
        sed -i "/All pattern docs live in/i\\| Work with $NAME | \`patterns/$BASENAME\` |" "$SYSTEM_MAP"
      fi

      echo "  + patterns/$BASENAME → 'Work with $NAME'"
    done
  fi

  if [ ${#MISSING_DECISIONS[@]} -gt 0 ]; then
    echo "Adding ${#MISSING_DECISIONS[@]} decision entries to SYSTEM-MAP.md..."

    for BASENAME in "${MISSING_DECISIONS[@]}"; do
      NAME=$(echo "$BASENAME" | sed 's/\.md$//' | sed 's/-/ /g')

      if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "/All decision docs live in/i\\
| The $NAME approach | \`decisions/$BASENAME\` |
" "$SYSTEM_MAP"
      else
        sed -i "/All decision docs live in/i\\| The $NAME approach | \`decisions/$BASENAME\` |" "$SYSTEM_MAP"
      fi

      echo "  + decisions/$BASENAME → 'The $NAME approach'"
    done
  fi

  echo ""
  echo "Done. Review the auto-generated descriptions and refine them."
  echo "The generated descriptions are generic — replace them with task-oriented phrases."
else
  echo "Run with --fix to add missing entries to SYSTEM-MAP.md"
fi
