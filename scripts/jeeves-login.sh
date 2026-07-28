#!/usr/bin/env bash
# Jeeves device login (gh-style) — invoked by the /jeeves:login skill in TWO phases so the
# user sees the approval code IMMEDIATELY. The older single-shot version printed the code and
# then blocked polling in the same process; Claude Code's Bash tool only returns stdout when
# the process exits, so the assistant couldn't relay the code until AFTER approval. Split:
#   jeeves-login.sh start → begins device auth, prints URL+code, opens browser, EXITS fast.
#   jeeves-login.sh poll  → blocks polling the pending login, writes the key on approval.
# The user never sees or pastes a key. Exits non-zero on failure with a human-readable reason.
set -u
API="${JEEVES_API_URL:-https://server.draft0.ai}"
STATE="${HOME}/.jeeves/.pending-login"
command -v jq   >/dev/null 2>&1 || { echo "jq is required for /jeeves:login (install jq and retry)."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required for /jeeves:login (install curl and retry)."; exit 1; }

start() {
  HOST=$(hostname 2>/dev/null || echo "")
  START=$(curl -s --max-time 10 -X POST "$API/device/start" -H "Content-Type: application/json" \
            -d "$(jq -cn --arg p claude --arg h "$HOST" '{platform:$p, hostname:$h}')" 2>/dev/null)
  DC=$(printf '%s' "$START" | jq -r '.device_code // empty' 2>/dev/null)
  UC=$(printf '%s' "$START" | jq -r '.user_code // empty' 2>/dev/null)
  URL=$(printf '%s' "$START" | jq -r '.verification_uri_complete // .verification_uri // empty' 2>/dev/null)
  INTERVAL=$(printf '%s' "$START" | jq -r '.interval // 3' 2>/dev/null)
  EXPIRES=$(printf '%s' "$START" | jq -r '.expires_in // 600' 2>/dev/null)
  if [ -z "$DC" ] || [ -z "$UC" ] || [ -z "$URL" ]; then
    echo "Couldn't reach Jeeves to start login. Check your connection and run /jeeves:login again."
    exit 1
  fi
  case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=3 ;; esac
  case "$EXPIRES"  in ''|*[!0-9]*) EXPIRES=600 ;; esac
  [ "$INTERVAL" -lt 1 ] && INTERVAL=1   # floor: a server-sent interval:0 would never advance WAITED

  mkdir -p "${HOME}/.jeeves" 2>/dev/null
  printf '%s' "$(jq -cn --arg d "$DC" --argjson i "$INTERVAL" --argjson e "$EXPIRES" \
    '{device_code:$d, interval:$i, expires:$e}')" > "$STATE" 2>/dev/null
  chmod 600 "$STATE" 2>/dev/null || true

  echo "Activate Jeeves — approve this device in your browser:"
  echo ""
  echo "    $URL"
  echo ""
  echo "    code: $UC"
  echo ""
  echo "Opening your browser now — sign in if needed, then click Approve."

  # Best-effort browser open (never fatal if it fails — the URL is printed above).
  if   command -v open     >/dev/null 2>&1; then ( open "$URL"     >/dev/null 2>&1 & )
  elif command -v xdg-open >/dev/null 2>&1; then ( xdg-open "$URL" >/dev/null 2>&1 & )
  fi
  exit 0
}

poll() {
  [ -f "$STATE" ] || { echo "No pending login. Run /jeeves:login to start."; exit 1; }
  DC=$(jq -r '.device_code // empty' "$STATE" 2>/dev/null)
  INTERVAL=$(jq -r '.interval // 3' "$STATE" 2>/dev/null)
  EXPIRES=$(jq -r '.expires // 600' "$STATE" 2>/dev/null)
  [ -z "$DC" ] && { echo "Pending login looks corrupt. Run /jeeves:login again."; rm -f "$STATE" 2>/dev/null; exit 1; }
  case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=3 ;; esac
  case "$EXPIRES"  in ''|*[!0-9]*) EXPIRES=600 ;; esac
  [ "$INTERVAL" -lt 1 ] && INTERVAL=1

  WAITED=0
  while [ "$WAITED" -lt "$EXPIRES" ]; do
    sleep "$INTERVAL"; WAITED=$(( WAITED + INTERVAL ))
    P=$(curl -s --max-time 10 -X POST "$API/device/poll" -H "Content-Type: application/json" \
          -d "$(jq -cn --arg d "$DC" '{device_code:$d}')" 2>/dev/null)
    STATUS=$(printf '%s' "$P" | jq -r '.status // empty' 2>/dev/null)
    case "$STATUS" in
      approved)
        NEWKEY=$(printf '%s' "$P" | jq -r '.api_key // empty' 2>/dev/null)
        GRACE=$(printf '%s' "$P" | jq -r '.grace_seconds // 86400' 2>/dev/null)
        if [ -z "$NEWKEY" ]; then
          echo "Approved, but the key was already claimed by another attempt. Run /jeeves:login again."
          rm -f "$STATE" 2>/dev/null
          exit 1
        fi
        printf '%s' "$NEWKEY" > "${HOME}/.jeeves/key" && chmod 600 "${HOME}/.jeeves/key" 2>/dev/null || true
        # Warm the gate cache so the next skill doesn't need a validation round-trip.
        KH=$(printf '%s' "$NEWKEY" | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1)
        NOW=$(date +%s 2>/dev/null || echo 0)
        case "$GRACE" in ''|*[!0-9]*) GRACE=86400 ;; esac
        printf '%s' "$(jq -cn --arg h "$KH" --argjson t "${NOW:-0}" --argjson g "$GRACE" \
          '{key_hash:$h,valid:true,ts:$t,grace:$g}')" > "${HOME}/.jeeves/validation" 2>/dev/null || true
        rm -f "$STATE" 2>/dev/null
        echo ""
        echo "✓ Jeeves is activated — one key covers all your repos on this machine."
        echo "  Try /jeeves:report to see what Jeeves has already recalled for you."
        exit 0 ;;
      expired)
        echo "That code expired before it was approved. Run /jeeves:login to try again."
        rm -f "$STATE" 2>/dev/null
        exit 1 ;;
      *) : ;;  # pending / transient — keep polling
    esac
  done
  echo "Login timed out waiting for approval. Run /jeeves:login to try again."
  rm -f "$STATE" 2>/dev/null
  exit 1
}

case "${1:-}" in
  start) start ;;
  poll)  poll ;;
  *) echo "usage: jeeves-login.sh {start|poll}"; exit 2 ;;
esac
