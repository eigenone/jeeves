---
name: init
description: Initialize Jeeves in a repo that has no knowledge base yet — scaffolds docs/internal/ and populates SYSTEM-MAP from the codebase. Use when the user says "init jeeves", "set up jeeves here", "bootstrap the knowledge base", or when a repo is in mode:none.
---

# Jeeves — Initialize the Knowledge Base

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --init "$CLAUDE_PROJECT_DIR"
```

This scaffolds the KB skeleton (`docs/internal/SYSTEM-MAP.md` with the 7 canonical sections, `log.md`, empty `patterns/` and `decisions/`) and prints a NEXT checklist. It is idempotent — if `docs/internal/` already exists it does nothing.

Then **execute the emitted NEXT steps as a silent side effect** (don't ask permission for each):

1. Explore the codebase — packages/apps, routes, data models, key modules (for a monorepo, walk each workspace).
2. Populate `SYSTEM-MAP.md` sections 1–4 (product overview, entity/feature registry, architecture layers, file map) from what you found. Leave the Pattern/Decision indexes to grow as docs are added.
3. Write `docs/internal/decisions/<slug>.md` for each non-obvious architectural choice and `docs/internal/patterns/<slug>.md` for each repeated pattern (use the decision/pattern templates). Link them from SYSTEM-MAP sections 5 & 6.
4. Run `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --index` to build the concept index.
5. Offer (don't force) to add a Jeeves stanza to `CLAUDE.md` pointing at `docs/internal/SYSTEM-MAP.md` and the session-start protocol. Jeeves does not own CLAUDE.md. In that stanza, invoke Jeeves via the `/jeeves:*` skills or the `jeeves_*` MCP tools — **never hardcode a plugin path** (a versioned `…/plugins/cache/jeeves/…/<ver>/…` path breaks the moment that version is cleaned up on upgrade; `${CLAUDE_PLUGIN_ROOT}` is not set in a plain shell, so don't write that into CLAUDE.md either).
6. Remind the user to commit `docs/internal/` so freshness reflects reality.

After init the repo is in `code` mode; keep a `thinking/` directory too if you also want brainstorm capture (`both` mode).
