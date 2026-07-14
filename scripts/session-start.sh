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

# Only re-inject on compact/resume. startup/clear are fresh sessions — session-check's
# normal prompt-1 injection handles those (and re-injecting there would double up).
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)
case "$SOURCE" in compact|resume) ;; *) emit_empty ;; esac

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$(pwd)"
# Nothing to re-inject unless Jeeves is active here (memory/, thinking/, or a code KB).
[ -d "$CWD/memory" ] || [ -d "$CWD/thinking" ] || [ -d "$CWD/docs/internal" ] || emit_empty

# Resolve the engine (same contract as session-check.sh: prefer the plugin copy over a stale
# project-local one, and prebuilt .cjs over .ts). Needed ONLY for the memory READ payload —
# both protocols are static strings — so a missing engine is NON-fatal here (leave JEEVES empty).
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
