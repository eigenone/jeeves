# Jeeves

**Your AI doesn't remember. Jeeves does.**

Session memory and living documentation for Claude Code.

## Install

```
/plugin marketplace add eigenone/jeeves
/plugin install jeeves@eigenone-jeeves
```

Then reload: `/reload-plugins`

## Setup

1. Sign up: `curl -X POST https://jeeves-api.singhal-priyank.workers.dev/signup -H "Content-Type: application/json" -d '{"email":"you@example.com","persona":"builder"}'`
2. Set your key: `export JEEVES_KEY=jvs_your_key_here` (add to .zshrc)
3. Start a session — Jeeves loads your context automatically

## Commands

| Command | What it does |
|---------|-------------|
| `/jeeves` | Sync docs with code — heal paths, rebuild index, report health |
| `/jeeves:end` | End session — capture decisions, write handoff |
| `/jeeves:summary` | Everything decided across all sessions |
| `/jeeves:harden` | Quality suite — annotate code, verify comments, lint |
| `/jeeves:research` | Web research, save findings |
| `/jeeves:export` | Shareable doc for your team |
| `/jeeves:trace` | End-to-end feature flow |
| `/jeeves:design` | Plan what docs to create |
| `/jeeves:reconcile` | Check docs for drift |
| `/jeeves:driftcheck` | Compare specs vs actual code |
| `/jeeves:annotate` | Add WHY comments to code |
| `/jeeves:verify` | Check comment accuracy |
| `/jeeves:save` | Save artifacts (drafts, plans) |
| `/jeeves:archive` | Stash thinking, start fresh |
| `/jeeves:extract` | File back knowledge from conversation |

## Free vs Pro

Free (forever): `/jeeves`, `/jeeves:end`, `/jeeves:summary`
Pro (14-day trial): All 15 commands

## More

- Website: [trustjeeves.com](https://trustjeeves.com)
- API: `https://jeeves-api.singhal-priyank.workers.dev`
