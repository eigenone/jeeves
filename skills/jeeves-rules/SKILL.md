---
name: jeeves-rules
description: Jeeves behavioral rules — session start protocol, continuous capture, file-it-back. Background knowledge for how to maintain the knowledge base.
user-invocable: false
---

# Jeeves Rules

## Session Start (BEFORE anything else)
1. Run `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --check` — this tells you the KB state, what's stale, what's missing
2. Read `thinking/INDEX.md` — decisions, open questions, active topics
3. Read `docs/internal/log.md` — last 5 entries
4. Read `docs/internal/SYSTEM-MAP.md` — your map of the codebase
5. Read the most recent file in `thinking/sessions/` — picks up where last session left off
6. Now respond to whatever the user asked.

## Continuous Capture (do this DURING the conversation, not just at pauses)
Write to disk every 3-4 exchanges. The user may close the tab at any time.

| What happened | Write to |
|---|---|
| Human CONFIRMED a decision during brainstorming (no code yet) | `thinking/decisions/<name>.md` + update `thinking/INDEX.md` Key Decisions |
| Decision was IMPLEMENTED in code | Move/copy to `docs/internal/decisions/<name>.md` — this is the source of truth once code exists |
| Human PROPOSED an idea (thinking out loud, not validated) | `thinking/topics/<name>.md` as a proposal — NOT a decision |
| Human shared business/industry context | Append to relevant `thinking/topics/` file |
| Human rejected an idea with reasoning | Topic file under "Rejected approaches" |
| Human raised a question without answering | `thinking/INDEX.md` Open Questions |
| 3-4 exchanges without writing anything | Batch update to topic files and INDEX.md NOW |
| Built something non-obvious | `docs/internal/patterns/<name>.md` if no pattern doc exists |

**Proposals are NOT decisions.** A decision requires explicit confirmation after discussion.

## After Building Something
At every natural pause (finished a feature, about to commit, switching tasks):
1. Run `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts` — it analyzes what changed and tells you exactly what to document
2. Execute every ACTION it outputs — create pattern docs, update SYSTEM-MAP, fix broken paths
3. Do not skip actions. Do not summarize them. Execute each one.

## After Committing
The post-commit hook runs Jeeves automatically. If it outputs actions, execute them before moving on.

## Session End
When the user says "I'm done", "wrapping up", "handoff", or signals end of session:
1. Run `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --handoff` — this syncs all docs AND writes a handoff file
2. The handoff goes to `thinking/sessions/YYYY-MM-DD-handoff.md` with what happened, next steps, and open questions
3. Update `thinking/INDEX.md` with decisions confirmed and open questions from this session
4. Update relevant `thinking/topics/` files with latest state

## File It Back (do this continuously)
When you discover something non-obvious — update the relevant doc before moving on.
- **Gotcha?** → Add to the relevant pattern doc's Gotchas section
- **Decision confirmed + code exists?** → Create `docs/internal/decisions/<name>.md` (source of truth)
- **Decision confirmed, no code yet?** → Create `thinking/decisions/<name>.md` + add to `thinking/INDEX.md`
- **Bug?** → Add to `docs/internal/codebase-audit.md`
- **New entity/route/feature?** → Update `SYSTEM-MAP.md`
- **New pattern (something you did 2+ times)?** → Create `docs/internal/patterns/<name>.md`

## Pre-Push
Before pushing: run the doc linter — `npx tsx scripts/lint-docs.ts` if the project ships its own (a customization point the pre-push gate also prefers), otherwise `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/lint-docs.ts`. Fix any broken paths first.

## On Demand
| What to say | What runs |
|-------------|-----------|
| "jeeves" or "sync docs" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts` |
| "handoff" or "wrap up" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --handoff` |
| "health check" | `bash ${CLAUDE_PLUGIN_ROOT}/scripts/health-score.sh` |
| "heal docs" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/heal-docs.ts --fix` |
| "audit" | Scan code for bugs, write to `codebase-audit.md` |
| "rebuild index" or "concept index" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --index` |
| "annotate" or "add comments" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --annotate` — finds under-commented complex code, tells you where to add WHY comments |
| "verify comments" | `npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --verify` — finds comments that make claims, tells you to check them against actual code |

## Memory (how to work with this user & repo)
`memory/` (repo root) is the COLLABORATION layer — durable preferences, feedback, working style, reference facts — distinct from the code KB. Jeeves injects it at session start automatically.
- When the user states a lasting preference/correction/style, or a stable setup fact → write `memory/<type>_<slug>.md` (type = user|feedback|reference; optional created/confirmed dates) + index it in `memory/MEMORY.md`. Capture SILENTLY as it surfaces (the session hook injects this instruction). Use `/jeeves:memory`.
- Memory is EPHEMERAL: overwrite or DELETE entries that stop being true (don't supersede-with-history like the KB). When the Stop hook flags "memory hygiene" at session end, prune — delete stale, merge overlapping/near-duplicate, re-verify stale-dated, fix broken `[[links]]`.
- Do NOT put code knowledge here — that belongs in `docs/internal/decisions|patterns`.

## Update Before Create
Before creating a new doc, check if an existing doc covers the topic. UPDATE existing docs.

## NEVER do these
- Do NOT skip Jeeves actions — if it says to create a pattern doc, create it
- Do NOT wait for the user to ask you to document — run Jeeves at natural pauses
- Do NOT skip reading log.md and SYSTEM-MAP.md at session start
