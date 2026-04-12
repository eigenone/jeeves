---
name: trace
description: Trace a feature end-to-end through all layers. Use when user says "trace [feature]", "how does [X] work end to end?".
---

# Jeeves — Trace

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --trace $ARGUMENTS
```

Read the related docs and code files listed in the output. Then produce a trace doc:

1. Start from the user-facing entry point (UI, API route, CLI command)
2. Follow the data flow through each layer (route → action → service → DB)
3. Note every file touched and what it does in the flow
4. Note integration points (external APIs, background jobs, caches)
5. Write the trace doc to the path suggested in the output
