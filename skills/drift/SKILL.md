---
name: drift
description: Check for drift — stale/superseded doc references vs the code, AND spec/plan vs what was actually built. Use when the user asks "what's out of sync", "check for drift", "are the docs still accurate", or "did we build what we planned".
---

# Jeeves — Drift check

Two complementary lenses (run whichever fits the question, or both):

**Docs ↔ code drift** — superseded decisions, stale references, broken paths, overlap:
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --reconcile
```

**Spec/plan ↔ built drift** — plans and specs vs what actually shipped (checkbox accounting):
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --driftcheck
```

Act on what they report: update or supersede stale decisions, fix broken paths (or run
`/jeeves` to auto-heal), and reconcile plan items that are done-but-unchecked or checked-but-absent.
