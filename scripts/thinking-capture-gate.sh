#!/bin/bash
# Jeeves thinking-capture-gate — Stop hook. Layer 3 salvage block.
# Fail-open invariant: ANY error/parse failure -> allow the stop (echo '{}').
INPUT=$(cat 2>/dev/null)
allow() { echo '{}'; exit 0; }

BLOCK_DEBOUNCE=4
BLOCK_CEILING=3

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && allow
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-' | head -c 80)
# Parity with session-check: empty SAFE_ID would collide on /tmp/jeeves- and
# share debounce/ceiling counters across sessions. Fail open.
[ -z "$SAFE_ID" ] && allow
STATE="/tmp/jeeves-${SAFE_ID}"

# Project root passed explicitly (jeeves.ts misreads flag VALUES as ROOT).
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$(pwd)"

# Prefer the plugin's jeeves.ts over a stale project-local copy (see session-check.sh
# for rationale; a stale local copy can be ~35s and blow this hook's timeout).
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts" ]; then
  JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
else
  JEEVES_SCRIPT="scripts/jeeves.ts"
fi
[ -f "$JEEVES_SCRIPT" ] || allow

prompts=0; last_block_turn=0; block_count=0; head_at_last_check=""; since=""; last_commit_prompt=0
if [ -f "$STATE" ]; then . "$STATE" 2>/dev/null || true; fi
turn=$prompts

# Use the per-session baseline + last-commit index recorded by session-check
# (Layer 1/2). The gate never observes commits itself (session-check runs every
# prompt and owns that); it just passes the recorded value so deferForGit is
# consistent between the nudge and the gate. If the gate somehow fires before
# session-check ran (no state), since="" -> 0 and last_commit_prompt=0 (no
# deferral) — conservative defaults.
CC=$(npx tsx "$JEEVES_SCRIPT" "$CWD" --capture-check --session "$SAFE_ID" --prompts "$prompts" --head-last "$head_at_last_check" --since "${since:-0}" --last-commit-prompt "${last_commit_prompt:-0}" --json 2>/dev/null)
[ -z "$CC" ] && allow
SHOULD_BLOCK=$(printf '%s' "$CC" | jq -r '.shouldBlock // false' 2>/dev/null)
[ "$SHOULD_BLOCK" != "true" ] && allow

# ceiling
[ "$block_count" -ge "$BLOCK_CEILING" ] && allow
# debounce: not within BLOCK_DEBOUNCE turns of last block, never consecutive
if [ "$last_block_turn" -gt 0 ]; then
  delta=$((turn - last_block_turn))
  [ "$delta" -lt "$BLOCK_DEBOUNCE" ] && allow
fi

block_count=$((block_count + 1))
last_block_turn=$turn
# Persist the incremented counter BEFORE emitting the block. If persistence
# fails (mktemp/mv), allow instead of emitting — emitting a block whose
# increment was lost would let the ceiling be exceeded (a 4th, 5th... block).
# The safe failure direction for a user-blocking hook is to let the user pass.
TMP=$(mktemp 2>/dev/null) || allow
if [ -f "$STATE" ]; then grep -vE '^(block_count|last_block_turn)=' "$STATE" 2>/dev/null > "$TMP"; fi
echo "block_count=$block_count" >> "$TMP"
echo "last_block_turn=$last_block_turn" >> "$TMP"
mv "$TMP" "$STATE" 2>/dev/null || { rm -f "$TMP"; allow; }

REASON='Before finishing: this thinking session has substance but thinking/ is empty. Review the conversation and write every choice the user landed on — even tentative ones — as thinking/decisions/<slug>.md, plus update thinking/INDEX.md. The bar is low: capture anything you would not want to re-derive next session. If — and only if — the conversation genuinely contained no decisions, proposals, or open questions, create thinking/sessions/<date>.md containing exactly the line: "No decisions, proposals, or open questions arose this session." Write it silently, then finish.'
ESC=$(printf '%s' "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
printf '{"decision":"block","reason":"%s"}\n' "$ESC"
exit 0
