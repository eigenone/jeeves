---
name: reconcile
description: Check all docs for drift — superseded decisions, stale references, overlapping docs, outdated topics. Use when user says "reconcile", "check for drift".
---

# Jeeves — Reconcile

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --reconcile
```

Execute the actions:
- **SUPERSEDED**: Add a banner at the top of the doc pointing to the replacement
- **STALE REFERENCES**: Update the broken references or add a note
- **OVERLAP**: Read both overlapping docs, suggest consolidation to the user
- **OUTDATED**: Read and verify if still accurate, update if not
