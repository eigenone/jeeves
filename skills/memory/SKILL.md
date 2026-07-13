---
name: memory
description: Add, curate, or prune the project memory/ layer — durable prefs/feedback/reference on how to work with this user & repo. Use when the user gives a lasting preference or correction, says "remember this", or asks to review/prune memories.
---

# Jeeves — Memory (how to work with this user & repo)

`memory/` (repo root) is the **collaboration layer** — preferences, feedback, working
style, reference facts. It is distinct from the code KB (`docs/internal/decisions|patterns`,
which is *about the code*). It is typed, git-tracked, and **ephemeral**: overwrite or
DELETE entries that stop being true — do NOT supersede-with-history like the KB.

Jeeves injects the index + user/feedback entries at session start automatically (via the
session-check hook), so what you write here actually gets read next time.

## When to write a memory
- The user states a durable preference / correction / working style ("always X", "don't
  Y", "I prefer Z", "next time do W").
- Stable reference facts about the setup (infra, accounts, external resources, cadences).
- NOT code knowledge — that goes to `docs/internal/decisions|patterns`.

## How to write one
Create `memory/<type>_<slug>.md` with this shape:
```
---
name: <kebab-case-slug>
description: <one line — used to judge relevance when recalled>
metadata:
  type: user | feedback | reference | project
---

<the fact>
**Why:** <reasoning>            # feedback/project
**How to apply:** <what to do>  # feedback/project
<link related entries with [[their-name]]>
```
Then add a one-line pointer under the matching section of `memory/MEMORY.md`.
Before creating: check for an existing entry that already covers it — UPDATE it instead
of adding a near-duplicate.

## Hygiene — prune (ephemeral by design)
Do this when the session-check hook flags "MEMORY HYGIENE", or when asked:
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --memory-check
```
Then act on what it reports:
- **DELETE** entries that are no longer true (just remove the file + its index line).
- **MERGE** overlapping entries (duplicate descriptions) into one.
- **FIX** broken `[[links]]`.
Keep the set small and relevant — a lean, current memory beats a large stale one.
