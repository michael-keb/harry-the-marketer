# Run 1 — WYRE only (fresh chat)

**Do this in a brand-new Cursor chat.** Close this project chat first.

1. Open **New Chat**
2. Copy everything below the line into the prompt
3. Send — wait until `complex-brief-v3.wyre` is written and linted
4. Note the Usage row time + tokens
5. Wait **2 minutes**
6. Open another **New Chat** and run [`RUN-HTML.md`](RUN-HTML.md)

---

```
TOKEN TEST — WYRE ONLY. Do not explore the repo beyond the files listed.

Read ONLY:
- Docs/UX Design/test-ab-v3/complex-brief-v3.md

Write ONLY:
- Docs/UX Design/test-ab-v3/complex-brief-v3.wyre

Rules:
- 7 screens exactly as listed in the brief (WebhooksList → NeedsYourOk)
- Use WYRE wireform notation matching existing prototypes in Docs/UX Design/prototypes/ (read ONE file e.g. webhooks.wyre for style — nothing else)
- style: dense sharp accent teal
- Parse/lint with @wireform/core if available; fix until 0 errors
- Do NOT create HTML
- Do NOT read test-complex, test-ab, HTML Prototype, or other briefs
- Stop when the .wyre file is done
```

Expected Usage: **~20–80k tokens** (not 1M+).
