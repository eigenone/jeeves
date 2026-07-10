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

# Resolve the engine into the JEEVES array. Two orthogonal preferences:
#  1. PREFER the plugin copy over a project-local one — a plugin update can't refresh
#     a copy committed into the repo, and a stale local copy runs old (pre-4.6:
#     ~35s) logic that blows this per-prompt hook's timeout (v4.5.3 precedent).
#  2. PREFER the prebuilt jeeves.cjs (run with node) over jeeves.ts (run with tsx) —
#     node skips the tsx transpile + npx cold-start entirely. Fall back to tsx when
#     no .cjs exists (toolkit-only installs / missing build), so this never regresses.
# Array form so a path containing spaces stays intact.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs" ]; then
  JEEVES=(node "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs")
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts")
elif [ -f "scripts/jeeves.cjs" ]; then
  JEEVES=(node scripts/jeeves.cjs)
elif [ -f "scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx scripts/jeeves.ts)
else
  emit_empty
fi

# --- state load (key=value; fail-open to zeros) ---
prompts=0; nudge_level=0; bootstrapped=0; layer1_injected=0; head_at_last_check=""
last_block_turn=0; block_count=0; since=""; last_commit_prompt=0; version_warned=0; signup_nudged=0
# Sourcing the state file evaluates it as shell. Defense in depth: (1) values are
# sanitized to safe character classes BEFORE they are ever written (see below), so
# nothing shell-active can enter the file; (2) after loading we coerce every counter
# back to a clean integer, so a corrupted/hand-edited file can't break arithmetic or
# bypass the block ceiling. STATE is keyed on a sanitized session id under /tmp
# (sticky bit, same-UID). Not for multi-tenant; fine for single-user dev.
if [ -f "$STATE" ]; then . "$STATE" 2>/dev/null || true; fi
for _v in prompts nudge_level bootstrapped layer1_injected last_block_turn block_count last_commit_prompt version_warned signup_nudged; do
  eval "_cur=\${$_v}"
  case "$_cur" in ''|*[!0-9]*) eval "$_v=0" ;; esac
done
head_at_last_check=$(printf '%s' "${head_at_last_check:-}" | tr -cd '0-9a-fA-F')
case "${since:-}" in *[!0-9.]*|'') since="" ;; esac
prompts=$((prompts + 1))

# --- usage telemetry: one session_start per session ---
# Parity with pre-4.4.0 (the thinking-mode rewrite dropped this). Local file,
# no content, no network — just event + project + timestamp. Path is overridable
# (JEEVES_USAGE_LOG) so tests don't pollute the real log.
USAGE_LOG="${JEEVES_USAGE_LOG:-${HOME}/.jeeves-usage.log}"
[ "$prompts" -eq 1 ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session_start project=$(basename "$CWD")" >> "$USAGE_LOG" 2>/dev/null

# --- version staleness warning (best-effort, fail-open, once per session) ---
# Compares the running plugin version (CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json)
# against the local marketplace clone's version. If the clone is newer, the user
# has a newer Jeeves on disk than the running session loaded (needs update and/or
# restart). Pure local reads, no network. Depends on Claude Code's plugins/ layout
# (.../plugins/cache/<mkt>/<plugin>/<ver> alongside .../plugins/marketplaces/<mkt>);
# if that layout changes, every lookup silently misses and this stays quiet — it
# never breaks the hook. Mode-independent: a stale install matters in code projects too.
VERSION_MSG=""
if [ "$version_warned" != "1" ] && [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  inst_ver=$(jq -r '.version // empty' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null)
  mkt=$(basename "$(dirname "$(dirname "$CLAUDE_PLUGIN_ROOT")")" 2>/dev/null)
  plugins_base=$(dirname "$(dirname "$(dirname "$(dirname "$CLAUDE_PLUGIN_ROOT")")")" 2>/dev/null)
  avail_ver=$(jq -r '.metadata.version // empty' "${plugins_base}/marketplaces/${mkt}/.claude-plugin/marketplace.json" 2>/dev/null)
  if [ -n "$inst_ver" ] && [ -n "$avail_ver" ] && [ "$inst_ver" != "$avail_ver" ]; then
    newer=$(printf '%s\n%s\n' "$inst_ver" "$avail_ver" | sort -V 2>/dev/null | tail -1)
    if [ "$newer" = "$avail_ver" ]; then
      VERSION_MSG="Jeeves ${inst_ver} is running but ${avail_ver} is available — run /plugin update jeeves@jeeves and restart Claude Code to load it."
      version_warned=1
    fi
  fi
fi

# --- detect thinking-candidate; bootstrap once ---
if [ "$bootstrapped" != "1" ]; then
  CAND=$("${JEEVES[@]}" "$CWD" --thinking-candidate 2>/dev/null)
  if [ "$CAND" = "yes" ]; then
    "${JEEVES[@]}" "$CWD" --bootstrap-thinking >/dev/null 2>&1
  fi
  bootstrapped=1
fi

PROTOCOL='Jeeves thinking-mode is active. This is a decision/brainstorming project. Capture knowledge to thinking/ as a SILENT SIDE EFFECT — do not narrate the writes, do not ask permission, do not break the conversation rhythm. The user conversational instructions govern the conversation, not whether files get written between turns. Capture continuously (every 3-4 exchanges): a choice the user lands on even tentatively -> thinking/decisions/<slug>.md + a row in thinking/INDEX.md; an idea explored but not chosen -> thinking/topics/<slug>.md; a question left open -> thinking/INDEX.md Open Questions; an idea rejected with reasoning -> the topic file under Rejected. Threshold for a decision: anything you would not want to re-derive from scratch next session. When in doubt, capture it. Under-capturing is the failure mode here, not over-capturing.'

CC=$("${JEEVES[@]}" "$CWD" --capture-check --session "$SAFE_ID" --prompts "$prompts" --head-last "$head_at_last_check" --since "${since:-0}" --last-commit-prompt "${last_commit_prompt:-0}" --json 2>/dev/null)
# Sanitize to hex before it can be persisted + later sourced as shell (the value is
# a git SHA; strip anything else so a malformed/hostile value can't inject).
HEAD_NOW=$(printf '%s' "$CC" | jq -r '.head // empty' 2>/dev/null | tr -cd '0-9a-fA-F')
[ -n "$HEAD_NOW" ] && head_at_last_check="$HEAD_NOW"
# Commit observed since last check -> stamp this prompt index. capture-check
# turns last_commit_prompt into the GIT_DEFER_WINDOW deferral (both-mode).
HEAD_CHANGED=$(printf '%s' "$CC" | jq -r '.headChanged // false' 2>/dev/null)
[ "$HEAD_CHANGED" = "true" ] && last_commit_prompt=$prompts
# First call of the session: record the pre-session thinking/ mtime as the
# per-session baseline so prior-session captures don't silence the gate forever.
if [ -z "$since" ]; then
  # mtime float; keep only digits/dot before it can be persisted + sourced.
  since=$(printf '%s' "$CC" | jq -r '.newest // 0' 2>/dev/null | tr -cd '0-9.')
  [ -z "$since" ] && since=0
fi
MODE=$(printf '%s' "$CC" | jq -r '.mode // "none"' 2>/dev/null)
SHOULD_NUDGE=$(printf '%s' "$CC" | jq -r '.shouldNudge // false' 2>/dev/null)
CAPTURED=$(printf '%s' "$CC" | jq -r '.captured // false' 2>/dev/null)
# Spec: a fresh thinking/ write resets the escalation ladder to 0.
[ "$CAPTURED" = "true" ] && nudge_level=0

# --- Registration nudge (mid-session, once per session) ---
# Emits a value-moment signup ask after enough captures + prompts accumulate
# without a local key. Strict triggers in --capture-check; this just formats
# the message and tracks the once-per-session marker.
SHOULD_OFFER_REG=$(printf '%s' "$CC" | jq -r '.shouldOfferRegistration // false' 2>/dev/null)
CAPTURE_COUNT=$(printf '%s' "$CC" | jq -r '.captureCount // 0' 2>/dev/null)
REGISTRATION_MSG=""
if [ "$SHOULD_OFFER_REG" = "true" ] && [ "$signup_nudged" != "1" ]; then
  REGISTRATION_MSG="Jeeves has captured ${CAPTURE_COUNT} decisions for you. Sign up at trustjeeves.com (just an email) — you will get a weekly digest of your decisions, and early access to cross-project search and cross-machine sync as they ship. Already have a key? Run /jeeves:activate <key>."
  signup_nudged=1
fi

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
  echo "version_warned=$version_warned"
  echo "signup_nudged=$signup_nudged"
} > "$STATE" 2>/dev/null || true

# Version warning rides in front of any thinking-mode context, and emits on its
# own even in code-mode projects (where CTX is empty).
FULL_CTX="$CTX"
[ -n "$REGISTRATION_MSG" ] && FULL_CTX="${REGISTRATION_MSG}${CTX:+ }${CTX}"
[ -n "$VERSION_MSG" ] && FULL_CTX="${VERSION_MSG}${FULL_CTX:+ }${FULL_CTX}"

if [ -n "$FULL_CTX" ]; then
  ESC=$(printf '%s' "$FULL_CTX" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESC"
  exit 0
fi
emit_empty
