#!/bin/bash
# Jeeves thinking-capture-gate — Stop hook. Layer 3 thinking salvage block +
# session-END memory hygiene banner (v4.11.0).
# Fail-open invariant: ANY error/parse failure -> allow the stop (echo '{}').
INPUT=$(cat 2>/dev/null)
# SYSMSG, when set, rides out on the (non-blocking) allow path as a top-level
# systemMessage — a user-facing banner, independent of decision. Used for the
# end-of-session memory-hygiene nudge. Empty -> plain '{}'.
SYSMSG=""
allow() {
  if [ -n "$SYSMSG" ]; then
    OUT=$(printf '%s' "$SYSMSG" | jq -Rsc '{systemMessage:.}' 2>/dev/null)
    [ -n "$OUT" ] && { printf '%s\n' "$OUT"; exit 0; }
  fi
  echo '{}'; exit 0
}

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

# Resolve the engine (see session-check.sh for the full rationale): prefer the plugin
# copy over a stale project-local one, and prefer the prebuilt jeeves.cjs (node) over
# jeeves.ts (tsx). Array form is space-safe; fall back to tsx when no .cjs exists.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs" ]; then
  JEEVES=(node "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs")
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts")
elif [ -f "scripts/jeeves.cjs" ]; then
  JEEVES=(node scripts/jeeves.cjs)
elif [ -f "scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx scripts/jeeves.ts)
else
  allow
fi

prompts=0; last_block_turn=0; block_count=0; head_at_last_check=""; since=""; last_commit_prompt=0
if [ -f "$STATE" ]; then . "$STATE" 2>/dev/null || true; fi
# Coerce counters to clean integers after sourcing — a corrupt/hand-edited value must
# not break the arithmetic below or let the block ceiling be bypassed.
for _v in prompts last_block_turn block_count last_commit_prompt; do
  eval "_cur=\${$_v}"
  case "$_cur" in ''|*[!0-9]*) eval "$_v=0" ;; esac
done
turn=$prompts

# --- Session-END memory hygiene (v4.11.0, D2) ---
# The Stop hook is the closest thing to "session end" that can surface anything. When the
# memory/ store has drifted (stale-dated / near-dup / broken links / oversized), emit a
# user-facing systemMessage banner so the prune ask lands when work is winding down, NOT on
# the opening prompt (session-check deliberately does not carry hygiene). At most once per
# session via a sentinel file (independent of session-check's state, which it overwrites
# every prompt). Non-blocking: the banner rides the allow path; capture is opportunistic and
# an empty/tidy memory is the common, correct case — this never blocks the stop.
MEMHYG_MARK="${STATE}-memhyg"
if [ -d "$CWD/memory" ] && [ ! -f "$MEMHYG_MARK" ]; then
  touch "$MEMHYG_MARK" 2>/dev/null || true
  MC=$("${JEEVES[@]}" "$CWD" --memory-check --json 2>/dev/null)
  if printf '%s' "$MC" | jq -e . >/dev/null 2>&1 && [ "$(printf '%s' "$MC" | jq -r '.reviewDue // false' 2>/dev/null)" = "true" ]; then
    MREASON=$(printf '%s' "$MC" | jq -r '.reason // empty' 2>/dev/null)
    SYSMSG="Jeeves memory hygiene (${MREASON}): memory/ could use a prune — delete entries no longer true, merge overlapping/near-duplicate ones, re-verify stale-dated ones, fix broken [[links]]. Run /jeeves:memory or just ask. Memory is ephemeral."
  fi
fi

# Use the per-session baseline + last-commit index recorded by session-check
# (Layer 1/2). The gate never observes commits itself (session-check runs every
# prompt and owns that); it just passes the recorded value so deferForGit is
# consistent between the nudge and the gate. If the gate somehow fires before
# session-check ran (no state), since="" -> 0 and last_commit_prompt=0 (no
# deferral) — conservative defaults.
CC=$("${JEEVES[@]}" "$CWD" --capture-check --session "$SAFE_ID" --prompts "$prompts" --head-last "$head_at_last_check" --since "${since:-0}" --last-commit-prompt "${last_commit_prompt:-0}" --json 2>/dev/null)
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
