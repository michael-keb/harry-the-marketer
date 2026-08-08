# Get Campaign Statistics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/statistics` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/statistics |
| **Auth** | API key (query param `api_key`) |

Gives you the per-email record for a campaign — who was sent what, when, and whether they opened, clicked, replied or bounced — with filters and paging so you can pull just the slice you care about.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner reviewing performance, **I want** the email-by-email record behind a campaign's rates, **so that** I can see which step earned the replies and which one is quietly bouncing instead of guessing from a percentage.

**Acceptance criteria**
- [ ] Given a campaign with history, when I request statistics, then I get the rollup (`total_leads`, `contacted`, `opened`, `clicked`, `replied`, `bounced`, `unsubscribed`, `open_rate`, `click_rate`, `reply_rate`) plus a paged `data` array of per-email rows.
- [ ] Given each row, when I read it, then it carries `lead_name`, `lead_email`, `sequence_number`, `sent_time`, `is_opened`, `is_clicked`, `is_replied` and `is_bounced`.
- [ ] Given `limit` defaults to 100 and is capped at 1000, when I request more than the cap, then the request is rejected or clamped with the applied value stated in the response.
- [ ] Given I filter by `email_sequence_number` (1-20), when I request, then only rows for that step are returned and the rollup reflects the filter, or the rollup is clearly labelled as unfiltered.
- [ ] Given I filter by `email_status` with one of opened, clicked, replied, unsubscribed, bounced, when I request, then only matching rows return.
- [ ] Given I filter by `sent_time_start_date` and `sent_time_end_date`, when I request, then only emails sent in that window return.
- [ ] Given a campaign with no sends, when I request statistics, then I get a 200 with zeroed counters and an empty `data` array.
- [ ] Given open tracking has not demonstrably worked on the campaign, when `open_rate` is zero, then the UI says tracking may be blocked rather than implying nobody read the email.
- [ ] Given the campaign belongs to another workspace, when I request statistics, then I get a 404 with `{ "error": "Resource not found" }`.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with 4128 contacted, 1236 opened, 312 replied. GET statistics | 200 with the rollup matching and the first 100 rows in `data` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }` |
| TC-3 | Not found / wrong workspace | Request another workspace's campaign | 404 `{ "error": "Resource not found" }` |
| TC-4 | Validation failure | Request with `email_sequence_number=25` | 422 `{ "error": "Invalid parameters provided" }` stating the 1-20 range |
| TC-5 | Rate limited | Page through with no delay | 429; the client backs off and resumes from the last successful offset without skipping rows |
| TC-6 | Empty result set | Request statistics for a campaign that has never sent | 200 with all counters zero and `data: []`; the table shows "No emails sent yet" |
| TC-7 | Paging | Request `limit=100&offset=0`, then `offset=100` | No row appears in both pages and none is skipped, with a stable sort by `sent_time` |
| TC-8 | Limit cap | Request `limit=5000` | Clamped to 1000 with the applied limit stated, or 422 — never a silent full dump |
| TC-9 | Status filter | Request `email_status=bounced` | Every returned row has `is_bounced: true` |
| TC-10 | Date filter boundary | Seed one email at exactly `sent_time_start_date` | The row is included and the boundary rule is documented |
| TC-11 | Combined filters | Request step 2, replied, last 7 days | Rows satisfy all three conditions simultaneously |
| TC-12 | Real-time freshness | Simulate a reply, immediately re-request | The row flips to `is_replied: true` without waiting for a batch job |

## 4. Frontend user story

**As a** campaign owner, **I want** a filterable email log inside a campaign, **so that** I can go from "reply rate is 7.6%" to "these are the twelve people who replied" in one click.

**Scope**
- Campaign detail: below the existing node performance view, an "Emails" table with columns for lead, step, sent time, and open/click/reply/bounce state; filters for step, status and date range across the top.
- Reports: the rate figures in the per-campaign table become links that open this table pre-filtered to that rate, so a number always leads to the people behind it.
- Loading uses skeleton rows and keeps the header stable. Empty shows "No emails sent yet" or "No emails match these filters" with a clear-filters action. Errors keep filters intact.
- Paging is a "Load more" button rather than numbered pages, sorted newest first, with the total count shown.
- Accessibility: a real table with column headers and sort announcements; the boolean states are text plus icon, never icon alone; filters are labelled controls. On mobile the table becomes a stacked card list showing lead, step and outcome.

**Definition of done**
- [ ] Every rate in Reports links to the rows behind it.
- [ ] Filters are reflected in the URL and survive a reload.
- [ ] The zero-opens case explains tracking rather than implying failure.
- [ ] Loading more never duplicates or skips a row.

## 5. Backend user story

**As a** Harry server, **I want** a filtered, paged email-level statistics route per campaign, **so that** the UI can drill from a rate to the underlying messages without pulling everything.

**Scope**
- Add `GET /api/campaigns/:id/statistics` to `server/routes.js` with `offset`, `limit`, `step`, `status`, `from` and `to`, workspace-scoped.
- Data model: none new — read from `messages` plus the tracking events the mailer already records; derive rates rather than storing them.
- Enforce `limit` default 100 and maximum 1000, validate `step` within the playbook's node count, and validate `status` against the allow-list.
- Return both the rollup and the page, with a total count so the UI can show progress; use a deterministic sort so paging is stable under concurrent writes.
- Log a `telemetry` row with the filter shape and query duration so slow filters show up on Monitoring.

**Definition of done**
- [ ] Rollup and rows are consistent with each other for the same filters.
- [ ] Paging is stable, proven by a test that writes during paging.
- [ ] Filters compose correctly, proven by a combined-filter test.
- [ ] Cross-workspace access returns 404.

## 6. End-to-end test ticket

**Title:** E2E — drill from a campaign rate to the emails behind it

**Preconditions:** A workspace with a sandbox mailbox, one campaign with a three-step playbook, 30 leads, seeded history including opens, clicks, two replies and one bounce spread across two weeks.

**Flow**
1. Sign in and open Reports.
2. Click the campaign's reply rate.
3. Confirm the Emails table opens filtered to replied.
4. Change the step filter to step 2 and narrow the date range to the second week.
5. Clear the filters and load a second page.
6. Filter to bounced.

**Assertions**
- [ ] Step 3 shows exactly the two replying leads by name and email.
- [ ] Step 4's rows all have step 2 and a send time inside the window.
- [ ] Loading more shows new rows with no duplicates and the total count stays correct.
- [ ] The bounced filter shows exactly one row.
- [ ] Filters are in the URL and survive a reload.

**Teardown:** Delete the campaign, leads and messages; clear the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | New Emails table with three filters | High | Collapsed below node performance, filters default to none, "Load more" instead of pagination controls |
| Reports | Rates become links into the table | Low | No new visual weight; existing numbers gain an affordance |
| Monitoring | Query timing telemetry only | Low | Folds into the existing durations list |

**Verdict:** Fits an existing surface

Reports already tells the user the rates and the Learning section already attributes replies to steps, so the missing piece is the list of actual emails behind those claims. Putting it on the campaign detail page under the node view, reached by clicking a number, means the table only appears for someone who asked a specific question.
