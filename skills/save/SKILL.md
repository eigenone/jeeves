---
name: save
description: Save an artifact — draft, plan, timeline, CSV, brief. Use when user says "save this [name]".
---

# Jeeves — Save Artifact

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --save $ARGUMENTS
```

The script creates a file at `thinking/artifacts/<name>.md`. Write the artifact content there. For CSVs or data files, save with the appropriate extension.
