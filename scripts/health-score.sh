#!/bin/bash
# health-score.sh — Knowledge Base Health Dashboard
#
# Produces a single health score (0-100) plus a breakdown by category.
#
# Usage: bash scripts/health-score.sh [project-root]
#
# Categories scored:
#   1. Lint pass rate (broken file paths)
#   2. Freshness (docs updated recently vs referenced files)
#   3. Coverage (schema entities documented)
#   4. Completeness (required sections present in docs)
#   5. Audit health (resolved vs total issues)

ROOT="${1:-.}"
DOCS_DIR="$ROOT/docs/internal"

if [ ! -d "$DOCS_DIR" ]; then
  echo "ERROR: No docs/internal/ directory found"
  exit 1
fi

echo "╔══════════════════════════════════════════════╗"
echo "║       KNOWLEDGE BASE HEALTH DASHBOARD       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Project: $(basename $(cd "$ROOT" && pwd))"
echo "Date:    $(date '+%Y-%m-%d %H:%M')"
echo ""

TOTAL_SCORE=0
TOTAL_WEIGHT=0

# ── 1. Structure Score (weight: 15) ───────────────────────────────

STRUCT_SCORE=0
STRUCT_MAX=15

echo "── 1. Structure (/15) ──"

if [ -f "$DOCS_DIR/SYSTEM-MAP.md" ]; then
  echo "  ✓ SYSTEM-MAP.md exists"
  STRUCT_SCORE=$((STRUCT_SCORE + 5))
else
  echo "  ✗ SYSTEM-MAP.md missing"
fi

PATTERN_COUNT=$(find "$DOCS_DIR/patterns" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [ "$PATTERN_COUNT" -ge 5 ]; then
  echo "  ✓ $PATTERN_COUNT pattern docs (≥5)"
  STRUCT_SCORE=$((STRUCT_SCORE + 3))
elif [ "$PATTERN_COUNT" -gt 0 ]; then
  echo "  ~ $PATTERN_COUNT pattern docs (<5)"
  STRUCT_SCORE=$((STRUCT_SCORE + 1))
else
  echo "  ✗ No pattern docs"
fi

DECISION_COUNT=$(find "$DOCS_DIR/decisions" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [ "$DECISION_COUNT" -ge 3 ]; then
  echo "  ✓ $DECISION_COUNT decision docs (≥3)"
  STRUCT_SCORE=$((STRUCT_SCORE + 3))
elif [ "$DECISION_COUNT" -gt 0 ]; then
  echo "  ~ $DECISION_COUNT decision docs (<3)"
  STRUCT_SCORE=$((STRUCT_SCORE + 1))
else
  echo "  ✗ No decision docs"
fi

if [ -f "$DOCS_DIR/codebase-audit.md" ]; then
  echo "  ✓ Codebase audit exists"
  STRUCT_SCORE=$((STRUCT_SCORE + 2))
else
  echo "  ✗ No codebase audit (required — run audit or create with 'all clear')"
fi

if [ -f "$DOCS_DIR/CONCEPT-INDEX.md" ]; then
  echo "  ✓ Concept index exists"
  STRUCT_SCORE=$((STRUCT_SCORE + 1))
else
  echo "  ~ No concept index (optional)"
fi

if [ -f "$DOCS_DIR/context-log.md" ]; then
  echo "  ✓ Context log exists"
  STRUCT_SCORE=$((STRUCT_SCORE + 1))
else
  echo "  ~ No context log (optional)"
fi

echo "  Score: $STRUCT_SCORE/$STRUCT_MAX"
TOTAL_SCORE=$((TOTAL_SCORE + STRUCT_SCORE))
TOTAL_WEIGHT=$((TOTAL_WEIGHT + STRUCT_MAX))

# ── 2. Freshness Score (weight: 25) ──────────────────────────────

FRESH_SCORE=0
FRESH_MAX=25

echo ""
echo "── 2. Freshness (/25) ──"

if git -C "$ROOT" rev-parse --git-dir > /dev/null 2>&1; then
  LAST_DOC_COMMIT=$(git -C "$ROOT" log --format="%ai" -1 -- docs/internal/ 2>/dev/null)
  LAST_CODE_COMMIT=$(git -C "$ROOT" log --format="%ai" -1 -- lib/ app/ apps/ workers/ components/ prisma/ widget/ src/ packages/ server/ services/ 2>/dev/null)

  if [ -n "$LAST_DOC_COMMIT" ] && [ -n "$LAST_CODE_COMMIT" ]; then
    DOC_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S %z" "$LAST_DOC_COMMIT" "+%s" 2>/dev/null || date -d "$LAST_DOC_COMMIT" "+%s" 2>/dev/null || echo "0")
    CODE_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S %z" "$LAST_CODE_COMMIT" "+%s" 2>/dev/null || date -d "$LAST_CODE_COMMIT" "+%s" 2>/dev/null || echo "0")

    if [ "$DOC_EPOCH" != "0" ] && [ "$CODE_EPOCH" != "0" ]; then
      DIFF_DAYS=$(( (CODE_EPOCH - DOC_EPOCH) / 86400 ))
      if [ "$DIFF_DAYS" -le 0 ]; then
        echo "  ✓ Docs are newer than code (up to date)"
        FRESH_SCORE=25
      elif [ "$DIFF_DAYS" -le 7 ]; then
        echo "  ✓ Docs are $DIFF_DAYS days behind code (fresh)"
        FRESH_SCORE=20
      elif [ "$DIFF_DAYS" -le 30 ]; then
        echo "  ~ Docs are $DIFF_DAYS days behind code (aging)"
        FRESH_SCORE=12
      else
        echo "  ✗ Docs are $DIFF_DAYS days behind code (stale)"
        FRESH_SCORE=5
      fi
    else
      echo "  ? Could not parse dates"
      FRESH_SCORE=12
    fi
  else
    echo "  ? No git history for docs or code"
    FRESH_SCORE=12
  fi

  # Check how many code files changed since last doc update
  CHANGED_FILES=$(git -C "$ROOT" diff --name-only $(git -C "$ROOT" log --format="%H" -1 -- docs/internal/ 2>/dev/null)..HEAD -- lib/ app/ apps/ workers/ components/ prisma/ widget/ src/ packages/ server/ services/ 2>/dev/null | wc -l | tr -d ' ')
  echo "  $CHANGED_FILES code files changed since last doc update"
else
  echo "  ? Not a git repo — cannot assess freshness"
  FRESH_SCORE=12
fi

echo "  Score: $FRESH_SCORE/$FRESH_MAX"
TOTAL_SCORE=$((TOTAL_SCORE + FRESH_SCORE))
TOTAL_WEIGHT=$((TOTAL_WEIGHT + FRESH_MAX))

# ── 3. Completeness Score (weight: 25) ───────────────────────────

COMP_SCORE=0
COMP_MAX=25

echo ""
echo "── 3. Completeness (/25) ──"

# Check system map has all 7 sections
if [ -f "$DOCS_DIR/SYSTEM-MAP.md" ]; then
  SECTIONS=$(grep -c "^## " "$DOCS_DIR/SYSTEM-MAP.md" 2>/dev/null || echo "0")
  if [ "$SECTIONS" -ge 7 ]; then
    echo "  ✓ System map has all 7 sections"
    COMP_SCORE=$((COMP_SCORE + 5))
  else
    echo "  ~ System map has $SECTIONS/7 sections"
    COMP_SCORE=$((COMP_SCORE + 2))
  fi

  # Check for (TODO) entries
  TODOS=$(grep -c "(TODO)" "$DOCS_DIR/SYSTEM-MAP.md" 2>/dev/null | tr -d '[:space:]' || echo "0")
  if [ "$TODOS" -eq 0 ]; then
    echo "  ✓ No (TODO) entries in system map"
    COMP_SCORE=$((COMP_SCORE + 5))
  else
    echo "  ✗ $TODOS (TODO) entries remain in system map"
  fi
fi

# Check pattern docs have Gotchas sections
PATTERNS_WITH_GOTCHAS=0
for f in "$DOCS_DIR/patterns/"*.md; do
  [ -f "$f" ] || continue
  if grep -q "## Gotchas\|## Gotcha" "$f" 2>/dev/null; then
    PATTERNS_WITH_GOTCHAS=$((PATTERNS_WITH_GOTCHAS + 1))
  fi
done

if [ "$PATTERN_COUNT" -gt 0 ]; then
  GOTCHA_PCT=$((PATTERNS_WITH_GOTCHAS * 100 / PATTERN_COUNT))
  if [ "$GOTCHA_PCT" -ge 80 ]; then
    echo "  ✓ $GOTCHA_PCT% of pattern docs have Gotchas section"
    COMP_SCORE=$((COMP_SCORE + 5))
  elif [ "$GOTCHA_PCT" -ge 50 ]; then
    echo "  ~ $GOTCHA_PCT% of pattern docs have Gotchas section"
    COMP_SCORE=$((COMP_SCORE + 3))
  else
    echo "  ✗ Only $GOTCHA_PCT% of pattern docs have Gotchas section"
    COMP_SCORE=$((COMP_SCORE + 1))
  fi
fi

# Check CLAUDE.md integration
CLAUDE_FILE=""
for candidate in "$ROOT/CLAUDE.md" "$ROOT/claude.md"; do
  if [ -f "$candidate" ]; then
    CLAUDE_FILE="$candidate"
    break
  fi
done

if [ -n "$CLAUDE_FILE" ]; then
  if grep -q "SYSTEM-MAP" "$CLAUDE_FILE" 2>/dev/null; then
    echo "  ✓ CLAUDE.md points to system map"
    COMP_SCORE=$((COMP_SCORE + 5))
  else
    echo "  ✗ CLAUDE.md exists but doesn't reference system map"
    COMP_SCORE=$((COMP_SCORE + 1))
  fi

  if grep -q "File It Back\|file it back\|file-it-back" "$CLAUDE_FILE" 2>/dev/null; then
    echo "  ✓ CLAUDE.md has 'file it back' rule"
    COMP_SCORE=$((COMP_SCORE + 5))
  else
    echo "  ✗ CLAUDE.md missing 'file it back' rule"
  fi
else
  echo "  ✗ No CLAUDE.md found"
fi

echo "  Score: $COMP_SCORE/$COMP_MAX"
TOTAL_SCORE=$((TOTAL_SCORE + COMP_SCORE))
TOTAL_WEIGHT=$((TOTAL_WEIGHT + COMP_MAX))

# ── 4. Audit Health (weight: 20) ─────────────────────────────────

AUDIT_SCORE=0
AUDIT_MAX=20

echo ""
echo "── 4. Audit Health (/20) ──"

if [ ! -f "$DOCS_DIR/codebase-audit.md" ]; then
  echo "  ✗ No audit file (required — run audit or create with 'all clear')"
  AUDIT_SCORE=0
elif [ -f "$DOCS_DIR/codebase-audit.md" ]; then
  CRITICAL=$(grep -c "^### .*Critical\|^### .*CRITICAL" "$DOCS_DIR/codebase-audit.md" 2>/dev/null | tr -d '[:space:]' || echo "0")
  IMPORTANT=$(grep -c "^### [0-9]" "$DOCS_DIR/codebase-audit.md" 2>/dev/null | tr -d '[:space:]' || echo "0")
  RESOLVED=$(grep -c "^|.*|.*|.*|" "$DOCS_DIR/codebase-audit.md" 2>/dev/null | tr -d '[:space:]' || echo "0")
  # Subtract header row and empty row
  RESOLVED=$((RESOLVED > 2 ? RESOLVED - 2 : 0))

  TOTAL_ISSUES=$((CRITICAL + IMPORTANT))
  echo "  Issues: ~$TOTAL_ISSUES total, ~$RESOLVED resolved"

  if [ "$TOTAL_ISSUES" -gt 0 ]; then
    if [ "$CRITICAL" -eq 0 ]; then
      echo "  ✓ No critical issues"
      AUDIT_SCORE=$((AUDIT_SCORE + 10))
    else
      echo "  ✗ $CRITICAL critical issues remain"
      AUDIT_SCORE=$((AUDIT_SCORE + 2))
    fi

    if [ "$RESOLVED" -gt 0 ]; then
      echo "  ✓ Resolved table has entries (audit is maintained)"
      AUDIT_SCORE=$((AUDIT_SCORE + 10))
    else
      echo "  ~ No resolved entries yet"
      AUDIT_SCORE=$((AUDIT_SCORE + 5))
    fi
  else
    if [ "$RESOLVED" -gt 0 ]; then
      echo "  ✓ All issues resolved ($RESOLVED fixed)"
      AUDIT_SCORE=20
    else
      echo "  ? No issues found (audit may not have been run)"
      AUDIT_SCORE=10
    fi
  fi
fi

echo "  Score: $AUDIT_SCORE/$AUDIT_MAX"
TOTAL_SCORE=$((TOTAL_SCORE + AUDIT_SCORE))
TOTAL_WEIGHT=$((TOTAL_WEIGHT + AUDIT_MAX))

# ── 5. Lint Score (weight: 15) ────────────────────────────────────

LINT_SCORE=0
LINT_MAX=15

echo ""
echo "── 5. Lint (/15) ──"

if [ -f "$ROOT/scripts/lint-docs.ts" ]; then
  echo "  ✓ Lint script exists"
  LINT_SCORE=$((LINT_SCORE + 5))

  # Try running it
  LINT_OUTPUT=$(npx tsx "$ROOT/scripts/lint-docs.ts" 2>&1)
  LINT_EXIT=$?

  if [ $LINT_EXIT -eq 0 ]; then
    echo "  ✓ Lint passes cleanly"
    LINT_SCORE=$((LINT_SCORE + 10))
  else
    LINT_ERRORS=$(echo "$LINT_OUTPUT" | grep -c "✗\|FAIL\|ERROR" 2>/dev/null || echo "?")
    echo "  ✗ Lint has errors ($LINT_ERRORS issues)"
    LINT_SCORE=$((LINT_SCORE + 2))
  fi
elif [ -f "$ROOT/scripts/heal-docs.ts" ]; then
  echo "  ✓ Heal script exists (no separate lint)"
  LINT_SCORE=$((LINT_SCORE + 5))
else
  echo "  ✗ No lint or heal script"
fi

echo "  Score: $LINT_SCORE/$LINT_MAX"
TOTAL_SCORE=$((TOTAL_SCORE + LINT_SCORE))
TOTAL_WEIGHT=$((TOTAL_WEIGHT + LINT_MAX))

# ── Final Score ───────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════╗"
FINAL_PCT=$((TOTAL_SCORE * 100 / TOTAL_WEIGHT))

if [ "$FINAL_PCT" -ge 90 ]; then
  GRADE="A"
  STATUS="Excellent"
elif [ "$FINAL_PCT" -ge 75 ]; then
  GRADE="B"
  STATUS="Good"
elif [ "$FINAL_PCT" -ge 60 ]; then
  GRADE="C"
  STATUS="Needs Work"
elif [ "$FINAL_PCT" -ge 40 ]; then
  GRADE="D"
  STATUS="Poor"
else
  GRADE="F"
  STATUS="Critical"
fi

printf "║  HEALTH SCORE: %3d/100  (%s — %s)       ║\n" "$FINAL_PCT" "$GRADE" "$STATUS"
echo "╠══════════════════════════════════════════════╣"
printf "║  Structure:    %2d/15                        ║\n" "$STRUCT_SCORE"
printf "║  Freshness:    %2d/25                        ║\n" "$FRESH_SCORE"
printf "║  Completeness: %2d/25                        ║\n" "$COMP_SCORE"
printf "║  Audit Health: %2d/20                        ║\n" "$AUDIT_SCORE"
printf "║  Lint:         %2d/15                        ║\n" "$LINT_SCORE"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Recommendations
echo "Recommendations:"
if [ "$STRUCT_SCORE" -lt 10 ]; then echo "  → Add more pattern/decision docs (run full bootstrap)"; fi
if [ "$FRESH_SCORE" -lt 15 ]; then echo "  → Run incremental update (detect-changes.sh → prompts/11)"; fi
if [ "$COMP_SCORE" -lt 15 ]; then echo "  → Run quality gate (prompts/10) and fix gaps"; fi
if [ "$AUDIT_SCORE" -lt 10 ]; then echo "  → Run codebase audit (prompts/05) or resolve existing issues"; fi
if [ "$LINT_SCORE" -lt 10 ]; then echo "  → Fix lint errors (npx tsx scripts/lint-docs.ts)"; fi
if [ "$FINAL_PCT" -ge 90 ]; then echo "  → Knowledge base is healthy. Keep filing back!"; fi
