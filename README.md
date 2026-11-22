# Jeeves

**Your AI doesn't remember. Jeeves does.**

Session memory and living documentation for Claude Code — Jeeves captures your decisions and keeps your docs in sync with the code, so context survives across sessions.

## Install

```
/plugin marketplace add eigenone/jeeves
/plugin install jeeves@jeeves
```

Then **restart Claude Code** so the plugin loads.

## Setup

Jeeves needs a free account. Activating takes one command — no key to copy or paste.

1. Run **`/jeeves:login`** in Claude Code. It opens your browser, you approve, and Jeeves writes your key for you. One login covers every repo on the machine.
2. Start working. Jeeves loads your context automatically; run **`/jeeves:init`** the first time in a repo that has no knowledge base yet.

Working on a headless/CI machine, or want a repo tracked separately? Use **`/jeeves:activate <label>`** to create and store a key without the browser flow.

## Commands

| Command | What it does |
|---------|-------------|
| `/jeeves:login` | Activate this machine via a browser sign-in (no key to copy) |
| `/jeeves:activate` | Activate with an API key, or mint a per-project key for this repo |
| `/jeeves:init` | Scaffold Jeeves in a repo that has no knowledge base yet |
| `/jeeves` | Sync docs with code — heal broken paths, rebuild the concept index, report health |
| `/jeeves:end` | End a session — capture decisions, write a handoff with next steps |
| `/jeeves:memory` | Add, curate, or prune the project memory layer (durable prefs, feedback, references) |
| `/jeeves:report` | Your value ledger — how much durable knowledge Jeeves has surfaced for you |
| `/jeeves:harden` | Quality suite — annotate code, verify comments, lint docs, heal paths, health score |
| `/jeeves:drift` | Detect drift — stale doc references, and spec/plan vs. what was actually built |
| `/jeeves:research` | Web research on a topic, findings saved into your knowledge base |
| `/jeeves:archive` | Stash current thinking and start fresh |
| `/jeeves:migrate` | Heal a repo after a Jeeves upgrade (repairs the memory schema) |

## Updating

```
/plugin update jeeves@jeeves
```

Then **restart Claude Code** — a running session keeps the old plugin code loaded until it reloads. Jeeves prints a one-line notice when the version on disk is newer than the one the session loaded.

## Pricing

Free while we're in early access — everything's included with unlimited usage. Just run **`/jeeves:login`** to create a free account and activate. Later, the heavier Pro skills (`harden`, `drift`, `research`, `archive`) will draw on a generous monthly allowance; the everyday capture-and-recall loop stays free.

## More

- Website: [draft0.ai](https://draft0.ai)
- API: `https://server.draft0.ai`
