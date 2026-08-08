# Fetch Campaign Lead Statistics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads-statistics` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/lead-statistics |
| **Auth** | API key (query param `api_key`) |

Returns the per-lead activity inside one campaign, a page at a time, optionally only for leads whose last event happened after a date you choose.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer running a campaign, **I want** to page through every lead in it with what has happened to each one, **so that** I can spot the people worth a personal follow-up and the ones who have gone quiet.

**Acceptance criteria**
- [ ] Given a campaign with leads, when lead statistics are fetched with `limit=100&offset=0`, then a page of leads is returned, each with its activity, and the campaign's lead list renders in the order returned.
- [ ] Given `limit` is above 100, when the request is made, then it is clamped to the documented maximum of 100 and paging still covers every lead.
- [ ] Given `event_time_gt=2024-03-01`, when lead statistics are fetched, then only leads whose most recent event (a send, an open, a reply and so on) falls after that date are returned, and the filter is shown as a removable chip reading "Active since 1 Mar".
- [ ] Given the caller pages past the last lead, when `offset` exceeds the total, then a 200 with `data: []` is returned and the list stops rather than looping.
- [ ] Given a campaign with no leads attached, when lead statistics are fetched, then `data` is empty and the page shows "No leads attached yet" with a link to attach some.
- [ ] Given the API key is missing or invalid, when statistics are fetched, then the 401 `{"message": "Invalid API Key"}` is surfaced once and the rest of the campaign page still renders.
- [ ] Given a lead was unsubscribed, when its row renders, then its stage is shown as unsubscribed and no follow-up action is offered on it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with 40 leads and mixed activity. Call with `limit=100&offset=0` | 200, `ok: true`, `data` holds 40 lead rows whose activity matches the fixture |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; one banner, page still usable |
| TC-3 | Not found / wrong workspace | Call with a campaign id owned by someone else | 404; "Campaign not found", no lead emails leak |
| TC-4 | Validation failure | Call with `event_time_gt=March 2024` | 400 naming `event_time_gt` and the `YYYY-MM-DD` format; the date field is marked and the list keeps its previous contents |
| TC-5 | Rate limited | Scroll fast enough to request five pages in one second | 429; the infinite scroll pauses, retries once after `Retry-After`, and shows "Loading more…" rather than an error |
| TC-6 | Empty result set | Call on a campaign with no leads attached | 200 with `data: []`; "No leads attached yet" and an Attach leads link |
| TC-7 | Pagination | Seed 250 leads, call `limit=100` at offsets 0, 100, 200 | 100, 100 and 50 rows; no lead appears on two pages |
| TC-8 | Limit clamp | Call with `limit=500` | At most 100 rows returned; paging still reaches every lead |
| TC-9 | Recent-activity filter | Set `event_time_gt` to yesterday on a campaign whose last activity was a week ago | 200 with `data: []` and the empty state naming the filter, with a one-click clear |
| TC-10 | Lead removed mid-page | Delete a lead between fetching page 1 and page 2 | No duplicate or skipped row on page 2; the deleted lead disappears on the next refresh without an error |

## 4. Frontend user story

**As a** marketer, **I want** the campaign's own lead list with each lead's activity and stage, **so that** I can act on individual people from the campaign I am already looking at.

**Scope**
- Campaign detail page: a Leads tab reusing the existing Leads page row component (name, company, stage chip, last activity) so nothing new has to be learned, with infinite scroll backed by `offset`/`limit`.
- The stage strip from the Leads page is reused as a click-to-filter row, plus one "Active since…" date filter mapped to `event_time_gt`.
- Loading appends a skeleton row set; empty shows "No leads attached yet" or, when a filter is on, the filter-aware empty state with a clear button; error keeps loaded rows and offers Retry.
- Accessibility: the list is a table with a caption naming the campaign, rows reachable by keyboard, and "Loading more" announced politely. On narrow screens the row collapses to two lines.

**Definition of done**
- [ ] Rows are keyed on lead id so paging never duplicates.
- [ ] Filters live in the URL and survive a reload.
- [ ] Clicking a row opens the same lead detail used by the Leads page, not a second variant.
- [ ] Empty, filtered-empty, loading and error states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a paged per-lead statistics route scoped to one campaign, **so that** the campaign Leads tab does not have to load and filter the whole workspace's leads.

**Scope**
- Route: `GET /api/campaigns/:id/leads-statistics?limit&offset&event_time_gt`, sitting with the other campaign routes in `server/routes.js` behind the existing workspace guard.
- Data model: none new. Rows are derived from `campaign_leads` joined to `leads`, `messages` and `events`; stage is derived, never stored, matching the rule the Leads page already follows.
- `limit` defaults to 100 and clamps to 100; `offset` defaults to 0; ordering is stable (last event descending, then lead id) so paging cannot duplicate. Reporting rate limit applies with `Retry-After` on 429.
- Telemetry: query duration and page size to `telemetry`; nothing lead-identifying is logged.

**Definition of done**
- [ ] Stable ordering is proved by a test that inserts a lead between two page fetches.
- [ ] `event_time_gt` is validated as `YYYY-MM-DD` and rejected with 400 otherwise.
- [ ] Cross-workspace campaign ids return 404.
- [ ] No lead email addresses appear in telemetry rows.

## 6. End-to-end test ticket

**Title:** E2E — Per-lead activity inside a campaign

**Preconditions:** A workspace with one campaign, a sandbox mailbox, 120 attached leads, activity seeded so 30 have replied, 5 have unsubscribed and 40 have had no activity for two weeks.

**Flow**
1. Sign in and open the campaign, then the Leads tab.
2. Scroll to the bottom of the first page and let the next page load.
3. Click the "replied" stage chip.
4. Set "Active since" to seven days ago.
5. Clear both filters and open one lead.

**Assertions**
- [ ] The first page shows 100 rows and the second adds 20, with no lead repeated.
- [ ] The "replied" chip narrows the list to 30 rows.
- [ ] "Active since" seven days ago excludes the 40 dormant leads.
- [ ] The five unsubscribed leads show the unsubscribed stage and offer no follow-up action.
- [ ] Opening a lead lands on the same lead detail the Leads page opens.

**Teardown:** Delete the campaign, its leads, messages and events; clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | A Leads tab beside the playbook and Node performance | Medium | Reuses the Leads page row, stage strip and detail drawer verbatim; no new visual language |
| Leads page | Unchanged | Low | The campaign view is a scoped instance of the same list, not a fork |

**Verdict:** Fits an existing surface

Harry already has a Leads page with derived stages and a filter strip; the campaign view is that list with a campaign filter pinned on. A tab on the campaign detail page adds no navigation item and keeps the answer to "who in this campaign needs me" one click from the diagram that produced them.
