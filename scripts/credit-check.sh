#!/usr/bin/env bash
# PreToolUse (matcher "Skill") — GATE + METER for Jeeves skills.
#
# Jeeves requires a valid account key. This hook is the authoritative gate for user-invoked
# skills: without a valid key it BLOCKS the skill (exit 2 + stderr, the verified PreToolUse
# block mechanism) and points the user at /jeeves:login. With a valid key it meters the
# invocation to the backend so the dashboard can show usage (metering is fire-and-forget and
# never blocks). The setup skills (activate, login) are NEVER gated — chicken-and-egg.
#
# Only Jeeves' own plugin-qualified skills ("jeeves:<name>") are touched; other plugins'
# and personal skills are ignored entirely. Fails OPEN on any tooling error (a broken
# jq/curl/gate must never wedge the user's session) — the gate itself only closes on a
# missing key or a backend-confirmed-invalid key.
set -u

INPUT=$(cat 2>/dev/null || true)
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# Real Skill payload shape (verified against live transcripts): {"tool_input":{"skill":"jeeves:harden"}}
RAW=$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // empty' 2>/dev/null)
[ -z "$RAW" ] && exit 0

# Only act on Jeeves' own (plugin-qualified) skills; use the bare name downstream.
case "$RAW" in
  jeeves:*) SKILL="${RAW#jeeves:}" ;;
  *) exit 0 ;;
esac
[ -z "$SKILL" ] && exit 0

# Setup skills bypass the gate AND metering — you must be able to activate without a key.
case "$SKILL" in
  activate|login) exit 0 ;;
esac

# ── GATE ────────────────────────────────────────────────────────────────────────
# Ask the shared gate (sibling script in the same dir, both layouts). It prints
# open | closed:no_key | closed:invalid and always exits 0. Anything unexpected → open.
GATE=$("$(dirname "$0")/jeeves-gate.sh" 2>/dev/null || echo open)
case "$GATE" in
  closed:no_key)
    printf '%s\n' "Jeeves needs a free account to run skills. Set it up with /jeeves:login — one command, no key to copy." >&2
    exit 2 ;;
  closed:invalid)
    printf '%s\n' "Your Jeeves key isn't valid (expired or revoked). Re-activate with /jeeves:login." >&2
    exit 2 ;;
esac

# ── METER (gate open) ───────────────────────────────────────────────────────────
# Resolve the key (project-local wins over global) for attribution. The gate already
# confirmed a usable key exists; this just re-reads it for the meter payload.
KEY=""
for f in "${CLAUDE_PROJECT_DIR:-.}/.jeeves/key" "${HOME:-}/.jeeves/key"; do
  case "$f" in /.jeeves/key) continue ;; esac   # skip when the base var was empty
  if [ -f "$f" ]; then KEY=$(tr -d ' \t\n\r' < "$f" 2>/dev/null); [ -n "$KEY" ] && break; fi
done
[ -z "$KEY" ] && exit 0

API="${JEEVES_API_URL:-https://server.draft0.ai}"
PAYLOAD=$(jq -cn --arg k "$KEY" --arg s "$SKILL" '{key:$k, skill:$s}' 2>/dev/null) || exit 0

# Detached fire-and-forget so a slow/unreachable backend never delays the skill (metering
# ignores the response). Tests set JEEVES_CHECK_SYNC=1 to run it foreground.
if [ "${JEEVES_CHECK_SYNC:-}" = "1" ]; then
  curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 || true
else
  ( curl -s --max-time 8 -X POST "$API/check" -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi

exit 0
