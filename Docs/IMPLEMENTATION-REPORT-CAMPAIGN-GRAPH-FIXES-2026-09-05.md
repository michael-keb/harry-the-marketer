# Implementation Report — Campaign Graph Fixes (2026-09-05)

Implemented all six fixes from
[SOLUTION-DESIGN-CAMPAIGN-GRAPH-FIXES-2026-09-05.md](./SOLUTION-DESIGN-CAMPAIGN-GRAPH-FIXES-2026-09-05.md),
in the prescribed order: **#2 → #6 → #1 → #3 → #4 → #5**.

**Verification:** `node --test tests/*.test.js` — **1506 tests passing** (2 pre-existing todos unchanged).

---

## Summary

| Fix | Problem | Solution |
|-----|---------|----------|
| **#2** | `parseDbTime` appended `Z` to ISO strings → NaN → human-intent guard never ran | Format-aware parser; returns `0` for unparseable input |
| **#6** | Unprocessed replies picked newest-first (`ORDER BY id DESC`) | Changed to `ORDER BY id ASC` — oldest reply routes first |
| **#1** | `pickNoReplyEdge` fell back to undue edges when none were due | Returns `null` when nothing is due; `processWaiting` re-freezes `wait_until` |
| **#3** | `step_send_slots` persisted forever; revisits reused past instants | `clearStepSlots()` on fire/leave/handoff/removal |
| **#4** | New email nodes could save into SMS-only campaigns; unsupported channels stranded leads | Save-time `channelModeConflicts()`; engine mailbox guards; WhatsApp/Telegram rejected at parse |
| **#5** | Leads could wait forever (no anchor, dead shapes, empty `wait_until`) | `waiting_since` migration, parser rejects dead shapes, self-heal + anchor fallback |

---

## Files changed

### Production code (7 files)

| File | Fixes | What changed |
|------|-------|--------------|
| [`server/engine.js`](../server/engine.js) | 1, 2, 3, 4b, 5b, 5c | `parseDbTime`, `pickNoReplyEdge`, `parkWaiting`, `processWaiting`, `enterNode`, `routeReply`, `handOff`, `processCampaign` |
| [`server/step-timing.js`](../server/step-timing.js) | 3 | New `clearStepSlots()` export |
| [`server/playbook.js`](../server/playbook.js) | 4c, 5a | Channel validation; wait/start labeled-edge rejection; reply-before-send BFS check |
| [`server/parity/campaigns.js`](../server/parity/campaigns.js) | 3, 4a | `channelModeConflicts()`; sequence-save guard; slot cleanup on lead/campaign removal |
| [`server/routes.js`](../server/routes.js) | 3 | `clearStepSlots` on single-lead DELETE |
| [`server/db.js`](../server/db.js) | 5 | `waiting_since` column migration |
| [`server/parity/schema.js`](../server/parity/schema.js) | 5 | `waiting_since` in parity ALTER list |

### Tests (6 files)

| File | Coverage |
|------|----------|
| [`tests/parsedbtime.test.js`](../tests/parsedbtime.test.js) | **New** — unit tests for `parseDbTime` |
| [`tests/engine.test.js`](../tests/engine.test.js) | Human-intent ISO guard; wait-node self-heal |
| [`tests/intents-engine.test.js`](../tests/intents-engine.test.js) | Oldest-first reply order; `pickNoReplyEdge` null/due |
| [`tests/intents-campaigns-api.test.js`](../tests/intents-campaigns-api.test.js) | Channel mode save guard; multi-mode accepts both |
| [`tests/playbook.test.js`](../tests/playbook.test.js) | WhatsApp rejection; wait/start edges; reply-before-send |
| [`tests/step-timing.test.js`](../tests/step-timing.test.js) | `clearStepSlots` unit test |

### Docs & scripts

| File | Purpose |
|------|---------|
| [`scripts/scan-running-playbooks.js`](../scripts/scan-running-playbooks.js) | **New** — pre-deploy scan of running campaigns against fix-5a parser rules |
| [`Docs/campaigns/playbook-workflow-test-plan.md`](./campaigns/playbook-workflow-test-plan.md) | Removed known-bug notes from rehearsal cases 16–18 |

---

## Fix-by-fix detail

### Fix #2 — `parseDbTime` handles ISO timestamps

**Before:** `(text) => Date.parse(text.replace(' ', 'T') + 'Z')` — double-`Z` on ISO strings → NaN.

**After:** Exported `parseDbTime()` checks for existing zone markers (`Z` or `±offset`) before appending `Z`. Returns `0` instead of NaN for garbage input.

**Callers affected:** `lifetimeCeiling`, `processWaiting` timeout anchor, human-intent guard (`intent_set_at >= message.created_at`).

---

### Fix #6 — Classify unprocessed replies oldest-first

**Before:** `ORDER BY id DESC LIMIT 1` — newest reply classified first; older reply could re-branch at wrong node.

**After:** `ORDER BY id ASC LIMIT 1` — one message per tick, consumed in arrival order.

---

### Fix #1 — Never fire an undue edge; re-freeze instead

**Before:** `pickNoReplyEdge` used `const pool = due.length ? due : scheduled` — channel-switch preference could pick an undue edge when adaptive timing shifted due times after freeze.

**After:**
- `pickNoReplyEdge` returns `null` when no edge has `at <= now`.
- Both `processWaiting` paths (frozen-wait-due and first-compute) re-freeze `wait_until` to `scheduled[0].at` and return when `null`.

**Termination:** Anchor is fixed; factor bounded by `TIMING_CEILING = 2`; each re-freeze lands on a concrete future instant.

---

### Fix #3 — Invalidate step slots when the step fires

**New helper** in `step-timing.js`:

```js
clearStepSlots(campaignId, leadId, nodeId = null)
```

- `nodeId = null` → delete all slots for the pairing.
- Otherwise → delete `nodeId` and `nodeId>%` (timeout-edge slots like `A>B`).

**Call sites:**
- `branchTimeout` — after timeout edge fires
- Wait-node advance — before `enterNode` on wait done
- `routeReply` — before `enterNode` on reply branch
- `handOff` — when resetting finished child pairing to `queued`
- Lead removal — `routes.js` DELETE, `campaigns.js` bulk remove, campaign delete

---

### Fix #4 — Unsendable channel step cannot save or strand leads

#### 4a. Save-time guard (`parity/campaigns.js`)

Extracted `channelModeConflicts(mode, graph)` — shared by `launchBlockers` and sequence PUT. Returns 409 `channel_immutable` on every save when mode and send channels conflict (email↔sms). `multi` accepts both.

#### 4b. Engine belt-and-braces (`engine.js`)

- `processCampaign`: pauses campaign when graph has email send nodes but no mailbox.
- `enterNode` email branch: parks lead as `needs_attention` with readable message if mailbox missing.

#### 4c. WhatsApp/Telegram trap (`playbook.js`)

Send parser now only accepts `email` and `sms` as channel names. `Send whatsapp:` / `Send telegram:` classify as `unknown` nodes → parse error at save/launch.

---

### Fix #5 — No silent forever-waits

#### Migration

```sql
ALTER TABLE campaign_leads ADD COLUMN waiting_since TEXT DEFAULT ''
```

Added in `server/db.js` and `server/parity/schema.js`.

#### 5a. Parser rejects dead-edge shapes (`playbook.js`)

1. **Wait/Start with labeled edges** — any outgoing edge where `cond.kind !== 'always'` → error.
2. **Reply before send** — BFS from Start; `reply` or `no_reply` edge on a path that hasn't passed a send node → error. `after` edges pre-send remain valid.

**Deploy note:** Running campaigns with these shapes will pause on next tick via the existing invalid-playbook path. Run `node scripts/scan-running-playbooks.js` before deploy.

#### 5b. Self-heal empty `wait_until` on wait nodes

When a lead waits at a wait node with `wait_until = ''`, `processWaiting` schedules from now, sets `wait_until`, logs one `retimed` event.

#### 5c. Timeout anchor fallback

When no outbound exists, anchor uses `waiting_since` (written by `parkWaiting()` on every wait-state entry). Legacy rows without `waiting_since` back-fill on first tick.

**New helper:** `parkWaiting(cl, fields)` — wraps `setLead` and always writes `waiting_since` when entering wait state (wait node, decision node, post-send waiting).

---

## Behaviour preserved (explicitly unchanged)

Per the solution design's "what does not change" list:

- Freeze-on-enter for `wait_until` at timeout edges
- One message classified per tick (hop-budget semantics)
- Adaptive timing and jitter apply only at freeze time
- Channel-switch preference among **due** edges only (fix #1 makes this real)
- OOO `ignoreOOOasReply` behaviour
- Approval gate, send gates, suppression, handoff semantics
- Reply-delay before answering a reply (out of scope)

---

## Test plan updates

[playbook-workflow-test-plan.md](./campaigns/playbook-workflow-test-plan.md) cases updated:

| Case | Change |
|------|--------|
| **16** | Expected behaviour now documents oldest-first routing; known-bug note removed |
| **17** | Human correction sticks; known-bug note removed |
| **18** | Ladder order + re-freeze on adaptive shift; watchpoint note removed |

---

## Pre-deploy checklist

1. Run full test suite: `node --test tests/*.test.js`
2. Scan running campaigns: `node scripts/scan-running-playbooks.js`
3. Review any campaigns that would pause under fix-5a parser rules
4. Sandbox rehearsal: cases 16–19 from the test plan
5. Note in release notes: campaigns with dead-edge playbook shapes will pause with a named reason (honest upgrade from silent hang)

---

## Stats

```
13 files changed, 350 insertions(+), 49 deletions(-)
+ 1 new test file (parsedbtime.test.js)
+ 1 new script (scan-running-playbooks.js)
```

---

## Review addendum (second pass, same day)

A full review of this implementation against the solution design found four
gaps; all are now fixed. **Suite after review fixes: 1511 pass / 0 fail.**

1. **Parser regression (would have broken existing playbooks).** The send-node
   regex had been changed from the channel keyword list to `(\w+)`, which read
   the first word of any colon-less label as a channel — `A[Send intro email]`,
   previously a valid email send with instruction "intro email", became a parse
   error that would pause a running campaign. Restored the keyword alternation
   (`email|sms|whatsapp|telegram`); WhatsApp/Telegram are still refused, now
   with a channel-specific message
   (`channel "whatsapp" is not supported yet — use "Send:" (email) or "Send sms:"`)
   instead of the generic unknown-action one. Regression test added.
2. **Reply-before-send check had a false negative.** The BFS marked nodes
   visited by id alone, so a node reached through a send path first suppressed
   the error for a send-free path reaching it later. Visited state is now
   `(node, sent-yet?)`, with per-edge dedupe so a shape is flagged exactly
   once. Regression test added.
3. **The legacy `PUT /api/campaigns/:id` route bypassed fix 4a entirely.** It
   writes `mermaid` (and can launch) with no channel-mode check — and accepted
   *invalid* mermaid onto a running campaign. It now shares
   `channelModeConflicts` (moved to `server/playbook.js` and exported, so the
   parity route, the legacy route, and `launchBlockers` all use one
   implementation), refuses a mode conflict on any save or launch (409
   `channel_immutable`), and refuses invalid mermaid on a running campaign
   (drafts may still hold work-in-progress). Three tests added in
   `tests/campaigns-audit.test.js`.
4. **`skipUndeliverable` left a node without clearing its step slots** — the
   one leave-a-node path fix #3 missed. `clearStepSlots` added there too.
