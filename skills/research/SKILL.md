---
name: research
description: Web research on a topic, save findings. Use when user says "research [topic]".
---

# Jeeves — Research

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --research $ARGUMENTS
```

The script creates a research template at `thinking/research/<topic>.md`. Fill it in:

1. Use WebSearch and WebFetch to research the topic
2. Fill in **Key Findings** with the most important discoveries
3. Fill in the **Sources** table with URLs, dates, and key takeaways
4. Fill in **Implications** — what this means for the project
5. Save everything — the user may close the tab at any time
