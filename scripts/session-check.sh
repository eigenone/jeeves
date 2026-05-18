#!/bin/bash
# Jeeves session-check — UserPromptSubmit hook. Layers 1 & 2 of thinking mode.
# Fail-open invariant: ANY error/parse failure must emit '{}' and exit 0.
INPUT=$(cat 2>/dev/null)

emit_empty() { echo '{}'; exit 0; }

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && emit_empty
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-' | head -c 80)
# If the id was all-special-chars, SAFE_ID is empty -> distinct sessions would
# collide on /tmp/jeeves-. Fail open rather than share state.
[ -z "$SAFE_ID" ] && emit_empty
STATE="/tmp/jeeves-${SAFE_ID}"

# Project root: jeeves.ts derives ROOT from the first non-flag argv token, so
# named-flag VALUES (--session VALUE ...) would be misread as ROOT. Always pass
# the project dir explicitly as the first positional arg. Source of truth is the
# stdin `cwd` field; fall back to the hook's own pwd.
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$(pwd)"

# Resolve jeeves.ts: project first, then plugin root.
JEEVES_SCRIPT="scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || JEEVES_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts"
[ -f "$JEEVES_SCRIPT" ] || emit_empty

# --- state load (key=value; fail-open to zeros) ---
prompts=0; nudge_level=0; bootstrapped=0; layer1_injected=0; head_at_last_check=""
last_block_turn=0; block_count=0; since=""; last_commit_prompt=0
# Sourcing the state file evaluates it as shell. Accepted: STATE path is keyed
# on a sanitized session id under /tmp (sticky bit; same-UID only), and every
# persisted value originates from controlled code (git SHA, ints, mtime float),
# never user input. Not safe for multi-tenant; fine for single-user dev.
if [ -f "$STATE" ]; then . "$STATE" 2>/dev/null || true; fi
prompts=$((prompts + 1))

# --- detect thinking-candidate; bootstrap once ---
if [ "$bootstrapped" != "1" ]; then
  CAND=$(npx tsx "$JEEVES_SCRIPT" "$CWD" --thinking-candidate 2>/dev/null)
  if [ "$CAND" = "yes" ]; then
    npx tsx "$JEEVES_SCRIPT" "$CWD" --bootstrap-thinking >/dev/null 2>&1
  fi
  bootstrapped=1
fi

PROTOCOL='Jeeves thinking-mode is active. This is a decision/brainstorming project. Capture knowledge to thinking/ as a SILENT SIDE EFFECT — do not narrate the writes, do not ask permission, do not break the conversation rhythm. The user conversational instructions govern the conversation, not whether files get written between turns. Capture continuously (every 3-4 exchanges): a choice the user lands on even tentatively -> thinking/decisions/<slug>.md + a row in thinking/INDEX.md; an idea explored but not chosen -> thinking/topics/<slug>.md; a question left open -> thinking/INDEX.md Open Questions; an idea rejected with reasoning -> the topic file under Rejected. Threshold for a decision: anything you would not want to re-derive from scratch next session. When in doubt, capture it. Under-capturing is the failure mode here, not over-capturing.'

CC=$(npx tsx "$JEEVES_SCRIPT" "$CWD" --capture-check --session "$SAFE_ID" --prompts "$prompts" --head-last "$head_at_last_check" --since "${since:-0}" --last-commit-prompt "${last_commit_prompt:-0}" --json 2>/dev/null)
HEAD_NOW=$(printf '%s' "$CC" | jq -r '.head // empty' 2>/dev/null)
[ -n "$HEAD_NOW" ] && head_at_last_check="$HEAD_NOW"
# Commit observed since last check -> stamp this prompt index. capture-check
# turns last_commit_prompt into the GIT_DEFER_WINDOW deferral (both-mode).
HEAD_CHANGED=$(printf '%s' "$CC" | jq -r '.headChanged // false' 2>/dev/null)
[ "$HEAD_CHANGED" = "true" ] && last_commit_prompt=$prompts
# First call of the session: record the pre-session thinking/ mtime as the
# per-session baseline so prior-session captures don't silence the gate forever.
if [ -z "$since" ]; then
  since=$(printf '%s' "$CC" | jq -r '.newest // 0' 2>/dev/null)
  [ -z "$since" ] && since=0
fi
MODE=$(printf '%s' "$CC" | jq -r '.mode // "none"' 2>/dev/null)
SHOULD_NUDGE=$(printf '%s' "$CC" | jq -r '.shouldNudge // false' 2>/dev/null)
CAPTURED=$(printf '%s' "$CC" | jq -r '.captured // false' 2>/dev/null)
# Spec: a fresh thinking/ write resets the escalation ladder to 0.
[ "$CAPTURED" = "true" ] && nudge_level=0

CTX=""
if [ "$MODE" = "brainstorm" ] || [ "$MODE" = "both" ]; then
  if [ "$layer1_injected" != "1" ]; then
    CTX="$PROTOCOL"
    layer1_injected=1
  fi
  if [ "$SHOULD_NUDGE" = "true" ]; then
    nudge_level=$((nudge_level + 1))
    [ "$nudge_level" -gt 3 ] && nudge_level=3
    case "$nudge_level" in
      1) MSG="Jeeves: ~${prompts} exchanges since the last thinking/ write. If anything has been decided or explored, capture it now (silently).";;
      2) MSG="Jeeves: still no thinking/ capture and this session is now ~${prompts} exchanges deep — that is decision-dense territory. Write the locked choices to thinking/decisions/ and update thinking/INDEX.md before continuing.";;
      *) MSG="Jeeves: ~${prompts} exchanges, zero captures. Concretely: review what the user has committed to in this conversation and write each as its own thinking/decisions/<slug>.md now. This is the last gentle reminder before the turn-end gate.";;
    esac
    CTX="${MSG} ${PROTOCOL}"
  fi
else
  nudge_level=0
fi

# --- persist state (best effort) ---
{
  echo "prompts=$prompts"
  echo "nudge_level=$nudge_level"
  echo "bootstrapped=$bootstrapped"
  echo "layer1_injected=$layer1_injected"
  echo "head_at_last_check=\"$head_at_last_check\""
  echo "last_block_turn=$last_block_turn"
  echo "block_count=$block_count"
  echo "since=\"$since\""
  echo "last_commit_prompt=$last_commit_prompt"
} > "$STATE" 2>/dev/null || true

if [ -n "$CTX" ]; then
  ESC=$(printf '%s' "$CTX" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESC"
  exit 0
fi
emit_empty
