#!/bin/bash
# Jeeves session-start — SessionStart hook (v4.11.0, D3). Re-injects the memory layer
# after a COMPACTION or RESUME. Both lose the prompt-1 memory injection (compaction
# summarizes it away; resume reloads a transcript that predates it) while the /tmp
# per-session state PERSISTS — so session-check's once-per-session latch (memory_injected)
# would never re-fire and memory would silently vanish mid-session. This hook re-establishes
# it directly via additionalContext, independent of that latch.
#
# Fail-open invariant: ANY error/parse failure -> emit '{}' and exit 0.
INPUT=$(cat 2>/dev/null)
emit_empty() { echo '{}'; exit 0; }

SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$(pwd)"

# Resolve the engine (same contract as session-check.sh: prefer the plugin copy over a stale
# project-local one, and prebuilt .cjs over .ts). Needed for the memory READ payload AND the
# telemetry step — both are best-effort, so a missing engine is NON-fatal (leave JEEVES empty).
JEEVES=()
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs" ]; then
  JEEVES=(node "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.cjs")
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts")
elif [ -f "scripts/jeeves.cjs" ]; then
  JEEVES=(node scripts/jeeves.cjs)
elif [ -f "scripts/jeeves.ts" ]; then
  JEEVES=(npx tsx scripts/jeeves.ts)
fi

# ── Usage telemetry (once per session, keyed users only, DETACHED, fail-open) ──────────────
# Default-ON for signed-in (keyed) users; HASHED + counts-only. Sends a project summary — a
# one-way project hash + integer counts (health, decisions, patterns, recalls) — to the backend
# /check, which upserts the projects table + logs an event (NO `skill` field → NOT billed). Never
# sends code, file names, or doc content. Local/anonymous users send NOTHING. Runs on EVERY
# session source (startup/clear/compact/resume) so a fresh session reports once; guarded by a
# per-session marker. Fully independent of the memory re-injection below — any failure here MUST
# NOT affect hook output (it never touches the emitted JSON).
jeeves_telemetry() {
  command -v jq   >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  [ ${#JEEVES[@]} -gt 0 ] || return 0
  # Only for Jeeves-active repos (memory/, thinking/, or a code KB) — nothing to summarize otherwise.
  [ -d "$CWD/memory" ] || [ -d "$CWD/thinking" ] || [ -d "$CWD/docs/internal" ] || return 0

  # Opt-out: env kill-switch OR ~/.jeeves/config tracking=anonymous → send NOTHING.
  [ "${JEEVES_NO_TELEMETRY:-}" = "1" ] && return 0
  TRACKING="hashed"
  CONFIG="${HOME:-}/.jeeves/config"
  if [ -n "${HOME:-}" ] && [ -f "$CONFIG" ]; then
    _t=$(grep -E '^[[:space:]]*tracking[[:space:]]*=' "$CONFIG" 2>/dev/null | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//')
    case "$_t" in anonymous|hashed|named) TRACKING="$_t" ;; esac
  fi
  [ "$TRACKING" = "anonymous" ] && return 0

  # A key is required to attribute usage (keyed users only). No key → send NOTHING.
  KEY=""
  for f in "${HOME:-}/.jeeves/key" "${CLAUDE_PROJECT_DIR:-.}/.jeeves/key"; do
    case "$f" in /.jeeves/key) continue ;; esac   # skip when the base var was empty
    if [ -f "$f" ]; then KEY=$(tr -d ' \t\n\r' < "$f" 2>/dev/null); [ -n "$KEY" ] && break; fi
  done
  [ -z "$KEY" ] && return 0

  # Once per session. SessionStart carries session_id; sanitize to a /tmp-safe marker.
  SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9_-' | head -c 80)
  [ -z "$SID" ] && SID="nosid"
  MARKER="/tmp/jeeves-telemetry-${SID}"
  [ -f "$MARKER" ] && return 0

  # Compute the summary LOCALLY (no network). project_name is included ONLY when tracking=named.
  T=$("${JEEVES[@]}" "$CWD" --telemetry --json 2>/dev/null)
  printf '%s' "$T" | jq -e . >/dev/null 2>&1 || return 0
  : > "$MARKER" 2>/dev/null || true   # latch even on send failure — one attempt per session

  VERSION=""
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    VERSION=$(jq -r '.version // empty' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null)
  fi

  # Build the /check payload. Omit `skill` so the event is NOT billed. Include project_name ONLY
  # when tracking=named (default hashed → drop it). Counts are integers; never any content.
  PAYLOAD=$(printf '%s' "$T" | jq -c \
    --arg k "$KEY" --arg v "$VERSION" --arg tracking "$TRACKING" \
    '{
       key: $k,
       project_hash: .project_hash,
       stats: { health_score: .health_score, decisions: .decisions, patterns: .patterns, recalls: .recalls },
       version: $v
     }
     + (if $tracking == "named" then { project_name: .project_name } else {} end)' 2>/dev/null) || return 0
  [ -z "$PAYLOAD" ] && return 0

  API="${JEEVES_API_URL:-https://server.draft0.ai}"
  # Detached fire-and-forget — a slow/unreachable backend must never delay session start.
  # Tests set JEEVES_CHECK_SYNC=1 to run foreground so the mock server can be asserted.
  if [ "${JEEVES_CHECK_SYNC:-}" = "1" ]; then
    curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 || true
  else
    ( curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
  fi
}
jeeves_telemetry 2>/dev/null || true

# ── Memory re-injection (compact/resume only) ─────────────────────────────────────────────
# Only re-inject on compact/resume. startup/clear are fresh sessions — session-check's
# normal prompt-1 injection handles those (and re-injecting there would double up).
case "$SOURCE" in compact|resume) ;; *) emit_empty ;; esac

# Nothing to re-inject unless Jeeves is active here (memory/, thinking/, or a code KB).
[ -d "$CWD/memory" ] || [ -d "$CWD/thinking" ] || [ -d "$CWD/docs/internal" ] || emit_empty

# Both strings MUST stay byte-identical to their copies in session-check.sh — the capture
# routing protocol compaction wiped, restored so capture continues. check-plugin-toolkit-sync.sh
# asserts this cross-file parity (v5.0.0).
CAPTURE_PROTOCOL='Jeeves is active — capture durable knowledge as a SILENT SIDE EFFECT (do not narrate, do not ask permission, do not break the conversation rhythm), ROUTED BY KIND: (1) a stable fact about how to work with THIS user or repo — a stated preference, a correction of your approach, how they want answers/output, a setup/reference fact -> write memory/<type>_<slug>.md (metadata.type = user|feedback|reference, with created + confirmed dates) + a one-line pointer in memory/MEMORY.md; before adding, check MEMORY.md for an entry to UPDATE (bump confirmed) instead of duplicating. (2) code or architecture knowledge — how a subsystem works, a non-obvious design choice -> the code KB (docs/internal/patterns|decisions), NOT memory. Capture is OPPORTUNISTIC: only cross-session facts, NEVER this task transient details. A correction the user repeats twice is a memory.'
THINKING_CLAUSE=' (3) This is a decision/brainstorming project: capture every choice landed on (even tentative), idea explored, or open question CONTINUOUSLY (every 3-4 exchanges) -> thinking/decisions|topics/<slug>.md + a row in thinking/INDEX.md. Threshold: anything you would not want to re-derive from scratch next session. Under-capturing is the failure mode; when in doubt, capture.'

CTX=""
# Restore the capture routing protocol (compaction wiped it); append the thinking clause only
# when thinking/ exists (a pure-code repo must never be told to write thinking/).
CTX="$CAPTURE_PROTOCOL"
[ -d "$CWD/thinking" ] && CTX="${CTX}${THINKING_CLAUSE}"
# Memory READ core (index + user/feedback) if present. No prompt at SessionStart, so
# prompt-scoring resumes on the next UserPromptSubmit.
if [ -d "$CWD/memory" ] && [ ${#JEEVES[@]} -gt 0 ]; then
  MC=$("${JEEVES[@]}" "$CWD" --memory-check --json 2>/dev/null)
  if printf '%s' "$MC" | jq -e . >/dev/null 2>&1 && [ "$(printf '%s' "$MC" | jq -r '.present // false' 2>/dev/null)" = "true" ]; then
    INJ=$(printf '%s' "$MC" | jq -r '.inject // empty' 2>/dev/null)
    [ -n "$INJ" ] && CTX="${INJ} ${CTX}"
  fi
fi

[ -z "$CTX" ] && emit_empty
CTX="[Jeeves: context re-established after ${SOURCE}] ${CTX}"

# jq -Rsc correctly escapes arbitrary content (user-authored memory markdown may contain
# tabs/control chars). Fail OPEN if jq can't produce output.
OUT=$(printf '%s' "$CTX" | jq -Rsc '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' 2>/dev/null)
[ -n "$OUT" ] && { printf '%s\n' "$OUT"; exit 0; }
emit_empty
