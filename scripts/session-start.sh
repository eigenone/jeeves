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
# Nothing to re-inject if there's no memory/ store at all.
[ -d "$CWD/memory" ] || emit_empty

# Resolve the engine (identical contract to session-check.sh: prefer the plugin copy over a
# stale project-local one, and the prebuilt .cjs over .ts). Array form is space-safe.
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

# Keep this string byte-identical to MEMORY_PROTOCOL in session-check.sh (sync-check asserts
# it) — the capture instruction the compaction wiped, restored so capture continues.
MEMORY_PROTOCOL='Jeeves memory is active. When the user reveals something DURABLE about how to work with THEM or THIS repo — a stated preference, a correction of your approach, how they want answers/output, or a stable setup/reference fact — capture it SILENTLY (do not narrate, do not ask permission): write memory/<type>_<slug>.md with frontmatter name, description, metadata.type = user|feedback|reference, and created + confirmed dates (today), then add a one-line pointer under the matching section of memory/MEMORY.md. Capture is OPPORTUNISTIC — only cross-session facts about the user/repo, NOT this task code details (those belong in the code KB). Before adding, check MEMORY.md for an existing entry to UPDATE (bump its confirmed date) instead of duplicating. Under-capturing durable prefs is the failure mode; a correction the user repeats twice is a memory.'

# Re-inject: the capture PROTOCOL always (it was wiped), plus the memory READ core when the
# store has recognized entries. No prompt is available at SessionStart, so the read is the
# unscored core (index + user/feedback) — prompt-scoring resumes on the next UserPromptSubmit.
MC=$("${JEEVES[@]}" "$CWD" --memory-check --json 2>/dev/null)
CTX="$MEMORY_PROTOCOL"
if printf '%s' "$MC" | jq -e . >/dev/null 2>&1 && [ "$(printf '%s' "$MC" | jq -r '.present // false' 2>/dev/null)" = "true" ]; then
  INJ=$(printf '%s' "$MC" | jq -r '.inject // empty' 2>/dev/null)
  [ -n "$INJ" ] && CTX="${INJ} ${CTX}"
fi
CTX="[Jeeves: memory re-established after ${SOURCE}] ${CTX}"

# jq -Rsc correctly escapes arbitrary content (user-authored memory markdown may contain
# tabs/control chars). Fail OPEN if jq can't produce output.
OUT=$(printf '%s' "$CTX" | jq -Rsc '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' 2>/dev/null)
[ -n "$OUT" ] && { printf '%s\n' "$OUT"; exit 0; }
emit_empty
