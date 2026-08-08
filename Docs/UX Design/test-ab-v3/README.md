# Token A/B v3 — how to run it properly

## Why v2 failed

Your Usage at **2:05–2:13 PM UTC** (~3M tokens in 8 minutes):

| UTC | Tokens | What it actually was |
|---|---|---|
| 2:05–2:09 | ~480k + 1M | test-complex v1 (same chat) |
| 2:12–2:13 | ~176k + **1.3M** | test-ab v2 — **one agent turn** (brief + WYRE + 2 min sleep + HTML) |

**Two problems:**

1. **Same chat** — every turn re-sends the full conversation (17 briefs, 17 WYRE, 28 HTML pages, prior tests). Input alone can exceed 800k tokens.
2. **One turn** — sleeping 2 minutes inside a turn does not split billing. Cursor bills when the turn completes, not when work pauses.

A 2-minute gap **inside one chat** cannot produce a clean WYRE vs HTML comparison.

## The fix

| Step | Where | Expected tokens |
|---|---|---|
| 1. WYRE | **New chat** → paste [`RUN-WYRE.md`](RUN-WYRE.md) | ~20–80k |
| 2. Wait | 2 minutes | 0 |
| 3. HTML | **Another new chat** → paste [`RUN-HTML.md`](RUN-HTML.md) | ~30–100k |

Each fresh chat starts with ~0 history. Usage rows should land **2+ minutes apart** with readable totals.

## Files

| File | Purpose |
|---|---|
| [`complex-brief-v3.md`](complex-brief-v3.md) | New scenario (webhook failure → inbox recovery) |
| [`RUN-WYRE.md`](RUN-WYRE.md) | Copy-paste prompt for chat 1 |
| [`RUN-HTML.md`](RUN-HTML.md) | Copy-paste prompt for chat 2 |
| `complex-brief-v3.wyre` | Created by Run 1 |
| `html/` | Created by Run 2 |

## After both runs

Fill in:

| Phase | UTC time | Tokens |
|---|---|---|
| WYRE | | |
| HTML | | |
