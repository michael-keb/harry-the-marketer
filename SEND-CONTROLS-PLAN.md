# Send controls — requirements

Levers over *when a message may leave*, and the machinery that resolves them
into one answer.

> **Status: built.** Phases 1–3 and most of phase 4 are implemented and tested
> (`tests/send-gates.test.js`, `tests/send-controls.test.js`). What is *not*
> built is listed at the bottom under "Still open". Section 1 below describes
> the state this work started from and is kept as the record of why the design
> is what it is — in particular, the campaign sending window really was stored,
> shown, and enforced by nothing until this shipped.

---

## 1. Where we are

Three levers exist today, all workspace-wide or mailbox-wide, and one is a
decoy.

| Lever | Scope | Where | Enforced? |
|---|---|---|---|
| Working hours + days + timezone, on/off | Workspace | `users.send_from/send_to/send_days/send_timezone/paced` (`server/db.js:304`) | Yes — `canSendNow` (`server/pacing.js:120`) |
| Daily ceiling + Gmail warm-up ramp | Mailbox | `mailboxes.daily_limit` | Yes |
| Randomised spacing between sends | Mailbox | `mailboxes.next_send_at` | Yes |
| Approval gate | Per draft | `server/drafts.js` | Yes |
| Suppression | Per address | `server/suppression.js` | Yes, unconditional |
| **Campaign sending window** — days[], start/end hour, timezone, min gap | Campaign | `campaigns.schedule`, `scheduleOf` (`server/parity/campaigns.js:167`) | **No.** Stored, returned by the API, editable in `SchedulePanel` — and the engine never reads it. `server/engine.js:185` asks only `canSendNow(user, mailbox)`. |

That last row is the first thing to fix: a user can set a campaign window, see
it saved, and watch email go out anyway.

Beyond that, the gaps that matter:

- **One window per workspace.** No split windows, no per-day hours, no blackout
  dates, no "I'm on leave next week".
- **Sender-local only.** A window of 08:30–17:30 Sydney lands at 22:30 in
  London. Nothing knows the recipient's clock.
- **No cross-campaign frequency cap.** The same person in two plans gets two
  emails the same morning. Directly contradicts "every touch stands alone".
- **No brakes.** Bounces climbing, SMTP failing, DKIM broken — sending
  continues. The only auto-pause is a missing mailbox or a broken playbook
  (`server/engine.js:350`).
- **No per-item control.** No "send this one now", no "not until Tuesday", no
  snooze, no workspace-wide hold.
- **No way to see the future.** The user cannot answer "when will these
  actually go out?" except by watching.
- **Email only.** The mixed queue puts `do` items (LinkedIn, comments) in front
  of the user at any hour; the rhythm governs only the email path.

---

## 2. The model

**One resolver, a stack of named gates, most-restrictive-wins, first blocker
reported.**

`canSendNow` becomes `resolveSend({ workspace, campaign, mailbox, lead, item, at })`
returning:

```js
{ ok: false,
  gate: 'campaign_window',      // stable id — logged, tested, never shown raw
  reason: 'outside this plan\'s sending hours',   // one human sentence
  until: 1725000000000,         // ms, or null if it needs a person
  needs: null }                 // 'approval' | 'reconnect' | 'human' | null
```

Rules of the model, all of which are requirements:

- **R1 — One answer.** Every caller (engine, queue UI, campaign page, parity
  API, preview) uses the same resolver. No second implementation of "can it
  send", ever.
- **R2 — Narrowing only.** A narrower scope may only *restrict* a wider one.
  Campaign hours intersect workspace hours; they never extend them. Mailbox caps
  cannot exceed workspace caps. This makes the whole stack safe to hand to a
  user: no lever anywhere can make sending more aggressive than the workspace
  allows.
- **R3 — Fixed precedence.** Gates evaluate in this order, and the first block
  is the one the user is told about:

  1. **Refusals** — suppression, workspace hold/kill switch, campaign not
     running, mailbox unhealthy or disconnected. *Never overridable.*
  2. **Consent** — approval missing, approval stale, lead replied since
     approval, thread taken over by a human.
  3. **Recipient protection** — recipient-local quiet hours, per-person
     frequency cap, per-company cap, cross-channel spacing.
  4. **Calendar** — workspace window ∩ campaign window ∩ mailbox window, minus
     blackout dates, plus not-before / not-after dates.
  5. **Volume** — workspace daily cap → mailbox daily/hourly cap → campaign
     daily cap → follow-up reserve.
  6. **Spacing** — the randomised gap.

- **R4 — Every block carries a sentence and a time.** `until` is mandatory
  wherever the answer is knowable; `needs` is set where it isn't. "Holding" with
  no explanation is a defect.
- **R5 — Deterministic.** No `Math.random`. Same inputs, same answer, in tests
  and in support.
- **R6 — Touches, not emails.** The resolver governs any outbound touch. A `do`
  item (LinkedIn message, comment) surfaces in the queue only when its own gates
  are open, so the user is not prompted to DM someone at 11pm.

---

## 3. Lever inventory

Defaults are chosen so a user who touches nothing gets today's behaviour or
safer. **G** = visible in graduate mode, **O** = operator tier only.

### 3.1 Time

| # | Lever | Scope | Default | Tier |
|---|---|---|---|---|
| T1 | Working hours + days (exists) | Workspace | 08:30–17:30, weekdays | G |
| T2 | **Campaign window actually enforced** | Campaign | inherits workspace | G |
| T3 | Split windows — up to 3 per day (e.g. 08:00–10:30, 14:00–16:00) | Workspace, campaign | one window | O |
| T4 | Per-day hours (Fri 09:00–12:00) | Workspace, campaign | same every day | O |
| T5 | **Blackout dates** — holidays, shutdown, "on leave 12–19 Sep" | Workspace | none | G (as "pause until") |
| T6 | **Recipient-local sending** — target 09:00–17:00 *their* time | Campaign | off; falls back to sender window when a lead's zone is unknown | O |
| T7 | **Hard quiet hours** — never before 07:00 / after 20:00 recipient-local, whatever else is set | Workspace, floor | on, not disableable below 06:00–21:00 | invariant |
| T8 | Not-before / not-after date on a campaign | Campaign | none | G |
| T9 | Mailbox window — a shared mailbox that only sends mornings | Mailbox | inherits | O |

T7 is the backstop that makes T1–T6 safe to expose. Any window a user draws is
intersected with it.

### 3.2 Volume

| # | Lever | Scope | Default | Tier |
|---|---|---|---|---|
| V1 | Daily cap (exists) | Mailbox | 50 | G |
| V2 | Warm-up ramp (exists: 10 + 5/day) | Mailbox | on for Gmail | G (shown, not tuned) |
| V3 | Configurable ramp — start, step, target, hold | Mailbox | current constants | O |
| V4 | **Hourly cap** | Mailbox | ceil(daily / hours in window) × 1.5 | O |
| V5 | **Workspace daily cap** across all mailboxes | Workspace | sum of mailbox caps | O |
| V6 | **Campaign daily cap** | Campaign | none | O |
| V7 | **Follow-up reserve** — % of the day's allowance held for follow-ups so first touches can't starve replies (`follow_up_percentage` exists in campaign settings JSON, unenforced) | Campaign | 30% | O |
| V8 | Min / max gap override | Workspace | 45s–45min, derived | O |

### 3.3 Conditions

The levers that stop sending because of *state*, not the clock.

| # | Lever | Trigger | Action | Tier |
|---|---|---|---|---|
| C1 | **Bounce brake** | hard bounces > 3% of last 50 sends on a mailbox | auto-hold mailbox, notify | G (worded as protection, never as a grade) |
| C2 | **Complaint brake** | any spam complaint | auto-hold mailbox, notify | G |
| C3 | **Mailbox health gate** | SMTP/OAuth failing, token expired, tracking domain broken | block, `needs: 'reconnect'` | G |
| C4 | **Auth gate** | SPF/DKIM/DMARC not passing | warn at first send from a new domain; block only if the user opted in | O |
| C5 | **Stale approval** | draft approved more than N days ago (default 7) | block, `needs: 'human'`, ask again | G |
| C6 | **Reply guard** | lead replied, or a human sent in the thread, since approval | block permanently, withdraw draft | G |
| C7 | **Person frequency cap** | already touched this person in the last N days across *all* plans and channels | defer to the day it clears | G, default 14 days |
| C8 | **Company cap** | more than N people at one company touched per rolling week | defer | O, default 3 |
| C9 | **Channel spacing** | an email and a LinkedIn touch to the same person on the same day | defer the second | G, default on |

C7 and C9 are the ones "every touch stands alone" implies but nothing enforces.

### 3.4 Manual

| # | Lever | Scope | Notes |
|---|---|---|---|
| M1 | **Hold everything** | Workspace | Big switch. Reason, who, when, optional auto-release time. Nothing leaves, drafts still compose. |
| M2 | Pause / resume | Campaign, mailbox, lead, company | Exists for campaign; extend to the others. |
| M3 | **Send now** | One queued item | Skips *spacing only*. Never suppression, quiet hours, daily cap, or health. The dialog says exactly what it is skipping. |
| M4 | **Send at** | One queued item | Pick a time; still intersected with the stack. |
| M5 | Snooze | One queued item | +1h, tomorrow morning, next week. |
| M6 | **Hold for 24h** | Workspace, one click | The "something's off, stop" button that doesn't require deciding what. |

### 3.5 Visibility

| # | Requirement |
|---|---|
| S1 | **Why nothing is sending** — one sentence naming the binding gate and when it clears, on the campaign page and Today. |
| S2 | **Schedule preview** — "the next 20 sends, and when each lands", computed by replaying the resolver forward. This is the trust lever; without it every other lever is guesswork. |
| S3 | **Gate events in the activity trail** — held/released, deduplicated so a 20s tick does not write 4,320 rows a day. Write on transition only. |
| S4 | **Change audit** — who changed which lever, when, from what to what. |
| S5 | Countdown on each queued item: "goes out ~10:40 tomorrow". |

---

## 4. Data model

- **`send_rules`** — `(scope, scope_id, rules_json, updated_at, updated_by)`,
  scope ∈ `workspace | campaign | mailbox`. One row per scope object, JSON
  document holding windows, caps and condition settings. Read-time merge with
  narrowing semantics (R2), same pattern `scheduleOf` already uses. Avoids
  another dozen columns on `users` and `campaigns`.
- **`send_holds`** — `(workspace_id, scope, scope_id, reason, source, created_by,
  created_at, release_at)`. Covers M1, M2, M6, C1, C2 and blackout dates. One
  table so "what is currently stopping this?" is one query.
- **`touches`** — `(workspace_id, person_id, company_domain, channel, sent_at,
  campaign_id)`, indexed on `(workspace_id, person_id, sent_at)` and
  `(workspace_id, company_domain, sent_at)`. Needed for C7–C9; `messages` cannot
  answer it cheaply and does not cover non-email channels.
- **`leads.timezone`** — inferred from country/company/domain, nullable. T6
  falls back to the sender window when null; it must never guess.
- Migration: every new field defaults to the current effective value. An
  existing workspace sees zero behaviour change on deploy, except T2 (campaign
  windows starting to work), which is a bug fix and should be announced.

---

## 5. Surfaces

**API**
- `GET /api/send-rules?scope=…&id=…` and `PUT` the same — one shape for all scopes.
- `GET /api/campaigns/:id/schedule-preview?limit=20` — S2.
- `POST /api/holds` / `DELETE /api/holds/:id` — M1, M2, M6.
- `POST /api/queue/:id/send-now | send-at | snooze` — M3–M5.
- Existing parity endpoints keep their shapes; `scheduleOf` becomes a projection
  over `send_rules` rather than a separate store.

**UI**
- Graduate mode: hours, days, timezone, pause, hold-24h, send-now, and the
  countdown. Six controls, no numbers that read as a score.
- Operator mode: the full stack, grouped Time / Volume / Conditions / Manual,
  each with the inherited value shown and an explicit "override" action.
- Every screen that can block sending shows the binding gate, not a spinner.

---

## 6. Invariants

These hold regardless of any lever, and no setting may be added that defeats
them:

1. Suppression is unconditional — no bypass parameter, at any scope.
2. Nothing sends without the user's OK. Levers move the minute, never the
   consent.
3. Hard quiet hours (T7) cannot be disabled, only narrowed.
4. Narrowing only (R2) — no scope can widen a wider scope's permission.
5. `Send now` skips spacing and nothing else.
6. A blocked send always produces a sentence and, where knowable, a time.
7. No grading, no benchmarks in graduate mode. C1/C2 are worded as protection
   ("we've paused this to protect your address"), never as a rate against a
   target.
8. Determinism — no `Math.random` anywhere in the resolver.

---

## 7. Non-functional

- **Cost.** The engine ticks every 20s over every running campaign and every
  in-flight lead. Frequency and volume gates must be answerable in aggregate
  queries per tick, cached per (workspace, tick) — not per lead.
- **Correctness.** DST, half-hour zones and windows crossing midnight. The
  existing stepped `nextOpen` handles these; keep the approach and extend the
  table-driven tests to every new gate.
- **Testing.** One case table per gate; one golden test that asserts the full
  resolved timeline for a fixed workspace over 7 days, so precedence changes
  cannot pass silently.

---

## 8. Phasing

1. **Fix and unify.** Enforce the campaign window (T2). Extract `resolveSend`
   with the gate stack, precedence and reasons; move every caller onto it. Ship
   S1 and S5.
2. **Protect.** T7 quiet hours, C3 health gate, C5 stale approval, C6 reply
   guard, C7 person frequency cap, M1/M6 holds.
3. **See.** S2 schedule preview, S3 gate events, S4 audit.
4. **Tune.** T3–T6, T8–T9, V3–V8, C1/C2/C4/C8/C9, M2–M5. Operator tier.
5. **Multi-channel.** R6 — `do` items governed by the same stack.

---

## 9. Still open

Everything else in this document is built. These are not:

- **V3 configurable warm-up ramp** — the ramp is still the fixed 10 + 5/day in
  `server/pacing.js`. Tunable per mailbox was phase 4 and is not done.
- **T9 per-mailbox windows** — the scope exists in `send_rules` and the resolver
  reads it, but nothing in the UI writes a mailbox-scoped rule yet.
- **C4 SPF/DKIM/DMARC gate** — the mailbox *health* gate (disconnected,
  suspended, failing auth) is in. Blocking on failing DNS records is not; the
  parity deliverability module has the data and nothing joins it up yet.
- **C2 complaint brake** — wired as a setting and honoured by the resolver, but
  no provider feeds a complaint signal in, so it never fires. Bounces do.
- **R6 multi-channel** — the resolver governs any touch and the ledger records a
  `channel`, so a LinkedIn `do` item is already counted by the frequency and
  channel-spacing gates. What is missing is the mixed queue itself, which is
  playbook work (PRODUCT.md item 5), not send-control work.
- **M2 pause at lead and company scope** — `send_holds` supports both and the
  resolver honours a lead hold; only workspace, plan and mailbox have UI.
- **S2 preview on the Today screen** — it is on Settings and on a plan's
  Sending window. It is not on Today.

## 10. Decisions taken

The five questions this document originally left open, and what was decided:

1. **Recipient-local sending is off by default.** Quiet hours in the
   recipient's timezone are on regardless — that is the protection — while
   *shifting the whole window* to their clock is opt-in. One consequence is
   worth knowing: a Sydney working day never overlaps London daytime, so a
   Sydney sender writing to London gets a hard "your hours never reach their
   daytime" rather than a wait. The message names recipient-local sending as
   the fix, because it is.
2. **The person cooling-off is 14 days**, counted across every plan and
   channel, and applies only to a *fresh approach* — never to a follow-up
   inside a conversation, or a three-step sequence would stall at step one.
3. **A hold stops sending, not composing.** Drafting continues, so the queue is
   ready when the hold lifts. The AI-spend concern in the original question is
   real but belongs with the spend cap (PRODUCT.md item 1), not here.
4. **The bounce brake fires on 2 hard bounces in a day**, with the rate
   threshold as a secondary trigger that needs a sample of at least 25 before
   it means anything. The absolute trigger is what protects a small sender; at
   twenty emails a day, 3% of the last fifty is a week behind the problem.
5. **The campaign window narrows, it does not replace.** A user whose workspace
   is weekdays cannot set a Saturday plan without changing the workspace first.
   This will be reported as a bug at least once; it is the price of the
   workspace settings being a real ceiling.

## 11. Original decisions needed

1. **Recipient-local (T6): default on or off?** On is kinder to recipients and
   worse for a user watching an empty queue at 9am because their leads are in
   another hemisphere. Recommend: off by default, offered once a campaign has
   leads in three or more zones.
2. **Person frequency cap window.** 14 days is a guess. It should probably be
   longer for a graduate's small warm graph, where a double-touch is more costly
   than a missed one.
3. **Does `hold everything` stop composing too, or only sending?** Composing
   costs AI spend against the monthly allowance, so a long hold that keeps
   drafting burns budget for email that may never go. Recommend: hold sending
   immediately, stop composing after 24h of hold.
4. **Bounce brake threshold.** 3% of the last 50 is a common industry figure but
   at a graduate's volume, 50 sends can be a fortnight — the sample is too small
   to be meaningful and too slow to protect. Might need an absolute trigger
   (2 hard bounces in a day) instead.
5. **Is the campaign window a narrowing or a replacement?** R2 says narrowing.
   That means a user whose workspace is weekdays cannot set a Saturday campaign
   without changing the workspace first. Predictable, but it will be reported as
   a bug at least once.
