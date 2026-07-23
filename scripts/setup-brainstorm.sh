#!/bin/bash
# Setup Jeeves brainstorm mode — no Node.js required
# Usage: bash /path/to/setup-brainstorm.sh [project-dir]
#
# Creates thinking/ directory + rules. That's it.
# No hooks, no scripts, no npm. Just rules that tell the agent what to do.
#
# NOTE: no `set -e` on purpose (fail-open house rule) — but the rules copy IS
# guarded explicitly below (it's the whole point of the script), so a missing
# source exits non-zero with a clear message instead of the old silent stderr
# failure that still printed "Done!".

PROJECT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLKIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve the brainstorm rules file across BOTH install layouts:
#   toolkit layout:  toolkit/scripts/setup-brainstorm.sh + toolkit/rules/jeeves-brainstorm.md
#   plugin  layout:  plugin/scripts/setup-brainstorm.sh  + plugin/scripts/jeeves-brainstorm.md
#                    (the release ships the rule alongside the script; there is no plugin/rules/)
RULES_SRC=""
for cand in \
  "$TOOLKIT_DIR/rules/jeeves-brainstorm.md" \
  "$SCRIPT_DIR/jeeves-brainstorm.md" \
  "${CLAUDE_PLUGIN_ROOT:-}/scripts/jeeves-brainstorm.md" \
  "${CLAUDE_PLUGIN_ROOT:-}/rules/jeeves-brainstorm.md"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { RULES_SRC="$cand"; break; }
done

if [ -z "$RULES_SRC" ]; then
  echo "✗ Could not find jeeves-brainstorm.md (looked in toolkit/rules/, alongside this script, and \$CLAUDE_PLUGIN_ROOT)." >&2
  echo "  Cannot set up brainstorm mode without the rules file. Aborting." >&2
  exit 1
fi

echo "Setting up Jeeves brainstorm mode in: $PROJECT"

# Create directories
mkdir -p "$PROJECT/thinking/sessions" \
         "$PROJECT/thinking/topics" \
         "$PROJECT/thinking/decisions" \
         "$PROJECT/.claude/rules"

# Create INDEX.md if it doesn't exist
if [ ! -f "$PROJECT/thinking/INDEX.md" ]; then
  cat > "$PROJECT/thinking/INDEX.md" << 'INDEXEOF'
# Thinking Index

**Last session:** (none yet)

## Active Topics
| Topic | File | Status | Last updated |
|-------|------|--------|-------------|

## Key Decisions
| Decision | Date | File |
|----------|------|------|

## Open Questions
| Question | Raised | Blocking? |
|----------|--------|-----------|
INDEXEOF
  echo "  Created thinking/INDEX.md"
fi

# Copy brainstorm rules (source verified above)
if ! cp "$RULES_SRC" "$PROJECT/.claude/rules/jeeves-brainstorm.md"; then
  echo "✗ Failed to copy rules to $PROJECT/.claude/rules/jeeves-brainstorm.md" >&2
  exit 1
fi
echo "  Copied rules to .claude/rules/jeeves-brainstorm.md"

echo ""
echo "Done! Start a new Claude Code session in $PROJECT."
echo "The agent will read thinking/INDEX.md and capture decisions as you discuss."
echo ""
echo "No hooks or scripts needed. Just talk — Jeeves captures."
