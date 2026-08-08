# Run 2 — HTML only (fresh chat, 2+ min after WYRE)

**Do this in a brand-new Cursor chat** — not the WYRE chat.

1. Confirm `complex-brief-v3.wyre` exists from Run 1
2. Open **New Chat**
3. Copy everything below the line into the prompt
4. Send — wait until `html/` has 7 pages + `index.html`
5. Note the Usage row time + tokens
6. Compare to Run 1

---

```
TOKEN TEST — HTML ONLY. Do not explore the repo beyond the files listed.

Read ONLY:
- Docs/UX Design/test-ab-v3/complex-brief-v3.md
- Docs/UX Design/test-ab-v3/complex-brief-v3.wyre
- Docs/UX Design/HTML Prototype/css/harry.css (for class names)

Write ONLY:
- Docs/UX Design/test-ab-v3/html/01-webhooks-list.html … 07-needs-your-ok.html
- Docs/UX Design/test-ab-v3/index.html

Rules:
- One HTML page per WYRE screen, linked in journey order
- Reuse harry.css via relative path: ../HTML Prototype/css/harry.css
- Minimal inline HTML — no build script, no JS framework
- Match screen content from the .wyre file
- Do NOT create or edit .wyre files
- Do NOT read test-complex, test-ab, prototypes folder, or other briefs
- Stop when html/ is done
```

Expected Usage: **~30–100k tokens** (not 1M+).
