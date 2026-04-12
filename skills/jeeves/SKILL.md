---
name: jeeves
description: Sync docs with code, heal broken paths, rebuild concept index, report health. Use when the user says "jeeves", "sync docs", or after building features.
---

# Jeeves — Sync

Run the Jeeves engine to analyze the project and output actions.

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts
```

Read the output. For each ACTION line, execute it:
- **[create]**: Create the specified file with the described content
- **[update]**: Read the target file, make the described update
- **[fix]**: Run `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/heal-docs.ts --fix` to auto-heal broken paths
- **[log]**: Append the described line to `docs/internal/log.md`

Do not skip actions. Do not summarize them. Execute each one.

If no actions are needed, tell the user "Docs are in sync."
