# Campaign Email Graph — Audit (2026-09-04)

Scope: the campaign playbook graph end to end — the Mermaid parser/validator
(`server/playbook.js`), the engine that walks leads through the graph every tick
(`server/engine.js`), and the step scheduling it leans on (`server/step-timing.js`,
`server/pacing.js`), plus the graph-touching parts of the campaign routes
(`server/parity/campaigns.js`). Read in full; every finding below was verified by
tracing the actual code path (and by execution where noted). Report only — no
code was changed.

## Health snapshot

- Graph-related suites all pass on clean HEAD (Node 22): `playbook`, `engine`,
  `engine-pause`, `playbook-timing`, `step-timing`, `intents-engine` — 55/55.
- Several launch blockers from the 2026-08-12 audit are genuinely fixed and the
  fixes hold up under re-reading: `at HH:MM` in the past now rolls forward
  (step-timing.js:26-28, 222-224), transient send failures retry with backoff
  instead of stranding leads (engine.js:1510-1519), a lifetime send/day ceiling
  spans ticks (engine.js:321-344), compose now runs after the gate on the
  ungated path (engine.js:981-991), and SMS gates on its own quota
  (engine.js:731-744).
- But two of those fixes have live regressions/side doors — findings 1 and 2.

---

## FINDINGS (most severe first)

### 1. The no-reply channel-switch edge can still fire days early — the fixed bug is back through a fallback path

`pickNoReplyEdge` (engine.js:173-181) was fixed to only apply the channel-switch
preference among edges that are actually due. But when *no* edge is due it falls
back to the full set: `const pool = due.length ? due : scheduled`, and the
switch preference then picks the switch-channel edge out of that undue pool.

The undue-pool case is reachable because the due times are **recomputed at
elapse with the current adaptive factor**, not the factor used at freeze time
(engine.js:1361-1389). `followUpTiming` changes whenever the lead's intent
changes (`not now` → 1.5×, `out of office` → 2×) or when `openTrackingWorks`
flips campaign-wide (1 → 1.4× the moment *any* lead's open registers,
engine.js:257-261).

Failure scenario, concretely: node has `no reply 3d --> F[Send: email]` and
`no reply 7d --> X[Send sms: …]` (the productized email→SMS switch).
`wait_until` freezes at day 3 with factor 1. Before day 3, another lead's open
arrives, so `openTrackingWorks` becomes true and this lead never opened →
factor 1.4. At day 3 the frozen clock elapses; recomputed dues are 4.2d and
9.8d — both in the future — so `due` is empty, the pool is everything, and the
switch preference fires **the 7-day SMS edge at day 3**. The email follow-up
rung never runs.

Fix shape: when nothing is due at elapse, either re-freeze `wait_until` to the
new soonest instant, or fire `pool[0]` (soonest) without applying the switch
preference. The switch preference should never see an undue edge.

### 2. The human-intent-correction guard is dead code — `parseDbTime` returns NaN for every ISO timestamp

`parseDbTime` (engine.js:38) does `text.replace(' ', 'T') + 'Z'`. That is right
for SQLite `datetime('now')` strings, but `intent_set_at` is written as
`new Date().toISOString()` — engine.js:1233, `nowIso()` in
parity/http.js:209-211, parity/inbox.js:1579 — which already ends in `Z`.
Appending another `Z` yields `…000ZZ` → `Date.parse` → **NaN** (verified by
execution). So `humanSet` at engine.js:1314-1315 (`NaN >= x` → false) can never
be true, and the whole block the comment describes — "a person who corrected
the classifier outranks it" — never runs.

Failure scenario: two replies land close together; the triager corrects the
intent from the inbox, which stamps only the latest message
(parity/inbox.js:1579). The earlier reply is still unclassified; on the next
tick the guard should stamp the human's intent onto it and stop. Instead the
classifier reruns on the stale message and `routeReply` branches the lead on
it, overriding the human's routing — the exact regression this code claims to
prevent. (Note `setLead(cl, { intent })` on the classifier path also leaves the
old `intent_set_by` in place, so the row then claims a human chose the
classifier's value.)

Fix shape: make `parseDbTime` format-aware (`text.includes('Z') ? Date.parse(text) : …`),
or store `intent_set_at` in SQLite format. One-line fix; add a test with ISO input.

### 3. Sticky step slots are never invalidated — loops and re-enrollment reuse a past instant and blow through send windows

`getOrCreateStepSlot` (step-timing.js:101-110) returns the persisted
`chosen_at` unconditionally, and nothing anywhere deletes from
`step_send_slots` (only one SELECT and one INSERT exist in the codebase). The
slot is keyed (campaign, lead, node) with no generation or day component.

Two lawful ways a lead revisits a node: a `no reply` cycle in the playbook
(e.g. `F → G → F`, legal until the lifetime ceiling), and a subsequence handoff
that resets a finished child pairing back to `'queued'` (engine.js:470-474) for
a fresh run. On the second visit, every windowed step (`window HH:MM-HH:MM` on
a node or edge, or the campaign-level random window applied by
`effectiveRandomWindow`) reuses a `chosen_at` from the first visit — an
absolute ms already in the past — so the step fires immediately, ignoring both
the authored delay-to-window and the randomisation. `advanceToOpen` still
applies quiet hours, but the declared random window itself is skipped.

Fix shape: delete the slot when the step actually fires (or key it by a visit
counter / dayKey), so a revisit rolls a fresh slot.

### 4. A running SMS campaign can gain an email send node — and then leads die on a null-mailbox TypeError

Launch correctly blocks `mode === 'sms' && hasEmailSend`
(parity/campaigns.js:501-506), and the post-launch channel freeze blocks
changing an *existing* node's channel — but a **new** node id sails through:
`if (!prevChannels.has(nodeId)) continue` (parity/campaigns.js:1283). The
sequence PUT never re-checks mode-vs-nodes, so editing a running sms-mode
campaign to add `B[Send email: …]` saves fine.

When the engine reaches it: `smsOnly` campaigns have `ctx.mailbox = null`
(engine.js:1417-1420, deliberately allowed), `rotatedMailbox`'s pool query
matches nothing and returns `pool[0] || ctx.mailbox` → null (engine.js:644),
and enterNode's email branch does `mailbox.id` (engine.js:932) → TypeError.
The per-lead catch classifies "Cannot read properties of null" as permanent, so
the lead lands in terminal `'error'` with a raw JS message instead of "this
campaign has no mailbox". Every lead that reaches the node strands the same way.

Fix shape: re-run the mode-vs-channel check in the sequence PUT (it already has
the graph in hand), and/or null-guard `mailboxFor`'s result in the email branch
with a human-readable error.

### 5. Silent permanent hangs the graph walker never escapes

Three distinct ways a lead can wait forever with no event, no error, and no
`needs_attention`:

- **Wait node with empty `wait_until`.** `processWaiting`'s wait branch is
  `if (cl.wait_until && …)` (engine.js:1276) — if `wait_until` is `''` it just
  returns, every tick, forever. Reachable when a playbook edit changes a node
  the lead is waiting at (waiting at a decision/send leaves `wait_until = ''`)
  into a Wait node: same id, so the edit route's orphan handling doesn't park
  it. Fix shape: when a waiting lead sits at a wait node with no `wait_until`,
  freeze one from now instead of returning.
- **Decision (or any waiting node) reached before any outbound.** Timeout edges
  compute `since` from the last outbound and bail when there is none
  (engine.js:1341-1343) — so in `S([Start]) --> D{Segment?}` with
  `after`/`no reply` edges, nothing can ever fire (no thread exists, so no
  reply can arrive either). The parser accepts this shape. Fix shape: fall back
  to the lead's enrolment time when there is no outbound, or reject the shape
  at parse time.
- **Parser accepts edges the engine will never follow.** A wait node's
  outgoing labeled edges are ignored — the engine only follows an `always`
  edge from a wait and otherwise finishes the lead as `completed`
  (engine.js:1277-1278); same for a start node (engine.js:895-896). So
  `W[Wait: 30d] -- no reply 3d --> X` parses clean, then silently completes the
  lead at W and never visits X. The mixed-edge validation in playbook.js:309-313
  only covers send/decision. Fix shape: extend that check to wait/start nodes.

### 6. Multiple unclassified replies are processed newest-first, and the stale one branches the new node

`processWaiting` picks `ORDER BY id DESC LIMIT 1` (engine.js:1301-1303). With
two unclassified replies (mailbox was down, or they arrived inside one tick
gap), the newest is classified and routed first; the lead moves to a new node;
next tick the *older* reply is classified against the **new** node's intents
and routes the lead again. One human interaction, two branches, evaluated out
of order. Fix shape: process oldest-first (`ORDER BY id ASC`), or stamp all
unclassified messages when routing the latest.

---

## Lower-severity notes

- **Behaviour timeout flattens a no-reply ladder.** When
  `settings.reply_handling.<channel>.timeoutMs` is set, `waitFor` uses it for
  *every* `no_reply` edge on the node (engine.js:1370-1379), so `no reply 3d`
  and `no reply 7d` both become the same duration and the switch preference
  alone decides the winner. If that's intended, it deserves a doc line; if not,
  the override should scale rather than replace.
- **No per-lead mutual exclusion between the tick and manual routing.** The
  tick awaits model calls mid-lead; a manual intent route
  (parity/campaigns.js → `routeReply`) can process the same lead in that gap.
  Both paths can reach a send. Low likelihood (needs a human click in the same
  seconds), but nothing structural prevents a double send.
- **`gateState` (engine.js:271) grows per campaign and is never pruned** on
  campaign delete/archive. Cosmetic.

## What was checked and found sound

- Parser bracket/edge grammar, chained statements, quoted labels, comments,
  duplicate-node and duplicate-condition detection, reachability, and the
  start/terminal/decision semantic checks all behave as documented.
- Hop budget (same-tick cycles) + lifetime ceiling (cross-tick cycles) compose
  correctly; both fire before compose/send.
- Freeze-on-enter of `wait_until` correctly insulates waiting leads from
  playbook edits to durations; adaptive timing and jitter apply only at freeze
  (finding 1 is about the *recompute at elapse*, not the freeze).
- Suppression precedence (unsubscribe outranks handoff and routing), the
  classifier-may-not-act-on-unsubscribe rule, terminal `completed_at` guard in
  the tick's SELECT, mailbox rotation/pinning invariants, and the
  per-campaign/per-lead error isolation in `tick` are all correctly enforced.
- Roll-forward of past clocks (`at HH:MM` after the fact) is fixed and correct,
  including the DST-aware re-resolution.
