# Get Sent Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/sent` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-sent |
| **Auth** | API key (query param `api_key`) |

Lists every email that has already gone out across all campaigns, with what happened to it — opened, clicked, replied, bounced.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** campaign owner, **I want** one list of everything that has been sent and what came of it, **so that** I can find the people who opened but never answered and decide what to do about them.

**Acceptance criteria**
- [ ] Given sent emails exist, when I list them, then each row returns the `lead` (`email`, `first_name`, `last_name`, `company`), the `campaign`, the `email_account` that sent it, the `last_message` with `subject`, `sent_at`, `opened_at` and `replied_at`, the `email_status`, the `category`, the `assigned_to` member and `stats` with `opens`, `clicks` and `replies` — plus `total_count`, `offset` and `limit`.
- [ ] Given `filters.emailStatus` as a single value or array from `Opened`, `Clicked`, `Replied`, `Unsubscribed`, `Bounced`, `Accepted`, `Not Replied`, when I filter, then only matching rows return; `Not Replied` specifically means opened with no reply, so the UI must label it that way rather than "no reply".
- [ ] Given `filters.campaignId` with up to 15 campaigns (this endpoint's ceiling, wider than the replies endpoint's 5), when I filter, then all are honoured, and exceeding it returns 422 with `field` and `provided_value`.
- [ ] Given `filters.search` up to 30 characters, when I search, then lead email, lead name and email content are all matched.
- [ ] Given `sortBy` of `REPLY_TIME_DESC` (default, best for live conversations) or `SENT_TIME_DESC` (best for recent outreach), when I list, then the order matches.
- [ ] Given `limit` outside 1–20 or a malformed `replyTimeBetween`, when I list, then I get 422 naming the field and the value provided.
- [ ] Given nothing has been sent, when I open the view, then I get 200 with an empty list and an empty state that points at the drafts still waiting for an OK.
- [ ] Given open tracking has never fired on a campaign, when the view shows `opened_at`, then absence of an open is shown as "not known" rather than "not opened", matching how Harry already refuses to trust open data it cannot demonstrate.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"emailStatus": ["Replied", "Opened"], "campaignId": [12345, 12346], "replyTimeBetween": ["2025-01-01T00:00:00Z", "2025-01-31T23:59:59Z"]}, "sortBy": "REPLY_TIME_DESC"}` | 200 with `messages[]` carrying `last_message.sent_at`, `opened_at`, `replied_at` and `stats.opens/clicks/replies`; `total_count` present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401, `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows |
| TC-4 | Validation failure — limit | POST `limit: 50` | 422, `{"error": "limit must be between 1 and 20", "field": "limit", "provided_value": 50}`; the page size is fixed at 20 in the UI so this cannot happen from the app |
| TC-5 | Rate limited | Page rapidly through a large sent history | 429 on the excess; client backs off with jitter and keeps the current page visible |
| TC-6 | Empty result set | Open the view before anything has been approved | 200, empty list, `total_count: 0`; empty state reads "Nothing sent yet — six drafts are waiting for your OK" with a link to Needs your OK |
| TC-7 | Engaged-but-silent segment | POST `emailStatus: ["Opened", "Clicked"]` with `leadCategories.unassigned: true` and `sortBy: "SENT_TIME_DESC"` | Only opened or clicked, uncategorised leads return — the follow-up worklist |
| TC-8 | Invalid status | POST `emailStatus: "Delivered"` | 422 naming `emailStatus` and listing the valid values |
| TC-9 | Campaign ceiling | POST `campaignId` with 16 ids | 422 naming the 15-campaign maximum; the picker refuses a sixteenth |
| TC-10 | Bounced rows | Send to an address that hard-bounces on the sandbox mailbox | The row shows `email_status: "Bounced"`, the lead's stage reflects it, and the bounce is offered as a reason to block the domain |
| TC-11 | Untrustworthy open data | List sent emails on a campaign where no open has ever been recorded | `opened_at` is absent and the UI states "opens not tracked on this campaign" rather than implying nobody opened |
| TC-12 | Paging stability | Read page 1, send another email, read page 2 | No row duplicated or skipped, because paging is keyed on the sort key plus id |

## 4. Frontend user story

**As a** campaign owner, **I want** a Sent view in the Inbox with the same filters as Replies, **so that** finding "opened twice, never answered, from last week" takes a few clicks instead of a report request.

**Scope**
- Inbox → Replies: "Sent" joins the same filter group as scheduled, reminders and archived, using the shared filter bar (campaign, mailbox, category, engagement status, assignee, date range, search) with the campaign ceiling raised to 15 for this view and stated in the picker.
- Rows show the lead and company, the campaign, the sending mailbox, the subject, the sent time, and engagement as text ("Opened twice, clicked once, no reply") rather than a row of unlabelled icons.
- A "Follow up" action on a row opens the existing manual reply composer prefilled with the thread, so a decision made in this view can be acted on without navigating away.
- Loading: skeleton rows. Empty: "Nothing sent yet" or, with filters, "Nothing matches these filters" with a Clear filters action. Error: inline banner with Retry preserving filters.
- Accessibility: engagement is text; timestamps carry absolute values in accessible names; the status filter is a labelled multi-select whose options include the plain-English meaning of `Not Replied` ("Opened, no reply"). Responsive: engagement collapses to a single summary line under 640px.

**Definition of done**
- [ ] The Sent view shares the filter bar with the other inbox views and reflects state in the URL.
- [ ] Engagement is rendered as words, and unavailable open data is stated as unknown rather than negative.
- [ ] The Follow up action opens the existing composer with the thread intact.
- [ ] Loading, empty, filtered-empty, error and bounced states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** the shared inbox query to serve outbound messages with their engagement data, **so that** Sent, Replies and the rest are one code path.

**Scope**
- Route in `server/routes.js`: extend `GET /api/inbox/threads` with `direction=outbound` plus the shared filters and sorts (`sent_desc`, `reply_desc`), the 20-row cap, and a campaign ceiling of 15 for this view.
- Data model: none new — engagement comes from the existing tracking data written by the open pixel, the signed click links and the unsubscribe footer; `stats.opens`, `stats.clicks` and `stats.replies` are read from those rows rather than recomputed per request. An index on (`workspace_id`, `sent_at`, `id`) supports the sent-time sort.
- Open data honesty: the response carries a per-campaign flag for whether open tracking has ever fired, so the client can distinguish "not opened" from "we cannot know" — the same rule the follow-up timing logic already applies when it ignores "never opened" on campaigns where tracking has not demonstrably worked.
- Pagination: cursor on (sort key, id) with `total_count` from a separate cheap count; 429 retried by the client with backoff and jitter.
- Logged: no event per read. `telemetry` records query latency and the proportion of rows with unknown open data so Monitoring can flag a campaign whose tracking is not reaching recipients.

**Definition of done**
- [ ] Outbound direction and both sorts added to the shared route, covered by tests.
- [ ] A test asserts the unknown-open-data flag is set for a campaign with no recorded opens and clear for one with opens.
- [ ] Engagement counts match Reports for the same campaign and window, asserted by a test.
- [ ] Paging is stable when a send lands between page reads.

## 6. End-to-end test ticket

**Title:** E2E — Find the leads who engaged but never answered

**Preconditions:** A workspace with one sandbox mailbox, two running campaigns, twelve leads sent to; four opened with no reply, two clicked with no reply, three replied, one bounced, two with no recorded activity.

**Flow**
1. Open Inbox and switch to the Sent view.
2. Sort by "Newest sent" and confirm all twelve rows page correctly.
3. Filter status to "Opened, no reply" and "Clicked".
4. Narrow to one campaign.
5. Open the Follow up action on one row.
6. Look at the bounced row.

**Assertions**
- [ ] Twelve rows list with engagement described in words, not icons alone.
- [ ] The status filter returns exactly the six engaged-but-silent leads and the count is announced.
- [ ] Narrowing to one campaign reduces the set correctly and the filter state appears in the URL.
- [ ] Follow up opens the manual reply composer with the existing thread and does not send anything without an explicit OK.
- [ ] The bounced row shows Bounced, the lead's stage reflects it, and a "block this domain" action is offered.
- [ ] The two leads with no recorded activity show "opens not tracked on this campaign" rather than "not opened".

**Teardown:** Delete both campaigns and their leads, reset the sandbox mailbox counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Sent filter value reusing the shared filter bar | Medium | No new tab and no new page; the row component is shared, with the reply snippet replaced by the subject and engagement summary |
| Inbox rows | Engagement described in words | Low | One secondary line; replaces nothing that exists today in the Sent view |
| Reports | Unchanged; per-campaign rates already live there | Low | This view answers "which leads", Reports answers "what rate" — the split is stated in both places |
| Monitoring | Unknown-open-data proportion telemetry | Low | One line in the existing delivery telemetry list |

**Verdict:** Fits an existing surface

Harry shows sent messages inside each thread and aggregates them in Reports, but there is no way to list all sent emails and slice them by engagement, so the segment "opened twice, never answered" is currently unreachable. Adding it as a filter value on the Replies tab avoids a second inbox and keeps the boundary with Reports clear: this view is for picking leads to act on, Reports is for rates and learning.
