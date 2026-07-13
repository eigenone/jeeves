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
  type: user | feedback | reference
created: <YYYY-MM-DD>
confirmed: <YYYY-MM-DD>
---

<the fact>
**Why:** <reasoning>            # feedback
**How to apply:** <what to do>  # feedback
<link related entries with [[their-name]]>
```
The three types: **user** (who they are), **feedback** (how to work with them), **reference**
(stable external/setup facts). Project goals/constraints are NOT memory — they belong in the
code KB (`docs/internal`). `created`/`confirmed` are optional dates; set them so stale entries
can be aged out. When you re-affirm an existing memory, bump `confirmed` instead of duplicating.

Then add a one-line pointer under the matching section of `memory/MEMORY.md`.
Before creating: check for an existing entry that already covers it — UPDATE it instead
of adding a near-duplicate.

## Recall mid-task
The index + user/feedback entries are injected at session start (prompt-scored to your
current prompt). To pull a specific memory while working, search it:
`jeeves_search` with `scope: "memory"` (MCP), or grep `memory/`.

## Hygiene — prune (ephemeral by design)
The **Stop hook** surfaces a "memory hygiene" banner at session end when the store has
drifted. Prune then, or any time, by running:
```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --memory-check
```
Then act on what it reports:
- **DELETE** entries that are no longer true (just remove the file + its index line).
- **MERGE** duplicate *and near-duplicate* descriptions into one.
- **RE-VERIFY** stale-dated entries (not confirmed in 120+ days) — update `confirmed` or delete.
- **FIX** broken `[[links]]`; correct any unknown `type`.
Keep the set small and relevant — a lean, current memory beats a large stale one.
