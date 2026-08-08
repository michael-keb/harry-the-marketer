# Update Campaign Schedule

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/schedule` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-schedule |
| **Auth** | API key (query param `api_key`) |

Sets the hours, days, timezone and minimum gap that govern when a campaign is allowed to send.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner selling into a different timezone, **I want** to set the sending window, days and minimum gap for a campaign, **so that** my emails land during my prospects' working hours rather than at 3 a.m. their time.

**Acceptance criteria**
- [ ] Given I submit a schedule with `timezone`, `days`, `start_hour`, `end_hour` and `min_time_btw_emails`, then it is saved and echoed back, and the campaign's pacing uses it on the next tick.
- [ ] Given `timezone` must be a valid IANA name (for example `Australia/Sydney`, `Europe/London`), when I submit an invalid one, then I get a 422 `{ "error": "Invalid parameters provided" }` naming the timezone.
- [ ] Given `days` uses 0 for Sunday through 6 for Saturday, when I submit `[1,2,3,4,5]`, then the campaign sends Monday to Friday only and the UI describes it in words.
- [ ] Given `days` is empty, when I save, then it is rejected, because a campaign that can never send is a configuration error not a state.
- [ ] Given `start_hour` and `end_hour` are 24-hour strings such as `"09:00"` and `"17:00"`, when `end_hour` is not after `start_hour`, then I get a field-level validation error.
- [ ] Given `min_time_btw_emails` is set in minutes, when the engine paces, then it is treated as a floor: Harry's own derived gap and its deterministic ±50% scatter may exceed it but never go below it.
- [ ] Given the campaign is running when I save, then the change takes effect on the next tick without a restart, and any email already approved and queued keeps its promise to go out inside the new window.
- [ ] Given the campaign is currently outside its window, when I open it, then it states plainly that it is holding and when the next email goes.
- [ ] Given the workspace's browser timezone differs from the campaign's, when the schedule is displayed, then both are shown so the user is never guessing whose 9 a.m. it is.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ schedule: { timezone: "America/New_York", days: [1,2,3,4,5], start_hour: "09:00", end_hour: "17:00", min_time_btw_emails: 120 } }` | 200 with `data.schedule` echoing `days_of_week`, `start_time`, `end_time`, `min_time_between_emails` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }`; the schedule is unchanged |
| TC-3 | Not found / wrong workspace | Save a schedule on another workspace's campaign | 404 `{ "error": "Resource not found" }` |
| TC-4 | Validation failure | POST `timezone: "EST5EDT-ish"` | 422 `{ "error": "Invalid parameters provided" }` naming the timezone |
| TC-5 | Rate limited | Save the schedule repeatedly | 429; the form retries once and the final saved schedule is the last one submitted |
| TC-6 | Empty result set | Open a campaign that has never had a schedule saved | 200 with the workspace default schedule shown and labelled as the default |
| TC-7 | Empty days | POST `days: []` | Rejected with a message explaining the campaign could never send |
| TC-8 | Inverted hours | POST `start_hour: "17:00"`, `end_hour: "09:00"` | 422 naming `end_hour`; overnight windows are either supported explicitly or rejected clearly |
| TC-9 | Gap as a floor | Set `min_time_btw_emails: 120`, run the engine with many leads queued | No two sends from one mailbox are closer than 120 minutes apart |
| TC-10 | DST boundary | Set a window spanning a daylight-saving change in the chosen timezone | Sends still land inside local 09:00-17:00 on both sides of the change |
| TC-11 | Live change | Change the window while the campaign is running | The next tick uses the new window; nothing is sent outside it |
| TC-12 | Holding message | Open a campaign outside its window | The page states it is holding and gives the next send time in both timezones |

## 4. Frontend user story

**As a** campaign owner, **I want** to see and change a campaign's sending window in plain language, **so that** I can tell at a glance when it will and will not send.

**Scope**
- Campaign detail: a "Sending window" panel showing a one-line summary ("Weekdays, 9:00am - 5:00pm, Sydney time, at least 2 hours apart") that expands into day toggles, two time fields, a timezone picker and a minimum-gap field.
- The timezone defaults to the browser's, as Harry already does elsewhere, and offers the common zones first with a full searchable list behind them.
- The existing "holding, next email around 2:40pm" message on the campaign page reads from this schedule and states both timezones when they differ.
- Loading disables save; validation errors sit against the field; nothing typed is lost on failure. Saving while running shows a note that it applies from the next tick.
- Accessibility: day toggles are checkboxes in a labelled fieldset with full day names for screen readers; time fields state their format; the summary line is the accessible name of the disclosure. On mobile the day toggles wrap to two rows.

**Definition of done**
- [ ] The collapsed state is a readable English sentence, not a set of codes.
- [ ] Timezone defaults to the browser and is never silently assumed.
- [ ] Invalid windows cannot be saved from the UI.
- [ ] The holding message and this panel never disagree.

## 5. Backend user story

**As a** Harry server, **I want** a per-campaign sending window that `server/pacing.js` reads, **so that** working hours are configuration rather than a constant.

**Scope**
- Add `PUT /api/campaigns/:id/schedule` to `server/routes.js` accepting `{ timezone, days, start_hour, end_hour, min_gap_minutes }`, workspace-scoped.
- Data model: a schedule column or small table keyed to `campaigns`; fall back to the workspace default when unset rather than storing a copy at creation.
- Validate the timezone against the platform's IANA database, days against 0-6 with at least one entry, hours as `HH:MM` with end after start, and the gap as a positive integer with a sane ceiling.
- `server/pacing.js` treats `min_gap_minutes` as a lower bound on its derived gap, keeping the existing deterministic hash-based scatter — never `Math.random` — so behaviour stays reproducible in tests.
- Sandbox mailboxes continue to skip the clock and the gap, while daily limits still apply, as they do today.
- Write an `events` row with the old and new schedule summary, and a `telemetry` row for the call.

**Definition of done**
- [ ] Pacing tests prove no send outside the window in the campaign's timezone, including across a DST change.
- [ ] The minimum gap is a floor, never a fixed interval.
- [ ] Schedule changes take effect on the next tick with no restart.
- [ ] Determinism of the scatter is preserved, proven by a repeat-run test.

## 6. End-to-end test ticket

**Title:** E2E — set a campaign's sending window

**Preconditions:** A workspace with a sandbox mailbox, one running campaign with ten leads queued, the browser timezone set to something other than the campaign's target timezone.

**Flow**
1. Sign in and open the campaign detail page.
2. Read the sending-window summary and expand the panel.
3. Set weekdays only, 09:00 to 17:00, a target timezone different from the browser's, and a two-hour minimum gap.
4. Save and read the summary again.
5. Set the clock to a Sunday and run the engine.
6. Set the clock to a Tuesday at 10:00 target time and run the engine repeatedly.

**Assertions**
- [ ] The summary reads as one English sentence naming the timezone.
- [ ] Both timezones are shown where they differ.
- [ ] No email is sent on the Sunday and the page says the campaign is holding with the next send time.
- [ ] On the Tuesday, sends occur and no two from one mailbox are closer than two hours apart.
- [ ] The activity trail records the schedule change with old and new values.

**Teardown:** Restore the clock, delete the campaign and leads, clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | New "Sending window" panel | Medium | Collapsed to a single English sentence; expands only when the user wants to change it |
| Campaign detail holding message | Reads the per-campaign schedule | Low | Existing message, new source of truth |
| Settings | Workspace default window | Low | One instance of the same panel, reused |

**Verdict:** Fits an existing surface

Harry already paces sends inside working hours and already explains when a campaign is holding, so the schedule exists — it is just not editable per campaign. Collapsing it to one sentence keeps the campaign page readable, and reusing the same panel in Settings for the workspace default means there is one control to learn.
