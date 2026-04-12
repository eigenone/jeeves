---
name: harden
description: Quality suite — annotate code, verify comments, lint docs, heal paths, health score. Use when user says "harden", "check quality", "annotate", "verify comments".
---

# Jeeves — Harden

Run the full quality suite. If the user specified a sub-command (annotate, verify), run only that. Otherwise run all.

## Full suite (default)

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --annotate
```
Execute the annotate actions (add WHY comments to complex code).

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --verify
```
Execute the verify actions (check comment claims against code).

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts
```
Fix any broken paths found.

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/heal-docs.ts --fix
```
Auto-heal what can be healed.

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/health-score.sh
```
Report the health score to the user.

## Sub-commands

If user said "annotate" or "add comments":
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --annotate
```

If user said "verify comments":
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --verify
```
