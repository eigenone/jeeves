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

# The user's current prompt (UserPromptSubmit stdin carries it). Used to prompt-score
# memory relevance. Flatten whitespace and cap length — it is passed as an argv value to
# the engine, so keep it single-line and bounded (a huge prompt would bloat the spawn).
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null | tr '\n\r\t' '   ' | head -c 500)

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
last_block_turn=0; block_count=0; since=""; last_commit_prompt=0; version_warned=0; signup_nudged=0; memory_injected=0; memory_protocol_injected=0; kb_offered=0; kb_core_injected=0
# Load state SAFELY by PARSING key=value — never `source` it (v4.14.0). Sourcing a /tmp file
# executes any `$(...)`/backticks in a corrupt or tampered value at read time, before the
# coercion below can run. Here only WHITELISTED keys are assigned, and `eval "$k=\$v"` binds
# the LITERAL value (parameter expansion does not re-run command substitution on it). Counters
# are still coerced to clean integers afterwards. STATE is keyed on a sanitized session id
# under /tmp (sticky bit, same-UID); single-user dev, not multi-tenant.
if [ -f "$STATE" ]; then
  while IFS='=' read -r _k _v || [ -n "$_k" ]; do
    case "$_k" in
      prompts|nudge_level|bootstrapped|layer1_injected|head_at_last_check|last_block_turn|block_count|since|last_commit_prompt|version_warned|signup_nudged|memory_injected|memory_protocol_injected|kb_offered|kb_core_injected)
        _v="${_v%\"}"; _v="${_v#\"}"; eval "$_k=\$_v" ;;
    esac
  done < "$STATE" 2>/dev/null || true
fi
for _v in prompts nudge_level bootstrapped layer1_injected last_block_turn block_count last_commit_prompt version_warned signup_nudged memory_injected memory_protocol_injected kb_offered kb_core_injected; do
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

# Memory capture protocol (D1) — mirrors thinking-mode Layer 1 (silent side-effect), but
# capture is OPPORTUNISTIC: memory-worthy events are rare, so there is NO empty-memory gate
# (most sessions legitimately add nothing). This is the write path — without it memory/ is
# read-only and never grows (the finance-style capture failure, applied to memory).
MEMORY_PROTOCOL='Jeeves memory is active. When the user reveals something DURABLE about how to work with THEM or THIS repo — a stated preference, a correction of your approach, how they want answers/output, or a stable setup/reference fact — capture it SILENTLY (do not narrate, do not ask permission): write memory/<type>_<slug>.md with frontmatter name, description, metadata.type = user|feedback|reference, and created + confirmed dates (today), then add a one-line pointer under the matching section of memory/MEMORY.md. Capture is OPPORTUNISTIC — only cross-session facts about the user/repo, NOT this task code details (those belong in the code KB). Before adding, check MEMORY.md for an existing entry to UPDATE (bump its confirmed date) instead of duplicating. Under-capturing durable prefs is the failure mode; a correction the user repeats twice is a memory.'

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
# The signup nudge is GATED OFF by default (v4.16.0): trustjeeves.com is not yet a live
# funnel, and shipping a nudge to an unregistered domain is a squat/credibility risk. It only
# emits when JEEVES_SIGNUP=1 is explicitly set. Re-enable once the domain + funnel exist.
REGISTRATION_MSG=""
if [ "${JEEVES_SIGNUP:-}" = "1" ] && [ "$SHOULD_OFFER_REG" = "true" ] && [ "$signup_nudged" != "1" ]; then
  REGISTRATION_MSG="Jeeves has captured ${CAPTURE_COUNT} decisions for you. Sign up at trustjeeves.com (just an email) — you will get a weekly digest of your decisions, and early access to cross-project search and cross-machine sync as they ship. Already have a key? Run /jeeves:activate <key>."
  signup_nudged=1
fi

# --- Memory layer (once per session, mode-INDEPENDENT) ---
# (1) READ: inject the typed memory/ layer (prefs/feedback/reference), prompt-SCORED so the
#     most relevant entries surface first, so the agent applies durable "how to work with
#     this user & repo" guidance from the start. Cheap `-d` guard just avoids spawning when
#     there's no memory/ at all; PROVENANCE (real Jeeves store vs an unrelated ML/agent
#     memory/ dir) is the engine's job — it returns present:false unless ≥1 entry has a
#     recognized type, so a random dir spawns once then is never injected.
# HYGIENE is NOT surfaced here — it fires at session END (thinking-capture-gate Stop hook)
# so a prune ask lands when work winds down, not on the opening prompt.
MEMORY_MSG=""
if [ "$memory_injected" != "1" ] && [ -d "$CWD/memory" ]; then
  MC=$("${JEEVES[@]}" "$CWD" --memory-check --prompt "$PROMPT" --json 2>/dev/null)
  # Latch only once the check actually RAN (valid JSON) — a transient spawn failure
  # retries next prompt instead of silently disabling memory for the whole session.
  if printf '%s' "$MC" | jq -e . >/dev/null 2>&1; then
    memory_injected=1
    if [ "$(printf '%s' "$MC" | jq -r '.present // false' 2>/dev/null)" = "true" ]; then
      MEMORY_MSG=$(printf '%s' "$MC" | jq -r '.inject // empty' 2>/dev/null)
      # Value ledger (v4.18.0): record that memory was RECALLED (surfaced) this session, so
      # `jeeves --report` can show the durable value Jeeves is providing. Local, no network.
      if [ -n "$MEMORY_MSG" ]; then
        _mc=$(printf '%s' "$MC" | jq -r '.count // 0' 2>/dev/null)
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) recall kind=memory project=$(basename "$CWD") count=${_mc:-0}" >> "$USAGE_LOG" 2>/dev/null || true
      fi
    fi
  fi
fi

# (2) WRITE PROTOCOL (D1): instruct the agent to capture new durable prefs/feedback/reference
# SILENTLY as they surface. Fires once per session in any Jeeves-active project (has memory/
# OR a KB → MODE != none), even before memory/ exists, so capture can bootstrap it. Without
# this, memory/ is read-only and never grows.
MEMORY_PROTOCOL_MSG=""
if [ "$memory_protocol_injected" != "1" ] && { [ -d "$CWD/memory" ] || [ "$MODE" != "none" ]; }; then
  MEMORY_PROTOCOL_MSG="$MEMORY_PROTOCOL"
  memory_protocol_injected=1
fi

# --- Fresh-code-repo bootstrap OFFER (ask-dont-gate) ---
# Jeeves installed but this repo is uninitialized: code present, but no KB and no thinking/
# (MODE=none) and it is NOT a thinking-candidate (CAND=no → ≥3 source files → a real code
# repo, not a notes/empty dir, which auto-bootstraps thinking/ above). ASK the user to set up
# — do not gate, do not silently scaffold (a code KB needs real population). Once per session
# (kb_offered) UNTIL acted on; a persistent `.jeeves-no-kb` opt-out file silences it for good.
# CAND is set on prompt 1 (bootstrap block); on later prompts kb_offered=1 already skips this.
KB_OFFER_MSG=""
if [ "$kb_offered" != "1" ] && [ "$MODE" = "none" ] && [ "$CAND" = "no" ] && [ ! -f "$CWD/.jeeves-no-kb" ]; then
  KB_OFFER_MSG='Jeeves is installed but this repo has no knowledge base yet (no docs/internal/). ASK the user ONCE, plainly: "This repo has code but no Jeeves knowledge base — want me to set one up? I will scaffold docs/internal/ and populate a SYSTEM-MAP from your codebase (~2 min)." If yes → run the /jeeves:init skill, then populate the KB from the codebase. If the user declines and says do not ask again, create an empty file .jeeves-no-kb at the repo root so Jeeves stops offering. This is a one-time ASK — do not gate, block, or repeat it within this session.'
  kb_offered=1
fi

# --- KB read loop (v4.17.0, code/both mode) ---
# The code KB was write-only: Jeeves nagged you to WRITE docs but never surfaced them when
# work started. Inject the SYSTEM-MAP core pointer once per session, plus doc pointers scored
# against THIS prompt (so relevance tracks the current task, not prompt 1). Each doc pointer is
# shown at most once per session (sentinel file), so it surfaces the moment it first matches.
KB_MSG=""
if [ "$MODE" = "code" ] || [ "$MODE" = "both" ]; then
  KB=$("${JEEVES[@]}" "$CWD" --kb-check --prompt "$PROMPT" --json 2>/dev/null)
  if printf '%s' "$KB" | jq -e . >/dev/null 2>&1; then
    if [ "$kb_core_injected" != "1" ]; then
      CORE=$(printf '%s' "$KB" | jq -r '.core // empty' 2>/dev/null)
      [ -n "$CORE" ] && { KB_MSG="Jeeves KB — ${CORE}"; kb_core_injected=1; }
    fi
    KBSHOWN="${STATE}-kbshown"; NEWPTRS=""
    while IFS= read -r _p; do
      [ -z "$_p" ] && continue
      _pp="${_p%% —*}"   # doc path portion
      if ! { [ -f "$KBSHOWN" ] && grep -qxF "$_pp" "$KBSHOWN" 2>/dev/null; }; then
        NEWPTRS="${NEWPTRS:+$NEWPTRS; }$_p"
        echo "$_pp" >> "$KBSHOWN" 2>/dev/null || true
      fi
    done <<KBEOF
$(printf '%s' "$KB" | jq -r '.pointers[]? // empty' 2>/dev/null)
KBEOF
    if [ -n "$NEWPTRS" ]; then
      KB_MSG="${KB_MSG:+$KB_MSG }Relevant KB (read before working on this): ${NEWPTRS}"
      # Value ledger (v4.18.0): count KB docs recalled (surfaced) this prompt.
      _kbn=$(printf '%s' "$NEWPTRS" | awk -F'; ' '{print NF}')
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) recall kind=kb project=$(basename "$CWD") count=${_kbn:-1}" >> "$USAGE_LOG" 2>/dev/null || true
    fi
  fi
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

# --- persist state (best effort, ATOMIC) ---
# Write to a temp file then rename (v4.16.0): a plain `>` redirect can be observed
# half-written by a concurrent Stop-gate read (which parses a truncated file as zeros,
# resetting block_count/prompts). rename(2) is atomic on the same filesystem.
_STATE_TMP="${STATE}.tmp.$$"
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
  echo "memory_injected=$memory_injected"
  echo "memory_protocol_injected=$memory_protocol_injected"
  echo "kb_offered=$kb_offered"
  echo "kb_core_injected=$kb_core_injected"
} > "$_STATE_TMP" 2>/dev/null && mv "$_STATE_TMP" "$STATE" 2>/dev/null || rm -f "$_STATE_TMP" 2>/dev/null || true

# Version warning rides in front of any thinking-mode context, and emits on its
# own even in code-mode projects (where CTX is empty).
FULL_CTX="$CTX"
[ -n "$REGISTRATION_MSG" ] && FULL_CTX="${REGISTRATION_MSG}${CTX:+ }${CTX}"
# Memory rides ahead of thinking-mode context (durable behavioral guidance applies to
# every mode), but behind the version warning. The capture PROTOCOL (write path) leads the
# memory READ payload so the "capture as you go" instruction is seen first.
[ -n "$MEMORY_MSG" ] && FULL_CTX="${MEMORY_MSG}${FULL_CTX:+ }${FULL_CTX}"
[ -n "$MEMORY_PROTOCOL_MSG" ] && FULL_CTX="${MEMORY_PROTOCOL_MSG}${FULL_CTX:+ }${FULL_CTX}"
# KB read-loop pointers ride with memory (durable "read this" guidance), ahead of thinking ctx.
[ -n "$KB_MSG" ] && FULL_CTX="${KB_MSG}${FULL_CTX:+ }${FULL_CTX}"
# The fresh-repo bootstrap ask rides near the front — it's an explicit question TO the user.
[ -n "$KB_OFFER_MSG" ] && FULL_CTX="${KB_OFFER_MSG}${FULL_CTX:+ }${FULL_CTX}"
[ -n "$VERSION_MSG" ] && FULL_CTX="${VERSION_MSG}${FULL_CTX:+ }${FULL_CTX}"

if [ -n "$FULL_CTX" ]; then
  # Build the payload with jq so ARBITRARY content is correctly JSON-escaped. FULL_CTX now
  # includes user-authored memory markdown; the old hand-rolled `sed` escaped only \ and "
  # (and `tr` flattened newlines) — a TAB or any control char in a memory file produced
  # invalid JSON and Claude Code dropped the ENTIRE hook output for that prompt. jq -Rs
  # handles all control chars + preserves structure. Fail OPEN if jq can't produce output.
  OUT=$(printf '%s' "$FULL_CTX" | jq -Rsc '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:.}}' 2>/dev/null)
  [ -n "$OUT" ] && { printf '%s\n' "$OUT"; exit 0; }
fi
emit_empty
