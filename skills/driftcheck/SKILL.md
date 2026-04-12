---
name: driftcheck
description: Compare specs and plans against what was actually built. Use when user says "drift check", "compare spec vs code", "what did we skip?".
---

# Jeeves — Drift Check

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --driftcheck
```

For each spec/plan in the output:
1. Read the spec/plan doc
2. Compare against the actual codebase
3. Report: what was built as specified, what diverged, what was skipped, what was added
