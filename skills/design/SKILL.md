---
name: design
description: Plan what docs to create — analyzes code directories and suggests missing pattern/decision docs. Use when user says "what docs should I create?", "plan the knowledge base".
---

# Jeeves — Design Doc Structure

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --design
```

Review the suggestions. For each CREATE item, ask the user if they want it. Then create the docs using the pattern/decision templates.
