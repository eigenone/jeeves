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
# Nothing to re-inject unless this project uses memory/ and/or thinking/.
[ -d "$CWD/memory" ] || [ -d "$CWD/thinking" ] || emit_empty

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

# Both strings MUST stay byte-identical to their originals in session-check.sh — the
# instructions compaction wiped, restored so capture continues. check-plugin-toolkit-sync.sh
# asserts this cross-file parity (v4.16.0).
MEMORY_PROTOCOL='Jeeves memory is active. When the user reveals something DURABLE about how to work with THEM or THIS repo — a stated preference, a correction of your approach, how they want answers/output, or a stable setup/reference fact — capture it SILENTLY (do not narrate, do not ask permission): write memory/<type>_<slug>.md with frontmatter name, description, metadata.type = user|feedback|reference, and created + confirmed dates (today), then add a one-line pointer under the matching section of memory/MEMORY.md. Capture is OPPORTUNISTIC — only cross-session facts about the user/repo, NOT this task code details (those belong in the code KB). Before adding, check MEMORY.md for an existing entry to UPDATE (bump its confirmed date) instead of duplicating. Under-capturing durable prefs is the failure mode; a correction the user repeats twice is a memory.'
PROTOCOL='Jeeves thinking-mode is active. This is a decision/brainstorming project. Capture knowledge to thinking/ as a SILENT SIDE EFFECT — do not narrate the writes, do not ask permission, do not break the conversation rhythm. The user conversational instructions govern the conversation, not whether files get written between turns. Capture continuously (every 3-4 exchanges): a choice the user lands on even tentatively -> thinking/decisions/<slug>.md + a row in thinking/INDEX.md; an idea explored but not chosen -> thinking/topics/<slug>.md; a question left open -> thinking/INDEX.md Open Questions; an idea rejected with reasoning -> the topic file under Rejected. Threshold for a decision: anything you would not want to re-derive from scratch next session. When in doubt, capture it. Under-capturing is the failure mode here, not over-capturing.'

CTX=""
# Memory layer: capture PROTOCOL (wiped) + the unscored READ core (index + user/feedback).
# No prompt at SessionStart, so prompt-scoring resumes on the next UserPromptSubmit.
if [ -d "$CWD/memory" ]; then
  CTX="$MEMORY_PROTOCOL"
  if [ ${#JEEVES[@]} -gt 0 ]; then
    MC=$("${JEEVES[@]}" "$CWD" --memory-check --json 2>/dev/null)
    if printf '%s' "$MC" | jq -e . >/dev/null 2>&1 && [ "$(printf '%s' "$MC" | jq -r '.present // false' 2>/dev/null)" = "true" ]; then
      INJ=$(printf '%s' "$MC" | jq -r '.inject // empty' 2>/dev/null)
      [ -n "$INJ" ] && CTX="${INJ} ${CTX}"
    fi
  fi
fi
# Thinking layer: restore the Layer-1 capture PROTOCOL. A capturing session never nudges, so
# without this it silently loses its capture instruction for the rest of a compacted session.
[ -d "$CWD/thinking" ] && CTX="${PROTOCOL}${CTX:+ }${CTX}"

[ -z "$CTX" ] && emit_empty
CTX="[Jeeves: context re-established after ${SOURCE}] ${CTX}"

# jq -Rsc correctly escapes arbitrary content (user-authored memory markdown may contain
# tabs/control chars). Fail OPEN if jq can't produce output.
OUT=$(printf '%s' "$CTX" | jq -Rsc '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' 2>/dev/null)
[ -n "$OUT" ] && { printf '%s\n' "$OUT"; exit 0; }
emit_empty
