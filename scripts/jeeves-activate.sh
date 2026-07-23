#!/usr/bin/env bash
# Jeeves activate — invoked by /jeeves:activate "$ARGUMENTS". Three modes by argument:
#   (no arg)  -> guide the user to /jeeves:login (the browser device flow)
#   jvs_...   -> store a pasted key as the GLOBAL key (legacy / manual fallback)
#   <label>   -> mint a PROJECT key for THIS repo via the global key; write ./.jeeves/key
# All output is for the assistant to relay. Never prints a full key it wrote.
set -u
ARG=$(printf '%s' "${1:-}" | tr -d '\t\r\n' | sed 's/^ *//; s/ *$//')
API="${JEEVES_API_URL:-https://server.draft0.ai}"
PROJ="${CLAUDE_PROJECT_DIR:-$(pwd)}"

if [ -z "$ARG" ]; then
  echo "To activate Jeeves on this machine, run /jeeves:login — a browser sign-in, nothing to paste."
  echo "To track just this repo on its own key, run:  /jeeves:activate <label>   (e.g. /jeeves:activate acme-web)"
  exit 0
fi

case "$ARG" in
  jvs_*)
    # Legacy/manual: store a key the user already has as the global key.
    mkdir -p "${HOME}/.jeeves" && printf '%s' "$ARG" > "${HOME}/.jeeves/key" && chmod 600 "${HOME}/.jeeves/key" 2>/dev/null || true
    rm -f "${HOME}/.jeeves/validation" 2>/dev/null || true   # force a fresh validation
    if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
      V=$(curl -s --max-time 8 -X POST "$API/validate" -H "Content-Type: application/json" -d "$(jq -cn --arg k "$ARG" '{key:$k}')" 2>/dev/null)
      if [ "$(printf '%s' "$V" | jq -r '.valid // false' 2>/dev/null)" = "true" ]; then
        echo "✓ Jeeves activated (global key stored). Try /jeeves:report."
      else
        echo "That key isn't valid or has expired. Get set up with /jeeves:login instead (no key to paste)."
      fi
    else
      echo "Key stored. Install jq + curl so Jeeves can verify and meter usage."
    fi
    ;;
  *)
    # Treat the argument as a label: mint a per-repo project key using the global key.
    command -v curl >/dev/null 2>&1 || { echo "curl is required. Install it and retry."; exit 1; }
    command -v jq   >/dev/null 2>&1 || { echo "jq is required. Install it and retry."; exit 1; }
    GLOBAL=$(tr -d ' \t\n\r' < "${HOME}/.jeeves/key" 2>/dev/null)
    if [ -z "$GLOBAL" ]; then
      echo "This machine isn't activated yet. Run /jeeves:login first, then /jeeves:activate $ARG."
      exit 1
    fi
    RESP=$(curl -s --max-time 10 -X POST "$API/keys/project" -H "Authorization: Bearer $GLOBAL" -H "Content-Type: application/json" -d "$(jq -cn --arg l "$ARG" '{label:$l}')" 2>/dev/null)
    KEY=$(printf '%s' "$RESP" | jq -r '.api_key // empty' 2>/dev/null)
    if [ -z "$KEY" ]; then
      echo "Couldn't create the project key. Is this machine activated? Try /jeeves:login. (server: $RESP)"
      exit 1
    fi
    mkdir -p "$PROJ/.jeeves" && printf '%s' "$KEY" > "$PROJ/.jeeves/key" && chmod 600 "$PROJ/.jeeves/key" 2>/dev/null || true
    # Warm the gate cache for the new project key so the next skill doesn't round-trip.
    KH=$(printf '%s' "$KEY" | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1)
    NOW=$(date +%s 2>/dev/null || echo 0)
    printf '%s' "$(jq -cn --arg h "$KH" --argjson t "${NOW:-0}" '{key_hash:$h,valid:true,ts:$t,grace:86400}')" > "${HOME}/.jeeves/validation" 2>/dev/null || true
    echo "✓ Created project key '$ARG' for this repo — its usage now tracks separately on your dashboard."
    echo "  Add .jeeves/ to .gitignore if it isn't already (the key is a secret)."
    ;;
esac
exit 0
