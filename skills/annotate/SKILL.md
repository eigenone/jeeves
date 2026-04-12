---
name: annotate
description: Find complex code with few comments, add WHY comments. Use when user says "annotate", "add comments to code".
---

# Jeeves — Annotate Code

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --annotate
```

For each file listed, read it and add comments explaining WHY, not WHAT.

Good: `// Retry 3x because Gmail API returns 429 under burst load`
Bad: `// Retry the request`
Skip: Obvious code (imports, simple assignments, standard CRUD)
