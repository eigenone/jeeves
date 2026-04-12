#!/bin/bash
# Setup Jeeves brainstorm mode — no Node.js required
# Usage: bash /path/to/setup-brainstorm.sh [project-dir]
#
# Creates thinking/ directory + rules. That's it.
# No hooks, no scripts, no npm. Just rules that tell the agent what to do.

PROJECT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLKIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# Copy brainstorm rules
cp "$TOOLKIT_DIR/rules/jeeves-brainstorm.md" "$PROJECT/.claude/rules/jeeves-brainstorm.md"
echo "  Copied rules to .claude/rules/jeeves-brainstorm.md"

echo ""
echo "Done! Start a new Claude Code session in $PROJECT."
echo "The agent will read thinking/INDEX.md and capture decisions as you discuss."
echo ""
echo "No hooks or scripts needed. Just talk — Jeeves captures."
