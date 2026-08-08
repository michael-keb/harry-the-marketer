# Get Campaign Leads

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/get-by-campaign |
| **Auth** | API key (query param `api_key`) |

Lists the people attached to one campaign, a page at a time, with filters for status, label, engagement and when things happened.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** a filterable, paged list of the people in a campaign, **so that** I can find the ones who need me — the ones who opened but never replied, the ones stuck, the ones that bounced — without scrolling past everyone else.

**Acceptance criteria**
- [ ] Given a campaign, when I open its lead list, then each row shows the person's name, email, company, their status in this campaign, their label, when they were attached, and their derived stage.
- [ ] Given the list is paged, when I scroll, then pages of at most 100 load using an offset, and the total count of leads matching the current filter is shown so I know how big the list is.
- [ ] Given a status filter, when I apply it, then only leads at that status are returned — Harry's equivalents of `STARTED`, `INPROGRESS`, `COMPLETED`, `PAUSED` and `STOPPED` mapped to its own playbook states (waiting to start, running, finished, paused, stopped by a human).
- [ ] Given an engagement filter, when I apply it, then I can narrow to opened, clicked, replied, bounced, unsubscribed, marked as spam, or not replied, matching the source API's `emailStatus` values.
- [ ] Given a date filter, when I apply it, then I can narrow to leads added after a date, last emailed after a date, or with any activity after a date.
- [ ] Given each lead, when it renders, then its custom fields and its unsubscribed flag are available without a second request, so the row can show a suppression warning immediately.
- [ ] Given a campaign with no leads, or filters that match nothing, when the list loads, then the empty state distinguishes "no leads attached yet" from "no leads match these filters" and offers to clear the filters.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Request page one with a page size of 50 | 200 with the total count, the offset and limit echoed, and up to 50 lead objects each carrying the campaign-lead mapping, status, label, added-at and the nested person record |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the list shows a sign-in prompt, not an empty state |
| TC-3 | Campaign not found / wrong workspace | Request another workspace's campaign id | 404 with a campaign-not-found error; no leads leak across workspaces |
| TC-4 | Validation failure | Request a page size of 500 or an unknown status value | 422 naming the parameter and its allowed range or values |
| TC-5 | Rate limited | Page rapidly through 30 pages | 429 on some pages; the list backs off and resumes at the same offset with no duplicate rows |
| TC-6 | Empty result set | Filter to "replied" on a campaign that has never had a reply | 200 with an empty list; "No leads match these filters" and a clear-filters action |
| TC-7 | Status filter | Filter to paused | Only paused leads are returned, and the count matches the paused figure on the stage strip |
| TC-8 | Engagement filter | Filter to opened-but-not-replied | Only leads with at least one open and no reply are returned |
| TC-9 | Date filter | Filter to leads added after yesterday | Only leads whose attached-at is later than the cutoff are returned |
| TC-10 | Unsubscribed lead in the list | Read a lead whose unsubscribed flag is true | The row shows a suppression warning and no action offers to email them |
| TC-11 | Stable paging under change | Attach a lead while paging through the list | No row is shown twice and none is skipped; the ordering is stable |

## 4. Frontend user story

**As a** campaign owner, **I want** the campaign's lead list to be filterable the same way the Leads page is, **so that** I do not have to learn two different lists.

**Scope**
- Campaigns → campaign detail: the attached-leads table gains the same click-to-filter stage strip the Leads page already has, plus filters for engagement and date.
- Each row links to the lead detail; the row shows the current playbook node so it lines up with the node-performance figures already on the campaign page.
- Loading: skeleton rows on first load, a footer spinner when paging. Empty: two distinct messages for "none attached" and "none match". Error: an inline retry that preserves filters.
- Filter state lives in the URL so a filtered list can be shared with a teammate in the same workspace.
- Accessibility: a real table with header associations and sortable column buttons; filters are checkboxes with visible labels, not icons. Responsive: below 768px the table becomes a card list keeping name, stage and last activity.

**Definition of done**
- [ ] The stage strip on the campaign page behaves identically to the one on Leads.
- [ ] Filters survive a page refresh via the URL.
- [ ] Paging never duplicates or skips a row while the campaign is running.
- [ ] Unsubscribed leads are visibly marked and cannot be actioned into an email.

## 5. Backend user story

**As a** Harry API, **I want** one filterable, paged campaign-lead query, **so that** the campaign page and the Leads page share the same filtering logic instead of drifting apart.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/leads` accepting `offset`, `limit` (default 100, max 100), `status`, `categoryId`, `engagement`, `addedAfter`, `lastSentAfter` and `activityAfter`, workspace-scoped.
- Data model: none new. Reads `leads` joined to `campaign_leads`, with engagement predicates over the existing tracking and message data. The derived stage is computed by the shared stage function so the strip counts and the rows agree.
- Pagination by offset with a total count for the current filter; ordering is by attached-at then id so paging is stable while the engine is running.
- Filter values are validated against fixed enumerations and rejected with 422 naming the parameter; standard rate limiting, with 429 retried by the client.
- Logged: `telemetry` for query duration and result size so Monitoring notices when a big campaign's list slows down. No `events` row for reads.

**Definition of done**
- [ ] The same filter code serves both `/api/leads` and `/api/campaigns/:id/leads`.
- [ ] Ordering is deterministic and covered by a test that attaches a lead mid-page.
- [ ] Every filter combination is covered by at least one test, including the empty case.
- [ ] Cross-workspace campaign ids return 404.

## 6. End-to-end test ticket

**Title:** E2E — Filter a campaign's lead list down to the people who need attention

**Preconditions:** A workspace with one sandbox mailbox and a campaign of 40 leads: 10 never contacted, 20 contacted with 8 opens, 5 replied, 3 bounced, 2 unsubscribed.

**Flow**
1. Campaigns → campaign detail → attached leads.
2. Click "contacted" on the stage strip.
3. Add the engagement filter "opened, not replied".
4. Copy the URL and open it in a second tab.
5. Clear the filters and filter to "unsubscribed".
6. Open one unsubscribed lead.

**Assertions**
- [ ] The unfiltered list shows 40 with a total count, paging in one page.
- [ ] The stage strip counts sum to 40 and match the filtered result sizes.
- [ ] "Opened, not replied" returns exactly the 8 opens minus any who replied.
- [ ] The copied URL reproduces the same filtered view in the second tab.
- [ ] The unsubscribed rows carry a suppression warning and no email action is available on them.

**Teardown:** Delete the campaign and its leads; clear the sandbox mailbox's recorded sends.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | Attached-leads table gains stage strip, engagement and date filters | Medium | Reuses the exact components from the Leads page; no new filter vocabulary |
| Leads | Engagement and date filters added to match | Medium | Placed in the existing filter menu; the stage strip stays the primary control |
| Campaign node performance | Rows show the current playbook node | Low | The number is already computed for the node-performance panel |

**Verdict:** Fits an existing surface

Harry's Leads page already has a derived stage strip you click to filter; this is the same list scoped to one campaign, and the honest answer is that it should be the same component. The new part is engagement and date filtering, which is worth adding to both places rather than only to the campaign page.
