---
name: verify
description: Check existing code comments against actual behavior — find stale or wrong comments. Use when user says "verify comments".
---

# Jeeves — Verify Comments

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --verify
```

For each comment listed:
- Read the surrounding code
- If the comment is wrong → fix it (or flag the code as a bug)
- If the comment is right → leave it
- If the comment is outdated (code changed, comment didn't) → update it
