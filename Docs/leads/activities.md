# Get All Leads Activities

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/all-leads-activities` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/activities |
| **Auth** | API key (query param `api_key`) |

Returns one timeline per lead of every email sent to them and what they did with it — opens, clicks, replies and the back-and-forth that followed.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** one activity timeline per lead across every campaign, filtered by date, **so that** I can see what has actually happened to a person without opening five campaigns and a thread view.

**Acceptance criteria**
- [ ] Given leads with sent emails, when I open the activity feed, then each entry shows the lead, the campaign name and status, the lead's status in that campaign, the current sequence position, and a list of email activities in time order.
- [ ] Given an email activity, when it is rendered, then it shows the subject, the sending mailbox, the recipient, when it was sent, the playbook step it came from, and its open and click counts.
- [ ] Given a lead replied, when I view that activity, then the reply is shown inline with its time and body, along with any later replies in the same thread.
- [ ] Given I set a date range (the equivalent of `event_time_from` and `event_time_to`), when I apply it, then only activities inside the range are returned, and setting an end without a start is refused with a message rather than silently ignored.
- [ ] Given more results exist than one page, when I scroll to the end, then the next page loads using an offset and a "has more" flag, in pages of at most 1,000.
- [ ] Given a workspace with no sends yet, when I open the feed, then an empty state explains that activity appears once a campaign has sent its first email, with a link to Campaigns.
- [ ] Given a malformed date is supplied, when the request runs, then the API returns a validation error naming the offending parameter and the feed keeps showing the previous results.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Request the feed with a 7-day range and a page size of 50 | 200 with a `data` array of lead timelines, each carrying `campaign_name`, `status`, `current_seq_num` and an `activities` array, plus a `hasMore` flag |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the feed shows a sign-in prompt, not an empty state |
| TC-3 | Wrong workspace | Request a lead timeline belonging to another workspace by id | 404; nothing from the other workspace appears in the feed |
| TC-4 | Validation failure — bad date | Send `event_time_from=25-11-2025` | 400 with a message naming the date format expected (`YYYY-MM-DD` or ISO 8601), surfaced above the date picker |
| TC-5 | Validation failure — out-of-range page size | Request a page size of 5000 | 422 naming the limit (1–1000); the UI never offers a size above the maximum |
| TC-6 | Rate limited | Page rapidly through 20 pages | 429 on some pages; the client backs off and resumes, no page is skipped or duplicated |
| TC-7 | Empty result set | Request a range before the first send | 200 with an empty `data` array; the feed shows "No activity in this period" and keeps the date picker visible |
| TC-8 | End date without start date | Send only `event_time_to` | 400 with a message that the end needs a start; the picker forces both |
| TC-9 | Lead with opens but no reply | Read a lead whose email has `open_count: 3` and `reply_details: null` | The timeline shows three opens and no reply row, and the lead's stage still reads "contacted" |
| TC-10 | Threaded conversation | Read a lead with several `thread_replies` | All replies appear in order under the originating email, newest last, with no duplication of the first reply |

## 4. Frontend user story

**As a** campaign owner, **I want** a per-lead activity timeline I can reach from anywhere a lead appears, **so that** I can answer "what have we actually said to this person" in one click.

**Scope**
- Leads → lead detail: a new "Activity" tab beside the existing research profile, showing the lead's emails, opens, clicks and replies in one column, with the playbook step name on each send.
- Dashboard: the existing 14-day chart and activity trail stay as they are; the cross-lead feed is reached from Reports rather than becoming a new nav item.
- Loading: skeleton rows the height of a real entry so the page does not jump. Empty: "Nothing sent to this lead yet". Error: an inline retry that keeps the date filter.
- Date range control shared with Reports so the two read the same way; pagination is infinite scroll with an explicit "Load more" fallback for keyboard users.
- Accessibility: the timeline is an ordered list, each entry a landmark with a readable timestamp (not just relative time); open and click counts are text, not only icons. Responsive: below 640px the metadata row wraps under the subject.

**Definition of done**
- [ ] Every send shows which mailbox it went from and which playbook node produced it.
- [ ] Replies render inside the timeline, not as a link out to the Inbox.
- [ ] Opens and clicks are shown as counts with a caveat that open tracking is unreliable, matching how Reports already words it.
- [ ] The empty state distinguishes "never contacted" from "no activity in this date range".

## 5. Backend user story

**As a** Harry API, **I want** a paginated, date-filterable activity query across all leads, **so that** the timeline can be assembled in one round trip instead of the client stitching messages together.

**Scope**
- Route in `server/routes.js`: `GET /api/leads/activities` accepting `offset`, `limit` (default 100, max 1000), `from` and `to`, and `GET /api/leads/:id/activities` for the single-lead tab. Both workspace-scoped like the existing lead handlers.
- Data model: none new. The response is assembled from `messages` (sent and received), `campaign_leads` for the per-campaign status and current node, and the tracking counters already written by the open pixel and click links.
- Pagination by offset with a `hasMore` boolean rather than a total count, so a large workspace does not pay for a count query on every page. `from` without `to` is allowed; `to` without `from` is a 400.
- Rate limiting is the app default; the client retries 429 with backoff and resumes at the same offset.
- Logged: `telemetry` records query duration and page size so Monitoring can catch the feed getting slow as message volume grows. No `events` row — reading is not an act.

**Definition of done**
- [ ] One query per page, not one per lead; verified by a test that asserts query count is constant as the page fills.
- [ ] Cross-workspace leads are never returned, covered by a test with two workspaces.
- [ ] Date filters are validated and their errors name the parameter.
- [ ] Replies are grouped under the email they answered, including later replies in the same thread.

## 6. End-to-end test ticket

**Title:** E2E — Read a lead's full activity timeline after a simulated conversation

**Preconditions:** A workspace with one sandbox mailbox, one campaign whose playbook has a Send node, a reply-interested edge and a follow-up node, and one lead attached.

**Flow**
1. Launch the campaign and approve the first email in Inbox → Needs your OK.
2. Simulate an open and a link click on the sandbox mailbox.
3. Simulate an interested reply, then a second reply in the same thread.
4. Let the engine tick so it follows the interested edge and drafts the next email.
5. Open Leads → the lead → Activity.
6. Set the date range to yesterday only.

**Assertions**
- [ ] The timeline shows the approved email with its subject, the sending mailbox and the playbook step name.
- [ ] Open count reads 1 and click count reads 1 on that email.
- [ ] Both replies appear under it, in order, with their times.
- [ ] The lead's stage strip on the Leads page reads "replied" and then "interested" without a page reload.
- [ ] With the range set to yesterday, the timeline shows "No activity in this period" and the entries return when the range is cleared.

**Teardown:** Delete the campaign and the lead; clear the sandbox mailbox's recorded sends.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → lead detail | New "Activity" tab next to the research profile | Low | A tab, not a new page; the profile stays the default view |
| Reports | Cross-lead activity feed with the existing date range | Medium | Lives under the existing Learning section rather than as a new report |
| Dashboard | None | Low | The activity trail already covers agent actions; this is lead-facing and stays out |
| Inbox → thread | "See full activity" link on the lead | Low | One link, no new panel |

**Verdict:** Fits an existing surface

Harry already shows messages per thread in the Inbox and per-node counts in the campaign editor; what is missing is the per-person view that crosses campaigns. A tab on the lead detail carries it without a new navigation item, and the cross-lead feed belongs in Reports where date-ranged reading already happens.
