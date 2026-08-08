# Create Manual Placement Test

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/manual` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/create-manual-test |
| **Auth** | API key (query param `api_key`) |

Starts a one-off deliverability test: you send your email to a set of test inboxes and the service reports where each copy landed.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The published page shows the request body as an empty object (`{}`) and documents only `api_key`; this endpoint is behind SmartLead support access. The story below is grounded in the documented **200 response**, which lists the fields a created test actually carries. Request fields are inferred from those names and must be confirmed with the provider before implementation.

## 2. User story

**As a** mailbox owner about to launch a campaign, **I want** to run a one-off placement test from a chosen mailbox, **so that** I learn whether my first email lands in the inbox before a hundred prospects receive it.

**Acceptance criteria**
- [ ] Given a campaign and one of its sequence steps, when I start a manual test, then the response returns an `id`, `test_type: "manual"` and `status: "active"`, and the test appears in the Deliverability list as running.
- [ ] Given I chose the checks, when the test is created, then `spam_filters` and `link_checker` are echoed back and the test detail states in words which checks are running.
- [ ] Given I set the pacing, when the test is created, then `all_email_sent_without_time_gap`, `min_time_btwn_emails` and `min_time_unit` are echoed and the seed sends honour Harry's own sending rhythm rather than bypassing it.
- [ ] Given `test_with_sl_account: false`, when the test runs, then seeds are sent from my own connected mailbox, and the test detail says which mailbox they came from.
- [ ] Given the campaign or `sequence_mapping_id` is not mine, when I submit, then the API returns 404 `{"error": "Resource not found"}` and no test is created.
- [ ] Given required fields are missing, when I submit, then the API returns 422 `{"error": "Invalid parameters provided"}` and the form shows a field-level message with my input preserved.
- [ ] Given no mailbox is connected, when I open the form, then it explains that a mailbox is needed and links to Mailboxes rather than failing at submit.
- [ ] Given the test is created, when it is saved, then an activity-trail entry records who ran it, from which mailbox, against which campaign.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST the manual test route for a valid campaign and sequence step | 200; body has `id`, `test_type: "manual"`, `status: "active"`, `campaign_id`, `sequence_mapping_id`, `email_track_id`, `provider_id` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; no test created |
| TC-3 | Campaign not found / wrong workspace | POST with another workspace's `campaign_id` | 404 `{"error": "Resource not found"}`; UI shows "That campaign is not available"; nothing created |
| TC-4 | Validation failure | POST with `min_time_btwn_emails: -5` | 422 `{"error": "Invalid parameters provided"}`; field-level message under the gap field |
| TC-5 | Rate limited | Start ten manual tests in a burst | 429 on the excess; client backs off with jitter; one "Retrying…" state, not ten errors |
| TC-6 | Empty result set | Open the Deliverability list before any test exists | 200 with an empty list; "No placement tests yet" plus a "Run a test" action |
| TC-7 | No mailbox connected | Open the form in a workspace with zero mailboxes | Form is disabled with "Connect a mailbox first" linking to Mailboxes; the request is never sent |
| TC-8 | Pacing echoed | Create with `all_email_sent_without_time_gap: false`, `min_time_btwn_emails: 30`, `min_time_unit: "minutes"` | Response echoes all three; detail reads "one seed email every 30 minutes" |
| TC-9 | Seeds count against the daily limit | Run a test from a mailbox with 3 sends left today | Seeds consume the allowance; if the mailbox runs out, the test holds and states the reason rather than exceeding the limit |
| TC-10 | Checks disabled | Create with `spam_filters: false`, `link_checker: false` | Response echoes both as false; the report omits the spam-filter and link sections instead of showing empty ones |

## 4. Frontend user story

**As a** mailbox owner, **I want** a "Run a placement test" action on the Mailboxes and Monitoring pages, **so that** checking a mailbox before a launch is one obvious click.

**Scope**
- Monitoring → Deliverability: a "Run a test" action opening a form with mailbox, campaign, sequence step, the two check toggles (spam filters, link checker), and pacing.
- Mailboxes: each mailbox row gains a "Test placement" action that opens the same form with that mailbox pre-selected.
- Campaigns → campaign detail: a "Test this step" action on a `Send:` node in the node-performance panel, pre-filling the sequence step.
- Loading: the submit button shows a pending state and the created test appears at the top of the list with a "running" label. Empty: "No placement tests yet". Error: banner in the form with values preserved.
- Accessibility: the form is a labelled dialog with focus trap and Escape to close; toggles are real checkboxes with visible labels; running/complete is stated in text. Responsive: the form is full-screen under 640px.

**Definition of done**
- [ ] The same form is reachable from Monitoring, Mailboxes and campaign detail with the right field pre-filled in each case.
- [ ] A running test is visibly distinct from a finished one and updates without a manual refresh.
- [ ] The form refuses to submit when no mailbox is connected and says why.
- [ ] Loading, empty, validation-error and upstream-unavailable states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that starts a one-off placement test and records it, **so that** the seed sends run through the normal mailer and the report can be fetched later.

**Scope**
- Route in `server/routes.js`: `POST /api/deliverability/tests/manual` taking `{ mailboxId, campaignId, sequenceStepId, spamFilters, linkChecker, pacing }`, workspace-scoped like the campaign routes.
- Data model: reuses the `deliverability_tests` table (see the automated-test ticket) with `test_type: "manual"`; the documented response fields — `test_name`, `description`, `spam_filters`, `link_checker`, `campaign_id`, `sequence_mapping_id`, `all_email_sent_without_time_gap`, `min_time_btwn_emails`, `min_time_unit`, `is_warmup`, `test_with_sl_account`, `has_seed_mapping`, `status`, `email_track_id`, `provider_id` — are stored verbatim.
- Because the request contract is undocumented, one adapter function maps Harry's validated input to the provider call, so a corrected contract is a single-file change.
- Seed sends go through `server/mailer.js` and `server/pacing.js`: they count against the mailbox's daily limit and warmup ramp, and never bypass working hours except for sandbox mailboxes. Upstream 429 and 503 back off with jitter.
- Logged: an `events` row on start and completion; `telemetry` records upstream latency and failures, and how many seeds were sent, so Monitoring can grade the deliverability checker.

**Definition of done**
- [ ] Route is workspace-scoped and returns 404 for another workspace's campaign or mailbox, covered by tests.
- [ ] Seeds are counted in the mailbox's daily allowance and visible in Reports mailbox load.
- [ ] Every documented response field round-trips into storage.
- [ ] Start and completion both appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Run a one-off placement test before launching a campaign

**Preconditions:** A workspace with one sandbox mailbox, one campaign with a valid playbook and at least one `Send:` node, and a stubbed provider returning the documented 200 body.

**Flow**
1. Open Mailboxes and choose "Test placement" on the sandbox mailbox.
2. In the form, pick the campaign and its first `Send:` step, leave both checks on, and start the test.
3. Watch the Deliverability list.
4. Let the engine tick until the seeds have been sent.
5. Open the finished test.

**Assertions**
- [ ] The form opens with the sandbox mailbox already selected.
- [ ] The new test appears at the top of the Deliverability list labelled running, with `test_type` manual.
- [ ] Seed sends appear against the sandbox mailbox and count towards its daily allowance.
- [ ] The finished test detail states which checks ran and which mailbox the seeds came from.
- [ ] The activity trail records who ran the test and against which campaign.

**Teardown:** Delete the test and its seed messages; reset the sandbox mailbox counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | "Run a test" action and a form | Medium | One action on a section the user already opened; the form defaults everything except mailbox and campaign |
| Mailboxes | "Test placement" action per mailbox | Low | Joins the existing per-mailbox actions rather than adding a column |
| Campaigns → campaign detail | "Test this step" on a `Send:` node | Low | Sits in the existing node-performance panel; opens the same form |

**Verdict:** Fits an existing surface

Running a placement test is something a user wants at the moment they are worrying about a mailbox or a campaign step, so the action belongs on those pages rather than on one of its own. All three entry points open the same form with different fields pre-filled, which keeps one thing to learn. No new navigation item.
