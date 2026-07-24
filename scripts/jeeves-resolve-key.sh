#!/usr/bin/env bash
# Jeeves key resolver — the single source of truth for which key applies here, shared by the
# gate, the meter, and the session hooks so they never disagree.
#
# Walks UP from the start dir (arg $1, else CLAUDE_PROJECT_DIR, else PWD) looking for a
# project-local .jeeves/key — the NEAREST one wins — BOUNDED BY THE GIT ROOT, so a repo's
# root key is found even when Claude was launched in a subfolder (monorepo package, src/…).
# Falls back to the global ~/.jeeves/key. The global key file is never mistaken for a project
# key during the walk.
#
# Prints two lines: SOURCE (project|global|none) then the KEY value (empty when none). Always
# exits 0 — a broken git or missing dir just yields the global/none fallback.
set -u
START="${1:-}"; [ -z "$START" ] && START="${CLAUDE_PROJECT_DIR:-}"; [ -z "$START" ] && START="$PWD"
GLOBAL_KEYFILE="${HOME:-}/.jeeves/key"

emit() { printf '%s\n%s\n' "$1" "${2:-}"; exit 0; }

# Bound the upward walk at the git root when inside a repo; otherwise cap the depth so a
# non-git project (research vault, book) still gets a couple of levels but never runs away.
GITROOT=""
command -v git >/dev/null 2>&1 && GITROOT=$(git -C "$START" rev-parse --show-toplevel 2>/dev/null)

DIR="$START"; i=0
while [ -n "$DIR" ] && [ "$i" -lt 12 ]; do
  i=$((i+1))
  _cand="$DIR/.jeeves/key"
  # A project key must not BE the global key file (a non-git dir directly under $HOME would
  # otherwise mis-read ~/.jeeves/key as this repo's key).
  if [ -f "$_cand" ] && [ "$_cand" != "$GLOBAL_KEYFILE" ]; then
    K=$(tr -d ' \t\n\r' < "$_cand" 2>/dev/null)
    [ -n "$K" ] && emit project "$K"
  fi
  # Stop once we've checked the git root (inclusive).
  [ -n "$GITROOT" ] && [ "$DIR" = "$GITROOT" ] && break
  PARENT=$(dirname "$DIR" 2>/dev/null)
  [ "$PARENT" = "$DIR" ] && break   # reached the filesystem root
  DIR="$PARENT"
done

# Fall back to the global key.
if [ -n "$GLOBAL_KEYFILE" ] && [ -f "$GLOBAL_KEYFILE" ]; then
  K=$(tr -d ' \t\n\r' < "$GLOBAL_KEYFILE" 2>/dev/null)
  [ -n "$K" ] && emit global "$K"
fi
emit none ""
