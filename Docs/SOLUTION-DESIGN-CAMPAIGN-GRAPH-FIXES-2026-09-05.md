# Solution Design — Campaign Graph Fixes (2026-09-05)

Implements the six fixes in
[CAMPAIGN-GRAPH-CURRENT-VS-FUTURE-2026-09-05.md](./CAMPAIGN-GRAPH-CURRENT-VS-FUTURE-2026-09-05.md).
Root-cause detail: [AUDIT-CAMPAIGN-GRAPH-2026-09-04.md](./AUDIT-CAMPAIGN-GRAPH-2026-09-04.md).
Hands-on regression rehearsals: cases 16–19 in the
[playbook workflow test plan](./campaigns/playbook-workflow-test-plan.md).

## Guiding principles

1. **The frozen clock is the contract.** `wait_until` set at first compute is
   when the lead is *allowed* to move; nothing may fire before its own edge's
   timer, and nothing may silently never fire. Every change below preserves
   freeze-on-enter.
2. **No behaviour change outside the six defects.** The "what does not change"
   list in the flow map is binding.
3. **Each fix lands with its own tests and can ship independently**, in the
   order below. No fix depends on a later one; #5 uses the migration introduced
   with it.

Implementation order: **#2 → #6 → #1 → #3 → #4 → #5** (smallest and
human-protecting first; broadest last).

---

## Fix #2 — `parseDbTime` must handle ISO timestamps

**Root cause.** `engine.js:38`:
`(text) => Date.parse(text.replace(' ', 'T') + 'Z')` — correct for SQLite
`datetime('now')` strings, but `intent_set_at` is written as
`new Date().toISOString()` (engine.js:1233, `nowIso()` in parity/http.js,
parity/inbox.js:1579), which already ends in `Z`. The extra `Z` → `Date.parse`
→ NaN → the `humanSet` guard at engine.js:1314 is always false.

**Design.** Make the helper format-aware; never change the stored formats.

```js
const parseDbTime = (text) => {
  if (!text) return 0
  let s = String(text).trim().replace(' ', 'T')
  // SQLite datetimes carry no zone marker; they are UTC. ISO strings from
  // toISOString already end in Z (or carry an offset) — leave those alone.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z'
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}
```

Returning 0 for unparseable input (instead of NaN) keeps every existing
comparison well-defined.

**Callers affected** (all in engine.js): `lifetimeCeiling` (SQLite input —
unchanged behaviour), `processWaiting` timeout anchor (SQLite — unchanged),
and the `humanSet` guard (ISO — now works).

**Edge cases.**
- `intent_set_at` written by parity/campaigns.js:2370 uses `applied.at` from
  suppression — verify its format in the test, both branches must parse.
- Equal timestamps: guard uses `>=`, so a correction in the same second as the
  message still wins. Keep `>=`.

**Tests** (`tests/engine.test.js` or new `tests/parsedbtime.test.js`):
- Unit: SQLite format, ISO-with-Z, ISO-with-offset, empty, garbage → expected ms/0.
- Integration: lead waiting with an unclassified inbound; set
  `intent`/`intent_set_by`/`intent_set_at` (ISO, after the message) on the row;
  tick; assert the message got the *human's* intent stamped and the classifier
  was never called (no `classified` event), and the lead did not move.

---

## Fix #6 — Classify unprocessed replies oldest-first

**Root cause.** engine.js:1301-1303 picks `ORDER BY id DESC LIMIT 1`. With two
unclassified replies, the newest routes first; a later tick classifies the
*older* one against the node the lead has since reached and branches again.

**Design.** One-line change: `ORDER BY id DESC` → `ORDER BY id ASC` in the
`unprocessed` query. Keep one-message-per-tick (preserves hop-budget semantics
and lets fix #2's guard interleave correctly). The conversation is then
consumed in arrival order: oldest reply routes from the node that email was
actually answering; the newer reply is evaluated at wherever that routing
landed — which is the true conversational order.

**Edge cases.**
- Human correction between the two replies: with #2 fixed, the guard stamps
  the older message and returns; the newer is classified next tick. Correct.
- OOO-ignored replies (`routeReply` returns false without stamping when
  `ignoreOOOasReply`): the message *was* stamped before the edge check
  (engine.js:1212), so it cannot loop. Unchanged.

**Tests** (`tests/intents-engine.test.js`):
- Insert two inbound messages (ids ascending) before a tick; assert the first
  tick classifies the older, the lead branches once per message in id order,
  and the final node matches oldest-then-newest routing.
- Regression shape from the audit: reply A ("question") then reply B
  ("interested") → lead must end where question→…→interested leads, and the
  `branched` events must appear in that order.

---

## Fix #1 — Never fire an undue edge; re-freeze instead

**Root cause.** `pickNoReplyEdge` (engine.js:173-181) falls back to the full
edge set when nothing is due (`const pool = due.length ? due : scheduled`),
and the channel-switch preference then selects the switch edge out of undue
edges. Undue-at-elapse happens because `processWaiting` recomputes due times
with the *current* adaptive factor (engine.js:1361-1389), which can have grown
since freeze (intent → `not now`/`out of office`; `openTrackingWorks` flipping
campaign-wide).

**Design.** Two changes in engine.js:

1. `pickNoReplyEdge` returns `null` when nothing is due — the switch
   preference only ever sees due edges:

```js
function pickNoReplyEdge(ctx, fromNodeId, scheduled, now = nowMs()) {
  const due = scheduled.filter((s) => s.at <= now)
  if (!due.length) return null
  const fromCh = channelOfNode(ctx.graph.nodes[fromNodeId]) || 'email'
  const switchTo = switchTargetChannel(ctx.campaign, fromCh)
  if (!switchTo) return due[0]
  return due.find((s) => channelOfNode(ctx.graph.nodes[s.edge.to]) === switchTo) || due[0]
}
```

2. Both call sites in `processWaiting` handle `null` by **re-freezing**
   `wait_until` to the new soonest instant and returning — the lead simply
   waits out the recomputed schedule:

```js
const chosen = pickNoReplyEdge(ctx, cl.node_id, scheduled)
if (!chosen) {
  setLead(cl, { wait_until: new Date(scheduled[0].at).toISOString() })
  return
}
```

(First-compute path at engine.js:1403-1409 already freezes to `scheduled[0].at`
and only proceeds when it is `<= now`, in which case `scheduled[0]` is due —
`pickNoReplyEdge` cannot return null there, but the same guard is applied for
uniformity.)

**Termination argument** (no infinite re-freeze): the anchor (`since`, last
outbound `created_at`) is fixed; `factor` is bounded by `TIMING_CEILING = 2`
and `jitter` by 1.15, so every recomputed instant is ≤
`anchor + 2 × 1.15 × maxEdgeMs` plus the deterministic window/quiet-hour
advance. Each re-freeze lands on a concrete future instant; when the clock
passes the bound, at least one edge is due. A lead re-freezes at most a
handful of times, only when its signals genuinely changed mid-wait.

**Trail noise.** Re-freezing writes no event (the original freeze never did).
The `branched` event on the eventual fire keeps its `(reason)` suffix, which
explains any stretch.

**Tests** (`tests/engine.test.js` / `tests/playbook-timing.test.js`):
- Two-edge ladder `no reply 3d → email`, `no reply 7d → sms` (switch config
  email→sms). Freeze with factor 1; before elapse, register an open on
  *another* lead's message (flips `openTrackingWorks`). Advance clock to day 3;
  tick. Assert: **no branch**, `wait_until` re-frozen to ~day 4.2. Advance to
  day 4.2; tick. Assert: branch fires the **3d email edge**, never the SMS edge.
- Advance to day 9.8+ with no reply: SMS edge fires (switch preference among
  due edges still works).
- Unit: `pickNoReplyEdge` returns null on an all-future schedule; returns the
  switch edge only when it is due.

---

## Fix #3 — Invalidate step slots when the step fires

**Root cause.** `step_send_slots` is keyed `UNIQUE(campaign_id, lead_id,
node_id)` (db.js:317) and `getOrCreateStepSlot` (step-timing.js:101-110)
returns the persisted `chosen_at` forever; nothing deletes rows. A lawful
revisit (a `no reply` cycle, or a subsequence handoff resetting a finished
child pairing to `'queued'`, engine.js:470-474) reuses an instant already in
the past → the windowed step fires immediately.

**Design.** A slot's lifetime is *one arming of one step*. Add a helper to
step-timing.js:

```js
// Slot keys are the wait node's id, or `${nodeId}>${edge.to}` for timeout
// edges — clearing a node clears both forms.
export function clearStepSlots(campaignId, leadId, nodeId = null) {
  if (nodeId === null) {
    db.prepare('DELETE FROM step_send_slots WHERE campaign_id = ? AND lead_id = ?')
      .run(campaignId, leadId)
    return
  }
  db.prepare(
    `DELETE FROM step_send_slots WHERE campaign_id = ? AND lead_id = ?
       AND (node_id = ? OR node_id LIKE ?)`
  ).run(campaignId, leadId, String(nodeId), `${nodeId}>%`)
}
```

(`nodeId` comes from the parser's `[A-Za-z0-9_-]+` token — no LIKE wildcards
can appear in it; `>` cannot occur inside an id, so the prefix match is exact.)

**Call sites** (engine.js unless noted):
- `branchTimeout` — after a timeout edge fires: `clearStepSlots(cl.campaign_id, cl.lead_id, cl.node_id)`.
- Wait-node advance (engine.js:1276-1281) — same call before `enterNode`.
- `routeReply` — when a reply edge fires (the node's timeout slots are now
  stale): same call before `enterNode(edge.to)`.
- `handOff` — on re-enrolling a finished child pairing to `'queued'`:
  `clearStepSlots(match.id, cl.lead_id)` (all slots for that pairing).
- Lead removal from a campaign (routes.js:756, parity/campaigns.js:1860, and
  the campaign-wide delete at parity/campaigns.js:1584): clear all slots for
  the pairing/campaign, so a deliberate re-enrol starts clean.

**Edge cases.**
- Reused slot *within* one arming (freeze → several ticks → fire) is the
  intended stickiness and is untouched: clearing happens only on fire/leave.
- Same-tick loop A→B→A: the hop budget still applies; the second arming of A
  rolls a fresh slot, which is the fix working.

**Tests** (`tests/step-timing.test.js` + `tests/playbook-timing.test.js`):
- Unit: `clearStepSlots` removes `A` and `A>B` but not `AB` or `B`.
- Integration: playbook `F -- no reply Xs window … --> G -- no reply Xs --> F`;
  drive one full loop; assert the second visit to F creates a **new** slot row
  (different `created_at`, in-window `chosen_at` in the future), not the old
  instant.
- Handoff: finish child pairing, hand off again; assert zero slots survive the
  reset.

---

## Fix #4 — An unsendable channel step can neither be saved nor strand leads

Two layers, plus one rider.

### 4a. Save-time guard (parity/campaigns.js)

**Root cause.** The post-launch channel freeze skips node ids that didn't
exist before (`if (!prevChannels.has(nodeId)) continue`, ~line 1283), so a
*new* email send node saves into a running `sms`-mode campaign; the launch
check (lines 495-506) only runs at launch.

**Design.** Extract the mode-vs-channel check from `launchBlockers` into one
function and call it from both places:

```js
function channelModeConflicts(mode, graph) {
  const sendNodes = Object.values(graph.nodes).filter((n) => n.type === 'send')
  const has = (ch) => sendNodes.some((n) => String(n.channel || 'email').toLowerCase() === ch)
  if (mode === 'email' && has('sms')) return 'Email-mode campaigns cannot include SMS send steps — switch to multi or remove SMS steps'
  if (mode === 'sms' && has('email')) return 'SMS-mode campaigns cannot include email send steps — switch to multi or remove email steps'
  return null
}
```

In the sequence PUT (after the parse-valid check): a conflict → the same 409
`channel_immutable`-style error shape, message from the function. Applied on
**every** save regardless of status — a draft campaign with a conflict would
only fail later at launch anyway; failing early is strictly more honest.
`launchBlockers` swaps its two inline blocks for the shared function.

### 4b. Engine belt-and-braces (engine.js)

For rows that already exist (or arrive by any path the routes don't cover),
the engine must degrade readably, at **campaign** level — one clear pause,
not 165 stranded leads:

- In `processCampaign`, after the graph parses: if `!mailbox` and the graph
  contains an email send node → pause the campaign with
  `campaign_paused` / detail: `"the playbook has an email step but this
  campaign has no connected mailbox — attach one or remove the step"`, and
  return (mirrors the existing mailbox-missing pause at engine.js:1421-1424).
- In `enterNode`'s email branch: `const mailbox = mailboxFor(ctx, cl);
  if (!mailbox) { setLead needs_attention with that same sentence; return false }`
  — reachable only if 4a and the campaign-level check are both bypassed;
  never a TypeError.

### 4c. Rider — the WhatsApp/Telegram trap (same mechanism)

`playbook.js:118` parses `Send whatsapp:` / `Send telegram:`, no launch
blocker covers them, and the engine strands each lead with
`Channel "…" is not supported yet` (engine.js:922). Same family, two-line fix:
remove `whatsapp|telegram` from the parser's channel alternation (unknown
channel then classifies as an `unknown` node → existing parse **error**, caught
at save and launch). Re-add the words when those channels ship
(Docs/messaging-channels-plan.md phases 2–3).

**Tests** (`tests/parity-campaigns.test.js`, `tests/engine.test.js`,
`tests/playbook.test.js`):
- PUT adding a new email node to a running sms campaign → 409, campaign
  unchanged; same for a new sms node on email mode; `multi` accepts both.
- Pre-existing bad row: sms-only campaign whose mermaid has an email node →
  tick pauses the campaign once with the readable detail; no lead moves to
  `error`; no exception.
- `Send whatsapp: hi` → `parsePlaybook` invalid with the unknown-action error.

---

## Fix #5 — No silent forever-waits

Three shapes, three remedies. This fix carries the design's only migration.

### Migration: `campaign_leads.waiting_since`

`campaign_leads` has **no enrolment or node-entry timestamp** (only
`updated_at`, which moves on every write). Timeout anchoring pre-outbound
needs a stable instant, so add (parity/schema.js ALTER list, same pattern as
`retry_count`):

```sql
ALTER TABLE campaign_leads ADD COLUMN waiting_since TEXT DEFAULT ''
```

Written by `enterNode` whenever it parks a lead to wait — the `wait` case, the
`decision` case, and the post-send `state: 'waiting'` sets — as
`new Date().toISOString()`. One writer (a small `parkWaiting(cl, fields)`
wrapper around `setLead`), read only by `processWaiting`.

### 5a. Parser rejects dead-edge shapes (playbook.js)

New **errors** in the semantic-validation pass:

1. *Wait/start node with labeled edges.* Extend the existing send/decision
   mix-check: for `n.type === 'wait' || n.type === 'start'`, any outgoing edge
   with `cond.kind !== 'always'` →
   `Node "X" is a Wait/Start step — its outgoing edge cannot carry a condition; move the condition to a Send or Decision step.`
2. *Reply expected before anything was sent.* BFS from Start along edges,
   stopping at send nodes; any node reached without passing a send that has a
   `reply` or `no_reply` edge →
   `Node "X" waits for a reply, but no message has been sent yet on this path — add a Send step before it.`
   (`after` edges pre-send stay legal — 5c makes them work.)

**Deploy consequence, accepted deliberately:** a *running* campaign whose
playbook has these shapes gets paused by the existing invalid-playbook path in
`processCampaign` with the new message as the reason. Those campaigns were
already broken — silently completing or freezing leads; a named pause is the
honest upgrade. Call it out in the release note. (Verify against real data at
deploy: `SELECT id, name FROM campaigns WHERE status='running'` + parse each —
a one-off script in `scripts/`.)

### 5b. Engine self-heal: waiting at a wait node with empty `wait_until`

In `processWaiting`'s wait branch (engine.js:1276): when `cl.wait_until` is
empty, **freeze one now** instead of returning —
`scheduleFrom(ctx, cl, cl.node_id, { delayMs: node.ms || 0, … , fromMs: nowMs() })`,
set `wait_until`, log a single `retimed` event
(`"this step changed under a waiting lead — timer restarted from now"`).
Reachable when an edit turns the node a lead waits at into a Wait node; the
lead now proceeds instead of hanging forever.

### 5c. Timeout anchor fallback (engine.js)

In `processWaiting`, replace the hard bail:

```js
const outbound = lastOutbound(cl)
let since = parseDbTime(outbound?.created_at)
if (!since) {
  since = parseDbTime(cl.waiting_since)
  if (!since) {                       // legacy row from before the migration
    since = nowMs()
    setLead(cl, { waiting_since: new Date(since).toISOString() })
  }
}
```

`after` timers before any outbound now anchor to when the lead started
waiting there (persisted — so the anchor survives restarts and is stable
under fix #1's re-freeze). `no_reply` pre-send cannot occur in new saves (5a)
but legacy rows get the same anchor rather than a hang.

**Tests** (`tests/playbook.test.js`, `tests/engine.test.js`):
- Parser: each rejected shape → named error; the same graphs with the edge
  moved/labeled correctly → valid. `S --> D{Pick}` with only `after` edges →
  valid.
- Self-heal: waiting lead, wait node, `wait_until=''` → tick freezes a future
  `wait_until` and logs `retimed`; later tick advances the lead.
- Anchor: `S([Start]) --> D{…}` with `after 30s --> A[Send: …]` — lead reaches
  D, `waiting_since` written; advance 30s; tick → A sends. Restart-safety:
  clear in-memory state between ticks, anchor holds.
- Migration: row with `waiting_since` absent behaves (back-fills on first tick).

---

## Cross-cutting

### Files touched (complete list)

| File | Fixes |
|------|-------|
| `server/engine.js` | 1, 2, 3 (call sites), 4b, 5b, 5c |
| `server/step-timing.js` | 3 |
| `server/playbook.js` | 4c, 5a |
| `server/parity/campaigns.js` | 4a, 3 (lead-removal call sites) |
| `server/routes.js` | 3 (lead-removal call site) |
| `server/parity/schema.js` | 5 (migration) |
| `tests/*` | all |
| `scripts/` | one-off pre-deploy playbook scan (5a) |

### Verification gate (per fix and at the end)

1. `node --test tests/*.test.js` — full server suite green (baseline: 1 known
   pre-existing time-of-day flake in `agent-followup.test.js`).
2. The new tests listed under each fix.
3. Sandbox rehearsal: cases 16 (fix 6), 17 (fix 2), 18 (fix 1), 19 (fix 5b)
   from the test plan, and their ⚠ known-bug notes removed as each passes.
4. Update the current-vs-future map: green boxes become the current state; the
   audit's findings marked fixed.

### Explicitly out of scope

Reply-delay before answering a reply, DSL grammar-as-data refactor,
per-lead tick/route locking, the Behaviour-timeout ladder flattening
(documented design hazard, not changed here), and everything under "what does
not change" in the flow map.
