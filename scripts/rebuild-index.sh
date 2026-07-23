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

# First POSITIONAL arg is the project root; a leading flag (e.g. `--fix`) is not a
# root (the documented `rebuild-index.sh --fix` otherwise set ROOT=--fix and errored).
case "${1:-}" in ''|-*) ROOT="." ;; *) ROOT="$1" ;; esac
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

  # Boundary-aware, dot-literal match (mirrors lint-docs.ts listedInMap): a bare
  # `grep patterns/$BASENAME` treats `.` as any-char and has no word boundary, so
  # `auth.md` matched `auth.mdx` / `authx.md` and the entry was falsely "found".
  if ! grep -qE "(^|[^A-Za-z0-9._/-])patterns/$(printf '%s' "$BASENAME" | sed 's/[.[\*^$/]/\\&/g')([^A-Za-z0-9._-]|\$)" "$SYSTEM_MAP" 2>/dev/null; then
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

  if ! grep -qE "(^|[^A-Za-z0-9._/-])decisions/$(printf '%s' "$BASENAME" | sed 's/[.[\*^$/]/\\&/g')([^A-Za-z0-9._-]|\$)" "$SYSTEM_MAP" 2>/dev/null; then
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

# Extract pattern + decision references from the system map. Use process
# substitution, NOT `grep | while`: a piped while runs in a SUBSHELL, so the
# ORPHANS increment was lost and the script always reported "No orphan references".
while read -r ref; do
  if [ ! -f "$DOCS_DIR/$ref" ]; then
    echo "  ✗ $ref — referenced in SYSTEM-MAP.md but file doesn't exist"
    ORPHANS=$((ORPHANS + 1))
  fi
done < <(grep -oE "patterns/[a-zA-Z0-9_-]+\.md" "$SYSTEM_MAP" 2>/dev/null | sort -u)

while read -r ref; do
  if [ ! -f "$DOCS_DIR/$ref" ]; then
    echo "  ✗ $ref — referenced in SYSTEM-MAP.md but file doesn't exist"
    ORPHANS=$((ORPHANS + 1))
  fi
done < <(grep -oE "decisions/[a-zA-Z0-9_-]+\.md" "$SYSTEM_MAP" 2>/dev/null | sort -u)

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

# Append a table row to a named section. Anchors on the section HEADING (which the
# template guarantees: "## 5. Pattern Index" / "## 6. Decision Index"), inserting the
# row right after the section's markdown table header separator (|---|). The previous
# implementation anchored on a literal sentence ("All pattern docs live in") that does
# NOT exist in the current template, so --fix silently inserted nothing while still
# printing success. Fails loudly (exit 1) if the section heading is absent.
# Usage: insert_row <section-heading-regex> <row-text>
insert_row() {
  local heading="$1" row="$2"
  if ! grep -qE "$heading" "$SYSTEM_MAP"; then
    echo "  ✗ Could not find section heading /$heading/ in SYSTEM-MAP.md — cannot insert row." >&2
    echo "    Add the section manually, then re-run with --fix." >&2
    return 1
  fi
  # Insert after the FIRST table-separator line (|---...) that follows the heading.
  awk -v heading="$heading" -v row="$row" '
    BEGIN { in_sec=0; done=0 }
    {
      print
      if (!done && $0 ~ heading) { in_sec=1; next }
      if (in_sec && !done && $0 ~ /^\|[- :|]+\|[[:space:]]*$/) { print row; done=1; in_sec=0 }
    }
    END { if (!done) exit 3 }
  ' "$SYSTEM_MAP" > "$SYSTEM_MAP.tmp"
  local rc=$?
  if [ $rc -ne 0 ]; then
    rm -f "$SYSTEM_MAP.tmp"
    echo "  ✗ Found section /$heading/ but no table header separator (|---|) beneath it — cannot insert row." >&2
    return 1
  fi
  mv "$SYSTEM_MAP.tmp" "$SYSTEM_MAP"
  return 0
}

# Fix mode: append missing entries
if [ "$FIX_MODE" = true ]; then
  echo "=== Applying Fixes ==="
  echo ""
  FIX_FAILED=0

  if [ ${#MISSING_PATTERNS[@]} -gt 0 ]; then
    echo "Adding ${#MISSING_PATTERNS[@]} pattern entries to SYSTEM-MAP.md..."

    for BASENAME in "${MISSING_PATTERNS[@]}"; do
      NAME=$(echo "$BASENAME" | sed 's/\.md$//' | sed 's/-/ /g')
      if insert_row "^#+[[:space:]].*Pattern Index" "| Work with $NAME | \`patterns/$BASENAME\` |"; then
        echo "  + patterns/$BASENAME → 'Work with $NAME'"
      else
        FIX_FAILED=1
      fi
    done
  fi

  if [ ${#MISSING_DECISIONS[@]} -gt 0 ]; then
    echo "Adding ${#MISSING_DECISIONS[@]} decision entries to SYSTEM-MAP.md..."

    for BASENAME in "${MISSING_DECISIONS[@]}"; do
      NAME=$(echo "$BASENAME" | sed 's/\.md$//' | sed 's/-/ /g')
      if insert_row "^#+[[:space:]].*Decision Index" "| The $NAME approach | \`decisions/$BASENAME\` |"; then
        echo "  + decisions/$BASENAME → 'The $NAME approach'"
      else
        FIX_FAILED=1
      fi
    done
  fi

  echo ""
  if [ "$FIX_FAILED" -ne 0 ]; then
    echo "Some entries could NOT be inserted (see errors above). SYSTEM-MAP.md may be incomplete."
    exit 1
  fi
  echo "Done. Review the auto-generated descriptions and refine them."
  echo "The generated descriptions are generic — replace them with task-oriented phrases."
else
  echo "Run with --fix to add missing entries to SYSTEM-MAP.md"
fi
