---
name: activate
description: Activate Jeeves with your API key. Use when user says "activate", provides a jvs_ key, or after signing up at trustjeeves.com.
disable-model-invocation: true
---

# Jeeves — Activate

The user is providing their Jeeves API key. Store it so all future sessions can use it.

1. The key should start with `jvs_`. If not, tell the user to get one at trustjeeves.com

2. Write the key to `~/.jeeves/config`:

```bash
mkdir -p ~/.jeeves
echo "$ARGUMENTS" > ~/.jeeves/key
chmod 600 ~/.jeeves/key
```

3. Verify the key works:

```bash
curl -s -X POST https://jeeves-api.singhal-priyank.workers.dev/check -H "Content-Type: application/json" -d "{\"key\":\"$ARGUMENTS\",\"skill\":\"harden\"}"
```

If the response says `"decision": "allow"` — tell the user "Jeeves is activated! All Pro modes are available."

If it says `"decision": "deny"` — tell the user the key is invalid or expired and to check trustjeeves.com.

4. Tell the user: "Jeeves is ready. Try `/jeeves:summary` to see your project state."
