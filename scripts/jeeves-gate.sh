#!/usr/bin/env bash
# Jeeves gate — decides whether Jeeves may run for the current key. Prints exactly one of:
#   open              — allowed
#   closed:no_key     — no key on disk (project-local or global)
#   closed:invalid    — the backend CONFIRMED the key is invalid/revoked
# and ALWAYS exits 0 (never errors out its caller). This is the authoritative gate used by
# the skill hook (credit-check.sh). The frequent session hooks do a cheaper key-presence
# check inline instead, to avoid a network round-trip on every prompt.
#
# Jeeves requires a valid account key. Precedence: project-local .jeeves/key, then global
# ~/.jeeves/key. The verdict is cached at ~/.jeeves/validation with a SERVER-controlled grace
# window so a backend outage or offline work never bricks Jeeves.
#
# Fail model (funnel gate, not DRM): CLOSED only when there is NO key, or the backend
# explicitly says the key is invalid. Any network/tooling failure with a key present →
# OPEN (fail-open), and a fresh valid cache short-circuits the network call entirely.
set -u

emit() { printf '%s\n' "$1"; exit 0; }

# 1. Resolve the key — project-local wins over global.
KEY=""
for f in "${CLAUDE_PROJECT_DIR:-.}/.jeeves/key" "${HOME:-}/.jeeves/key"; do
  case "$f" in /.jeeves/key) continue ;; esac
  if [ -f "$f" ]; then KEY=$(tr -d ' \t\n\r' < "$f" 2>/dev/null); [ -n "$KEY" ] && break; fi
done
[ -z "$KEY" ] && emit "closed:no_key"

# Without jq/curl we can't validate — fail OPEN (don't punish a broken toolchain).
command -v jq   >/dev/null 2>&1 || emit "open"
command -v curl >/dev/null 2>&1 || emit "open"

API="${JEEVES_API_URL:-https://server.draft0.ai}"
JHOME="${HOME:-/tmp}"
CACHE="$JHOME/.jeeves/validation"
NOW=$(date +%s 2>/dev/null || echo 0)
KEY_HASH=$(printf '%s' "$KEY" | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1)

# 2. Fresh valid cache for THIS key → open without touching the network.
if [ -f "$CACHE" ]; then
  C=$(cat "$CACHE" 2>/dev/null)
  CH=$(printf '%s' "$C" | jq -r '.key_hash // empty' 2>/dev/null)
  CV=$(printf '%s' "$C" | jq -r '.valid // false'   2>/dev/null)
  CT=$(printf '%s' "$C" | jq -r '.ts // 0'          2>/dev/null)
  CG=$(printf '%s' "$C" | jq -r '.grace // 86400'   2>/dev/null)
  if [ "$CH" = "$KEY_HASH" ] && [ "$CV" = "true" ]; then
    AGE=$(( NOW - CT ))
    [ "$AGE" -ge 0 ] && [ "$AGE" -lt "$CG" ] && emit "open"
  fi
fi

# 3. Cache miss/stale → ask the backend.
RESP=$(curl -s --max-time 6 -X POST "$API/validate" \
  -H "Content-Type: application/json" \
  -d "$(jq -cn --arg k "$KEY" '{key:$k}')" 2>/dev/null)

# Network/tooling failure → fail OPEN (funnel gate; the server will catch it next time).
[ -z "$RESP" ] && emit "open"

VALID=$(printf '%s' "$RESP" | jq -r '.valid // false'        2>/dev/null)
GRACE=$(printf '%s' "$RESP" | jq -r '.grace_seconds // 86400' 2>/dev/null)
case "$GRACE" in ''|*[!0-9]*) GRACE=86400 ;; esac

# Refresh the cache (best-effort) and return the verdict.
mkdir -p "$JHOME/.jeeves" 2>/dev/null || true
if [ "$VALID" = "true" ]; then
  printf '%s' "$(jq -cn --arg h "$KEY_HASH" --argjson t "${NOW:-0}" --argjson g "$GRACE" '{key_hash:$h, valid:true, ts:$t, grace:$g}')" > "$CACHE" 2>/dev/null || true
  emit "open"
else
  printf '%s' "$(jq -cn --arg h "$KEY_HASH" --argjson t "${NOW:-0}" --argjson g "$GRACE" '{key_hash:$h, valid:false, ts:$t, grace:$g}')" > "$CACHE" 2>/dev/null || true
  emit "closed:invalid"
fi
