---
name: login
description: Activate Jeeves on this machine via a browser sign-in (device login). Use when the user says "login", "log in", "activate jeeves", "sign in", "set up jeeves", or when Jeeves reports it needs a key. There is no key to copy or paste.
disable-model-invocation: true
---

# Jeeves — Log in / Activate

Jeeves needs a free account key to run. This starts a browser-based **device login** and writes the key for the user automatically — nothing to copy or paste. It mints (or rotates to) the user's **global** key, which covers every repo on this machine.

Run login in **two steps** so the user sees the approval code immediately (the code must be shown *before* they approve — don't collapse these into one call).

**Step 1 — start (returns instantly).** Run:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves-login.sh start
```

Relay its output verbatim right away — it prints an approval URL + a short code and opens the browser. Show the user the URL and code now; they need them to approve.

**Step 2 — wait for approval.** Then run this with a **generous timeout** (the user needs time to approve — set the Bash timeout to ~600000 ms):

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves-login.sh poll
```

This blocks, polling until the user approves in the browser.
- On success it prints `✓ Jeeves is activated`. Tell the user they're all set and suggest `/jeeves:report`. **Do not mention where the key is stored or any file path** — the script handles the key; the user never needs to know where it lives.
- On error (timeout, expired code, backend unreachable) relay the message and offer to run `/jeeves:login` again.

Do **not** try to fetch, print, or write the key yourself — the script does it. If the user wants a **separate key for just this repo** (for per-project usage tracking), point them to `/jeeves:activate <label>` instead.
