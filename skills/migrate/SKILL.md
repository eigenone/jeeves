---
name: migrate
description: Heal a repo for the current Jeeves version after an upgrade — repairs the memory schema and reports obsolete Jeeves references (removed skills, hardcoded plugin paths, stale vendored copies). Use after a Jeeves upgrade, or when the version banner / hygiene banner says "run jeeves --migrate".
---

# Jeeves — Migrate / upgrade heal

Run after upgrading Jeeves (the version banner will prompt you):
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --migrate
```

Safe, explicit, reviewable — Jeeves-authored boilerplate is auto-repaired; anything in YOUR
files is only reported (never silently rewritten).

**(1) Memory schema** — repairs the `MEMORY.md` boilerplate to the current schema, drops empty
dropped-schema sections (e.g. `## Project`), and **reports** entry files typed with a
dropped/unknown type (retype to `user | feedback | reference` yourself).

**(2) Obsolete Jeeves references** — reports (with file:line + the fix) any:
- **Removed-skill commands** in CLAUDE.md / docs — `annotate`/`verify`/`design` → `/jeeves:harden`;
  `reconcile`/`driftcheck` → `/jeeves:drift`; `save`/`extract`/`summary`/`export`/`trace` → the
  `/jeeves` flow or the engine `--flag`.
- **Hardcoded plugin-cache paths** (`…/plugins/cache/jeeves/…/<ver>/…`) that break on upgrade —
  replace with `/jeeves:*` skills or the `jeeves_*` MCP tools.
- **Stale vendored copies** (`scripts/jeeves.ts`, `.claude/hooks/*.sh`) — remove; the installed
  plugin is canonical.

Apply the reported fixes, review the git diff, then commit.
See `/jeeves:memory` for the ongoing hygiene loop.
