---
name: end
description: End session — capture decisions, write handoff with next steps. Use when user says "wrap up", "I'm done", "handoff", or signals end of session.
---

# Jeeves — End Session

```bash
npx tsx ${CLAUDE_PLUGIN_ROOT}/scripts/jeeves.ts --handoff
```

Execute all actions from the output, then:

1. The handoff doc was written to `thinking/sessions/`. Confirm the file path to the user.
2. Update `thinking/INDEX.md` with any decisions confirmed during this session.
3. Update relevant `thinking/topics/` files with latest state.
