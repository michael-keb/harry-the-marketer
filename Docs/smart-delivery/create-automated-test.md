# Create Automated Placement Test

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/schedule` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/create-automated-test |
| **Auth** | API key (query param `api_key`) |

Sets up a deliverability test that repeats on a schedule, so inbox placement is checked regularly instead of once.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The published page shows the request body as an empty object (`{}`) and documents only `api_key` as a parameter — this endpoint sits behind SmartLead support access. Everything below is grounded in the documented **200 response**, which is the only reliable description of the shape. Request fields are inferred from the response's own field names and are flagged as such; confirm them with the provider before building.

## 2. User story

**As a** mailbox owner, **I want** to schedule a recurring placement test against a campaign, **so that** I find out my mail has started landing in spam within days rather than after a dead month.

**Acceptance criteria**
- [ ] Given a campaign and a sending mailbox, when I create an automated test, then the response returns an `id`, `test_type: "automated"` and `status: "active"`, and the schedule appears in Monitoring.
- [ ] Given I set a cadence, when the test is created, then the response echoes `every_days`, `scheduler_cron_value`, `schedule_start_time` and `test_end_date`, and the UI states the next run in the user's own timezone.
- [ ] Given I choose the pacing options, when the test is created, then `all_email_sent_without_time_gap`, `min_time_btwn_emails` and `min_time_unit` are echoed back and the seed sends respect Harry's own sending rhythm rather than bypassing it.
- [ ] Given the campaign or `sequence_mapping_id` does not belong to my workspace, when I create the test, then the request returns 404 `{"error": "Resource not found"}` and nothing is scheduled.
- [ ] Given required fields are missing or malformed, when I submit, then the request returns 422 `{"error": "Invalid parameters provided"}` and the form shows a field-level message with my input preserved.
- [ ] Given `test_end_date` is in the past or before `schedule_start_time`, when I submit, then the form blocks submission with a message rather than creating a schedule that never runs.
- [ ] Given a schedule already exists for the same campaign and cadence, when I create another, then the UI warns about the duplicate before it is created.
- [ ] Given the test is created, when it is saved, then an activity-trail entry records who scheduled it, against which campaign, at what cadence.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, weekly test | POST the schedule route for a valid campaign with a 7-day cadence | 200; body contains `id`, `test_type: "automated"`, `status: "active"`, `every_days: 7`, `scheduler_cron_value: "0 10 * * 0"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; no schedule created |
| TC-3 | Campaign not found / wrong workspace | POST with a `campaign_id` owned by another workspace | 404 `{"error": "Resource not found"}`; UI shows "That campaign is not available"; nothing scheduled |
| TC-4 | Validation failure | POST with `every_days: 0` | 422 `{"error": "Invalid parameters provided"}`; field-level message under the cadence field |
| TC-5 | Rate limited | Create twenty schedules in a burst | 429 on the excess; client backs off with jitter; user sees one "Retrying…" state |
| TC-6 | Empty result set | Open the schedules list before any automated test exists | 200 with an empty list; Monitoring shows "No recurring deliverability tests yet" with a create action |
| TC-7 | End date before start | Submit `test_end_date` earlier than `schedule_start_time` | Blocked client-side with a message; if forced, 422 from the server; no schedule created |
| TC-8 | Pacing echoed | Create with `all_email_sent_without_time_gap: false`, `min_time_btwn_emails: 60`, `min_time_unit: "minutes"` | Response echoes all three; the schedule detail states "one seed email an hour" |
| TC-9 | Provider selection | Create with a `provider_id` such as `outlook_eu` | Response echoes `provider_id`; the schedule detail names the provider group being tested |
| TC-10 | Undocumented field rejected | Submit a field name guessed rather than taken from the response shape | 422 with a field-level message; the client logs the rejected field to telemetry so the request contract can be corrected |

## 4. Frontend user story

**As a** mailbox owner, **I want** a "Schedule a placement test" form on Monitoring, **so that** setting up recurring deliverability checks takes one screen and no jargon.

**Scope**
- Monitoring → Deliverability: a "Recurring tests" section listing each schedule with campaign, cadence in plain words ("every 7 days, next run Sunday 10:00"), provider, and status; a create dialog with campaign picker, cadence, start date, end date, provider, and the two pacing controls.
- Campaign detail gains a read-only "Deliverability" line stating whether a recurring test covers this campaign.
- Loading: skeleton rows. Empty: "No recurring deliverability tests yet" with the create action inline. Error: banner inside the dialog with the form values preserved.
- Cron is never shown as cron. `scheduler_cron_value` is translated to a sentence; the raw value is available under a "details" disclosure for anyone who wants it.
- Accessibility: the dialog is a labelled modal with focus trap and Escape to close; dates use real date inputs with a stated timezone; status is text, not colour. Responsive: the list stacks to cards under 640px.

**Definition of done**
- [ ] A schedule can be created, viewed and stopped without leaving the Deliverability section.
- [ ] Cadence, next run and end date are all shown in the browser's timezone, consistent with how the sending rhythm already reports times.
- [ ] Every state — loading, empty, validation error, upstream unavailable — has a designed appearance in light and dark.
- [ ] The form refuses an end date before the start date before it ever reaches the server.

## 5. Backend user story

**As a** Harry API, **I want** a route that creates and stores a recurring placement test, **so that** the engine can run the seed sends and the UI can show the schedule.

**Scope**
- Route in `server/routes.js`: `POST /api/deliverability/tests/schedule` taking the campaign, cadence and pacing options, mirroring the workspace-scoped pattern used by campaign routes.
- Data model: a `deliverability_tests` table in `server/db.js` holding `id`, `test_name`, `description`, `test_type`, `status`, `campaign_id`, `sequence_mapping_id`, `provider_id`, `email_track_id`, `spam_filters`, `link_checker`, `is_warmup`, `test_with_sl_account`, `has_seed_mapping`, `all_email_sent_without_time_gap`, `min_time_btwn_emails`, `min_time_unit`, `schedule_start_time`, `test_end_date`, `every_days`, `scheduler_cron_value`, `created_at`, `updated_at` — the exact field set the documented response returns.
- Because the request contract is undocumented, the route defines Harry's own validated input schema and maps it onto the provider call in one adapter function, so a corrected contract is a one-file change.
- The engine's existing 20-second tick claims due schedules; seed sends go through `server/mailer.js` and obey the mailbox daily limit and warmup ramp exactly like campaign mail. Provider 429 and 503 back off with jitter; a missed run is caught up once, never replayed in a storm.
- Logged: an `events` row on create, stop and each run; `telemetry` records upstream latency, rejected fields and failure reasons so Monitoring can grade the deliverability checker as a component.

**Definition of done**
- [ ] Route is workspace-scoped, returns 404 for another workspace's campaign, and is covered by a test.
- [ ] Stored row round-trips every documented response field without loss.
- [ ] The tick runs a due schedule exactly once even if two ticks overlap.
- [ ] Seed sends never exceed a mailbox's daily limit.

## 6. End-to-end test ticket

**Title:** E2E — Schedule a recurring placement test and see its first run

**Preconditions:** A workspace with one sandbox mailbox, one launched campaign with a valid playbook, and a stubbed provider that returns the documented 200 body.

**Flow**
1. Open Monitoring → Deliverability.
2. Choose "Schedule a placement test", pick the campaign, set the cadence to every 7 days starting today, set an end date three months out, and save.
3. Read the schedule row.
4. Advance the engine clock past the start time and let a tick run.
5. Open the campaign detail page.

**Assertions**
- [ ] The schedule row shows the campaign, "every 7 days", the next run in local time, and status active.
- [ ] No cron string is visible until the details disclosure is opened.
- [ ] After the tick, a run appears with a report link and the seed sends are recorded against the sandbox mailbox.
- [ ] Campaign detail shows "Deliverability: checked weekly" linking to the schedule.
- [ ] The activity trail names who scheduled the test and when.

**Teardown:** Stop and delete the schedule, clear its runs and seed sends, reset the sandbox mailbox counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring | New "Recurring tests" section plus a create dialog | Medium | Sits inside the existing Deliverability area; collapses to one line ("Checked weekly, all clear") when nothing needs attention |
| Campaigns → campaign detail | One read-only line about deliverability coverage | Low | Plain text beside the existing status lines, no new control |
| Activity trail | Schedule created / stopped entries | Low | Reuses the existing trail |

**Verdict:** Fits an existing surface

Monitoring is already the page for pipeline health, and a recurring inbox-placement test is health monitoring by another name. The create dialog is the only new interactive surface and it is reached from a section the user has already opened. No new navigation item, and a workspace that never schedules a test sees one empty-state line.
