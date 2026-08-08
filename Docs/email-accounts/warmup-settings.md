# Update Warmup Settings

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/{id}/warmup` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/warmup-settings |
| **Auth** | API key (query param `api_key`) |

Turns a mailbox's warm-up on or off and sets how fast it climbs: how many warm-up emails a day, how much that grows daily, and the reply rate to aim for.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner connecting a brand-new sending address, **I want** control over how quickly it ramps up, **so that** I can go slower than the default on a fragile domain and faster on an established one.

**Acceptance criteria**
- [ ] Given a mailbox I own, when I post the equivalent of `warmup_enabled: true` with `total_warmup_per_day`, `daily_rampup` and `reply_rate_percentage`, then the settings save and the response is `{"ok": true, "message": "Warmup settings updated successfully"}`.
- [ ] Given values outside the documented ranges, when I save, then the request is rejected with a field-level message — `total_warmup_per_day` must be 1–50 (`{"error": "total_warmup_per_day must be less than or equal to 50"}`), `daily_rampup` 5–20, `reply_rate_percentage` 20–100.
- [ ] Given `is_rampup_enabled` is false, when warm-up runs, then the daily figure stays flat at `total_warmup_per_day` instead of climbing — a user who wants a fixed low volume must be able to have it.
- [ ] Given `warmup_enabled: false`, when I save, then warm-up stops and the mailbox's campaign sending is governed only by its daily limit; the mailbox is not suspended and nothing else changes.
- [ ] Given Harry's existing default — a new Gmail mailbox starts at 10 a day and works up to its limit over a fortnight — when a user does nothing, then that default remains, and this endpoint only exists to override it.
- [ ] Given `auto_adjust_warmup` is on, when bounce or complaint telemetry deteriorates, then the daily figure is reduced automatically and the reason is written to the activity trail, in the same spirit as Harry's smart follow-up timing which explains every adjustment it makes.
- [ ] Given warm-up settings change, when the sending rhythm next runs, then the change takes effect at the next tick without a restart, and today's already-sent count is respected rather than reset.
- [ ] Given an id from another workspace, when I save, then the response is 404 and nothing changes.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"warmup_enabled": true, "total_warmup_per_day": 20, "daily_rampup": 5, "reply_rate_percentage": 30, "is_rampup_enabled": true}` | 200, `{"ok": true}`; the mailbox detail sheet shows the new ramp and the date it reaches full volume |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; settings unchanged |
| TC-3 | Not found / wrong workspace | POST to an id owned by another workspace | 404; nothing changes; UI shows "That mailbox is not available" |
| TC-4 | Validation failure — above the ceiling | POST `{"total_warmup_per_day": 80}` | 422, `{"error": "total_warmup_per_day must be less than or equal to 50"}` shown under the field |
| TC-5 | Rate limited | Save on every drag of a slider | 429 on the excess; the client debounces to one save per settle and shows one "Saving…" state |
| TC-6 | Empty result set | POST `{"warmup_enabled": false}` alone, then read the mailbox | 200; warm-up reports off with no ramp figures rather than zeros pretending to be data |
| TC-7 | Ramp-up disabled | POST `{"is_rampup_enabled": false, "total_warmup_per_day": 15}` | Daily figure stays at 15 every day, verified across three simulated days |
| TC-8 | Below the ramp floor | POST `{"daily_rampup": 2}` | 422 with a field-level message stating the 5–20 range |
| TC-9 | Sandbox mailbox | POST warm-up settings to a sandbox mailbox | Rejected or ignored with a clear message that warm-up does not apply to sandbox mailboxes; the daily limit still applies as it does today |
| TC-10 | Change mid-day | Raise `total_warmup_per_day` after some emails have already gone | 200; today's remaining allowance grows by the difference, and nothing already sent is recounted |
| TC-11 | Auto-adjust reduces volume | With `auto_adjust_warmup: true`, feed in a spike of bounces | Daily figure drops on the next tick and the activity trail states the reason |
| TC-12 | Warm-up above the mailbox limit | Set `total_warmup_per_day: 50` on a mailbox with a 30/day limit | Rejected with a field-level message — warm-up volume can never exceed the mailbox's own daily limit |

## 4. Frontend user story

**As a** workspace owner, **I want** warm-up presented as a plan I can read rather than four numbers, **so that** I can tell what will actually happen before I change anything.

**Scope**
- Mailbox detail sheet: a Warm-up section with a single toggle plus a "Pace" choice — Careful, Standard (the current default), Fast — and an "Advanced" disclosure exposing the raw figures for daily count, ramp step, target reply rate, ramp on/off and auto-adjust.
- Above the controls, one sentence of plan: "Sending 12 a day, rising by 5 each day to 50 by 21 March."
- States: saving per field, saved, field-level error with the allowed range in words, and a disabled state on sandbox mailboxes with the reason.
- Auto-adjust changes appear in the mailbox's own history line so a user who finds a lower number than they set can see why.
- Accessibility: sliders are also number inputs; ranges are stated in text not just enforced; the plan sentence updates in an aria-live region. Responsive: the section is a single column under 768px.

**Definition of done**
- [ ] Most users never open Advanced — the three-choice pace covers the common cases.
- [ ] The plan sentence recomputes live and matches what the server will actually do.
- [ ] Out-of-range values are prevented in the control and explained if they still reach the server.
- [ ] Saving, saved, error and sandbox-disabled states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** per-mailbox warm-up settings that `server/pacing.js` reads, **so that** the existing ramp becomes configurable without a second ramp implementation.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `PUT /api/mailboxes/:id/warmup` taking `enabled`, `dailyCount`, `rampStep`, `rampEnabled`, `targetReplyRate`, `autoAdjust`.
- Data model: `mailboxes` gains `warmup_enabled`, `warmup_daily_count`, `warmup_ramp_step`, `warmup_ramp_enabled`, `warmup_target_reply_rate`, `warmup_auto_adjust`. Existing mailboxes migrate to today's hardcoded behaviour — start at 10, climb to the limit over a fortnight — so nothing changes for anyone who never touches this.
- `server/pacing.js` replaces its constants with these columns and keeps its deterministic randomisation (a hash of mailbox, day and count, never `Math.random`) so the pace stays reproducible in tests.
- Validation mirrors the documented ranges: daily count 1–50 and never above the mailbox's own daily limit, ramp step 5–20, reply rate 20–100.
- Auto-adjust runs on the engine tick from bounce and complaint telemetry, bounded like the smart follow-up timing is — halve to double, never unbounded — and writes its reason.
- Logged: an `events` row per manual change with old and new values, and per auto-adjust with the reason; `telemetry` records the daily figure so Monitoring can chart ramp against bounce rate.

**Definition of done**
- [ ] Existing mailboxes behave identically after the migration, covered by a pacing test.
- [ ] Every documented range is enforced server-side and covered by a test.
- [ ] Warm-up volume can never exceed the mailbox's daily limit, covered by a test.
- [ ] Auto-adjust is bounded, explained in the trail, and covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Slow down a fragile mailbox's warm-up

**Preconditions:** A workspace with a sandbox mailbox and a Gmail-style mailbox connected today, a campaign with forty leads, approvals on, a clock the test can advance by days.

**Flow**
1. Open the mailbox detail sheet for the new mailbox and read the default warm-up plan.
2. Switch the pace to Careful and open Advanced to confirm the resulting figures.
3. Launch the campaign and approve drafts across three simulated days.
4. Advance the clock and check the daily figure each day.
5. Turn ramp-up off and advance another two days.
6. Attempt to set a warm-up count above the mailbox's daily limit.

**Assertions**
- [ ] The default plan matches Harry's current behaviour — 10 a day rising to the limit over a fortnight.
- [ ] On Careful, fewer emails go out per day than the default, and the plan sentence matches the observed sends exactly.
- [ ] With ramp-up off, the daily figure stops climbing.
- [ ] The over-limit attempt is refused with a message naming the mailbox's daily limit.
- [ ] The sandbox mailbox's warm-up section is disabled with a stated reason and its daily limit still applies.

**Teardown:** Reset the mailbox's warm-up settings to the default, delete the campaign, reset send counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailbox detail sheet | Warm-up section with a toggle, three-choice pace and an Advanced disclosure | Medium | Six raw settings collapse to one choice for most users; Advanced is closed by default and the plan sentence does the explaining |
| Mailboxes | Row shows the warm-up stage | Low | One phrase on a row the list work already added |
| Monitoring | Ramp charted against bounce rate | Low | Existing delivery telemetry section, one more series |
| Dashboard | None | — | Warm-up is a mailbox concern and should not compete with campaign KPIs |

**Verdict:** Fits an existing surface

Harry already ramps new mailboxes; what is new is letting a user change the ramp, which belongs in the mailbox detail sheet next to the daily limit it interacts with. The bloat risk is real — six numbers is more than "don't make me think" allows — so the mitigation is a three-choice pace with the raw figures hidden behind Advanced. No navigation item is added.
