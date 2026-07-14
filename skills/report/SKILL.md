---
name: report
description: Show Jeeves's value ledger — how much durable knowledge (memory + KB docs) it has surfaced for you over time. Use when the user asks "is Jeeves helping?", "what has Jeeves done for me", or wants usage/impact stats.
---

# Jeeves — Value report

Run:
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --report
```

It reads the LOCAL usage log (`~/.jeeves-usage.log`, no network) and summarizes what
Jeeves has surfaced — memory entries recalled at session start and KB docs surfaced by the
read loop — across all projects, plus a last-30-days view.

This measures **surfacing** (knowledge Jeeves put in front of the agent that you'd otherwise
have re-derived), not proven recall — it's an honest local signal, not telemetry. Add `--json`
for a machine-readable summary.
