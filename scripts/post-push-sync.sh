#!/bin/bash
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only real `git push`. Skip non-push, dry-runs, and incidental mentions
# (`echo "git push"`) — a loose match marked actions "seen" on non-pushes,
# suppressing them on the next real push.
case "$COMMAND" in
  *--dry-run*) echo '{}'; exit 0 ;;
esac
printf '%s' "$COMMAND" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)' || { echo '{}'; exit 0; }

# Skip if the push itself failed — otherwise we'd persist the current action set as
# "seen" and never surface it after the user fixes the push and retries.
TOOL_OK=$(printf '%s' "$INPUT" | jq -r '(.tool_response.success // .tool_response.exit_code // empty)' 2>/dev/null)
case "$TOOL_OK" in false|[1-9]*) echo '{}'; exit 0 ;; esac

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post_push project=$(basename "$(pwd)")" >> "${HOME}/.jeeves-usage.log" 2>/dev/null

# Prefer the plugin's jeeves.ts over a stale project-local copy (see session-check.sh
# for rationale; a stale local copy can be ~35s and blow this hook's timeout).
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts" ]; then
  JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
else
  JEEVES_SCRIPT="scripts/jeeves.ts"
fi
[ -f "$JEEVES_SCRIPT" ] || { echo '{}'; exit 0; }

# Structured actions (report-only: --stale returns before the sync auto-heal).
JSON=$(npx tsx "$JEEVES_SCRIPT" --stale --json 2>/dev/null)
[ -z "$JSON" ] && { echo '{}'; exit 0; }

# Stable signature per action (type|target|priority) — deliberately excludes the
# volatile commit-message preview so unchanged items don't re-read as "new".
CUR_SIGS=$(printf '%s' "$JSON" | jq -r '.actions[]? | "\(.type)|\(.target)|\(.priority)"' 2>/dev/null)

# Synthetic per-doc signatures for docs listed in SYSTEM-MAP unindexed actions.
# A SYSTEM-MAP action accumulates multiple docs into one action with a stable
# aggregate signature; individual new docs would be invisible without this expansion.
UNINDEXED_SIGS=$(printf '%s' "$JSON" | jq -r '
  .actions[]? | select(.target | endswith("SYSTEM-MAP.md"))
  | .description | ltrimstr("Add ") | split(": ") | last | split(", ")[]
  | "unindexed|\(.)|medium"' 2>/dev/null || true)

# Merge action sigs and per-doc sigs into the full current set.
ALL_CUR_SIGS=$(printf '%s\n%s\n' "$CUR_SIGS" "$UNINDEXED_SIGS")

STATE_DIR=$(git rev-parse --git-dir 2>/dev/null)
STATE_FILE="${STATE_DIR:-.}/jeeves-push-state"
PREV_SIGS=""; [ -f "$STATE_FILE" ] && PREV_SIGS=$(cat "$STATE_FILE" 2>/dev/null)

# Persist current set for next push (always, even if nothing new to show).
printf '%s\n' "$ALL_CUR_SIGS" > "$STATE_FILE" 2>/dev/null || true

# New or newly-escalated = signatures present now but not last push.
NEW_SIGS=$(comm -23 <(printf '%s\n' "$ALL_CUR_SIGS" | sort -u) <(printf '%s\n' "$PREV_SIGS" | sort -u) | grep -v '^$' || true)
[ -z "$NEW_SIGS" ] && { echo '{}'; exit 0; }

# Render: regular actions (from jeeves JSON) + synthetic unindexed-doc lines.
ACTIONS_FROM_JSON=$(printf '%s' "$JSON" | jq -r --arg sigs "$NEW_SIGS" '
  ($sigs | split("\n") | map(select(length>0))) as $new
  | .actions[]? | select(("\(.type)|\(.target)|\(.priority)") as $s | ($new | index($s)))
  | "ACTION [\(.type)] \(.priority): \(.description) → \(.target)"' 2>/dev/null || true)

# Synthetic lines for newly-appearing unindexed docs (unindexed|<doc>|medium).
ACTIONS_UNINDEXED=$(printf '%s\n' "$NEW_SIGS" | grep '^unindexed|' \
  | awk -F'|' '{print "ACTION [unindexed] medium: Add to SYSTEM-MAP → " $2}' 2>/dev/null || true)

ACTIONS=$(printf '%s\n%s\n' "$ACTIONS_FROM_JSON" "$ACTIONS_UNINDEXED" \
  | grep -v '^$' | head -10 | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
NEW_COUNT=$(printf '%s\n' "$NEW_SIGS" | grep -vc '^$' || echo 0)

[ -z "$ACTIONS" ] && { echo '{}'; exit 0; }
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just pushed. Jeeves found %s NEW or newly-escalated doc action(s) since your last push. Actions: %s"}}\n' "$NEW_COUNT" "$ACTIONS"
exit 0
