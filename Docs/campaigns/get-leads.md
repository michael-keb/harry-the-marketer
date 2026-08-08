# Get Campaign Leads

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-leads |
| **Auth** | API key (query param `api_key`) |

Lists the people in a campaign, paged, with filters for where they have got to and how they have engaged.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to filter a campaign's leads by where they are and how they responded, **so that** I can find the twelve people worth acting on today instead of scrolling five thousand rows.

**Acceptance criteria**
- [ ] Given a campaign with leads, when I list them, then each entry carries id, email, names, company, status, category, created and last-sent timestamps, engagement flags and custom fields — mirroring the source API's `id`, `email`, `first_name`, `last_name`, `company_name`, `status`, `category_id`, `category_name`, `created_at`, `last_sent_time`, `email_stats` and `custom_fields` — alongside `total`, `offset` and `limit`.
- [ ] Given paging, when I request a page, then the default is 100 per page, the maximum is 100, the offset cannot be negative, and `total` reflects the filtered count so the pager is accurate.
- [ ] Given a status filter, when I use it, then the sequence states the source API defines (`STARTED`, `INPROGRESS`, `COMPLETED`, `PAUSED`, `STOPPED`) map onto Harry's derived stages — not contacted, in the playbook, finished, paused, stopped — and the mapping is stated once in the UI, not left implicit.
- [ ] Given an engagement filter, when I use it, then I can filter by opened, clicked, replied, bounced, unsubscribed, marked as spam, or opened-but-not-replied — the source API's `emailStatus` values including `not_replied`.
- [ ] Given date filters, when I filter by created after, last sent after, or last event after (the `created_at_gt`, `last_sent_time_gt` and `event_time_gt` behaviour), then the results respect the boundary inclusively and the filter is shown on screen.
- [ ] Given filters combine, when I apply status and engagement together, then they are combined with AND, and the UI states the combination in words.
- [ ] Given no lead matches, when I apply a filter, then I get a 200 with an empty list and a `total` of 0, and the table shows an empty state naming the filter that produced it.
- [ ] Given the filtered set, when I export, then the export produces exactly the rows the filter shows.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the campaign's leads with `limit=100` on a campaign with 150 leads | 200 with `total: 150`, 100 leads, `offset: 0`, `limit: 100`, each lead carrying the documented fields |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401; no personal data returned |
| TC-3 | Not found / wrong workspace | GET for another workspace's campaign | 404; no lead data disclosed |
| TC-4 | Validation failure | GET with `limit=500` and `offset=-1` | 422 with field-level messages naming `limit` (max 100) and `offset` (min 0) |
| TC-5 | Rate limited | Page through 5,000 leads as fast as possible | 429 on the excess; the client backs off and completes without gaps or duplicates |
| TC-6 | Empty result set | Filter by `emailStatus=is_replied` on a campaign with no replies | 200 with `total: 0` and an empty list; table shows "No leads have replied yet" naming the filter |
| TC-7 | Engagement filter | Filter by `is_clicked` on a campaign where 12 leads clicked | Exactly those 12 are returned and the count matches the campaign's metrics strip |
| TC-8 | Opened but not replied | Filter by `not_replied` | Returns leads with an open and no reply; excludes leads never opened and leads who replied |
| TC-9 | Combined filters | Filter status in-progress plus `is_clicked` | Results satisfy both; the UI states "In the playbook and clicked a link" |
| TC-10 | Date filter boundary | Set created-after to the exact timestamp of one lead's creation | That lead is included, and the boundary rule is stated |
| TC-11 | Paging consistency | Fetch offset 0 and offset 100 while the engine is sending | No lead appears on both pages and none is skipped; ordering is stable |
| TC-12 | Custom fields | List leads imported with two custom fields | Both are returned per lead and can be shown as optional table columns |

## 4. Frontend user story

**As a** campaign owner, **I want** the campaign's leads table to filter the way I think, **so that** "who clicked but never replied" is one click rather than an export and a spreadsheet.

**Scope**
- Campaigns → campaign detail → leads: a table with the stage filter strip Harry already uses on the Leads page, plus engagement filters (opened, clicked, replied, bounced, unsubscribed, opened-not-replied) and date filters, all reflected in the URL.
- Columns: name, company, stage, last email sent, engagement chips, qualification score. Custom fields are available as optional columns via a column picker, off by default.
- Row actions reuse existing behaviour: open the lead, open the thread, remove from campaign. Multi-select enables bulk remove and export of exactly the filtered set.
- Loading: skeleton rows keeping the header stable; empty: a message naming the active filter with a one-click clear; error: the last-known rows are retained with a retry banner.
- Accessibility: filters are toggle buttons with pressed state and a live-announced result count; the table has proper header associations and a caption stating the active filter; engagement is text plus icon. Responsive: the table becomes stacked cards under 768px with stage and last-sent first.

**Definition of done**
- [ ] Stage, engagement and date filters combine and are shown in words above the table.
- [ ] The result count is announced and matches the pager and any export taken from it.
- [ ] Column picker persists per user and defaults to a small set.
- [ ] Empty states name the filter rather than saying "no results".

## 5. Backend user story

**As a** Harry API, **I want** a filtered, paged campaign-leads route, **so that** a five-thousand-lead campaign renders a page at a time with accurate totals.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/leads` accepting `stage`, `engagement`, `createdAfter`, `lastSentAfter`, `eventAfter`, `q`, `limit` (default 100, max 100) and `offset` (min 0), workspace-scoped, returning `{ leads, total, offset, limit }`.
- Data model: reads `campaign_leads` joined to `leads` and aggregated `messages` in `server/db.js`. Stage and engagement are derived, not stored, matching the Leads page derivation exactly. Indexes on `(campaign_id, lead_id)` and on message timestamps keep filtered counts cheap.
- Ordering is stable — by last activity then lead id — so paging during an active run cannot duplicate or skip a lead. `total` is the filtered count, computed in the same query.
- Standard rate limiting. The same filter parser is shared with the CSV export route so the two can never disagree.
- Logged: nothing to `events` for a read. `telemetry` records filter combinations and query durations, which also shows which filters people actually use.

**Definition of done**
- [ ] Filters, paging and totals are covered by tests including combinations and boundaries.
- [ ] Stable ordering under concurrent sends is covered by a test.
- [ ] Export and list share one filter parser, asserted by a test on the same fixture.
- [ ] A 5,000-lead campaign returns a page within the query-time budget.

## 6. End-to-end test ticket

**Title:** E2E — Find the leads worth acting on inside a large campaign

**Preconditions:** A workspace with a sandbox mailbox and a campaign of 300 leads: 200 contacted, 60 opened, 20 clicked, 12 replied, 3 bounced, 2 unsubscribed, 100 never contacted. Two custom fields imported.

**Flow**
1. Open Campaigns → campaign detail → leads.
2. Filter to "opened but not replied".
3. Add the "clicked" filter.
4. Add a custom-field column from the column picker.
5. Export the filtered set.
6. Clear the filters and page to the end of the list.

**Assertions**
- [ ] The opened-not-replied filter returns leads with an open and no reply, and states that in words above the table.
- [ ] Adding "clicked" narrows the set and the announced count updates.
- [ ] The custom-field column appears and persists across a reload.
- [ ] The exported file contains exactly the rows shown, no more.
- [ ] Paging to the end with the engine running shows no duplicate or missing lead.
- [ ] The unsubscribed leads are visible under their own filter and offer no campaign actions.

**Teardown:** Delete the campaign and the exported file; keep the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail leads table | Engagement and date filters, column picker | Medium | Reuses the Leads page filter strip; extra filters live behind a single "More filters" control, and the column picker defaults to a small set |
| Leads | Same components at workspace scope | Low | Shared components, one behaviour to learn |
| Export | Inherits the active filter | Low | Removes a second place to specify what to export |

**Verdict:** Fits an existing surface

Harry already has a click-to-filter stage strip on the Leads page, and this is that pattern applied inside a campaign with engagement added. Keeping one filter vocabulary across both tables means a user learns it once, and the export inheriting the filter removes the most common source of "why does my spreadsheet not match the screen".
