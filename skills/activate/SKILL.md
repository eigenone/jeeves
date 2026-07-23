---
name: activate
description: Activate Jeeves with an API key, or create a per-project key for the current repo. Use when the user runs /jeeves:activate, pastes a jvs_ key, or wants to track one repo separately. For first-time setup prefer /jeeves:login (browser sign-in — no key to paste).
disable-model-invocation: true
---

# Jeeves — Activate

`$ARGUMENTS` is what the user passed (a `jvs_` key, a project label, or nothing). Run the activate helper — it handles all three cases and writes the key itself:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves-activate.sh "$ARGUMENTS"
```

Relay the script's output to the user.

- **No argument** → it explains the options: `/jeeves:login` to activate this machine (browser sign-in, nothing to paste), or `/jeeves:activate <label>` to create a per-repo key.
- **A `jvs_` key** → stored as the global key and verified.
- **A label** (e.g. `acme-web`) → mints a project-scoped key for the current repo and drops it in `.jeeves/key`, so that repo's usage tracks separately on the dashboard.

For first-time setup, prefer **`/jeeves:login`** — it's the browser device flow with no key to copy. Do not print or write the key yourself; the script does it.
