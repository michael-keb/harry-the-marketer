# A/B Token Test — v2

**Brief:** [`complex-brief-v2.md`](complex-brief-v2.md) — Prospect fetch under pressure (7 screens)

## Timestamps (AEST) — match to Usage dashboard (UTC + 10h)

| Phase | Start | End |
|---|---|---|
| **1 · WYRE** | 00:13:48 | 00:13:58 |
| **2 min gap** | 00:13:58 | 00:16:00 |
| **2 · HTML** | 00:16:00 | 00:16:15 |

## Files

| Phase | Output |
|---|---|
| Brief | `complex-brief-v2.md` |
| WYRE | `complex-brief-v2.wyre` (7 screens, 0 parse errors) |
| HTML | `html/` (7 pages) + `index.html` |

## View HTML

```bash
cd "Docs/UX Design/test-ab"
python3 -m http.server 8082
# → http://localhost:8082
```

## Expected Usage rows (UTC)

| UTC | Phase |
|---|---|
| ~2:13 PM | WYRE turn(s) |
| _(2 min gap — no work)_ | |
| ~2:16 PM | HTML turn(s) |

Compare token totals between those windows only.

---

## Result: test invalidated

Usage showed **~176k + 1.3M at 2:12–2:13 PM UTC** — one agent turn, not two phases. The 2-minute sleep did not split billing, and this chat's full history inflated input to ~1M+.

**Use [`../test-ab-v3/`](../test-ab-v3/) instead** — two fresh chats with copy-paste prompts.
