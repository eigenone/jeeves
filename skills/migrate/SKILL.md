---
name: migrate
description: Heal a memory/ store written by an older Jeeves — repairs the MEMORY.md scaffold to the current schema and reports entries that need manual retyping. Use after a major Jeeves upgrade, or when the hygiene banner says "run jeeves --migrate".
---

# Jeeves — Migrate memory to the current schema

Run:
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --migrate
```

What it does (safe, explicit, reviewable — never a silent write):
- **Repairs the Jeeves-authored `MEMORY.md` boilerplate** (title + intro + section headers)
  to the current schema. Your index lines and entry files are left untouched.
- **Drops empty dropped-schema sections** (e.g. `## Project`, removed in v4.11.0).
- **Reports** — does NOT modify — entry files typed with a dropped/unknown type. Jeeves
  can't know the right replacement, so retype those to `user | feedback | reference`
  yourself (and move their index line under the matching section).

After running, review the git diff, act on any reported entries, then commit.
See the `/jeeves:memory` skill for the ongoing hygiene loop.
