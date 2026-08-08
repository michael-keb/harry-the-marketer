# Get All Lead Lists

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/lead-list/` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/get-all |
| **Auth** | API key (query param `api_key`) |

Returns the saved lead groups in the account, with optional name search, label filter, and paging.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to see all my segments with how many leads each holds, and narrow them by name or label, **so that** I can find the right group in seconds even after a year of accumulating them.

**Acceptance criteria**
- [ ] Given segments exist, when I list them, then each item carries `id`, `name`, `lead_count` and `created_at`, and the counts match what the Leads page shows when I filter by that segment.
- [ ] Given a `listName` query of "enterprise", when I search, then segments whose name contains that string in any case are returned — it is a partial match, not an exact one.
- [ ] Given a `tagIds` query of `1,2`, when I filter, then only segments carrying at least one of those labels are returned, and the applied labels are shown as removable chips.
- [ ] Given more segments than fit one page, when I scroll or page, then `limit` (1-1000, default 10) and `offset` (minimum 0, default 0) are used, and no segment is shown twice or skipped across pages.
- [ ] Given both `listName` and `tagIds` are supplied, when I search, then the two narrow the result together rather than one replacing the other.
- [ ] Given no segments match, when the result comes back, then a 200 with an empty `data` array renders "No segments match this search" with a one-click way to clear the filters.
- [ ] Given a `limit` above 1000 or an `offset` below 0, when I request it, then a 422 names the offending parameter and its allowed range.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET /lead-list/?limit=20&offset=0` with 2 segments | 200 with a `data` array of 2 objects, each having `id`, `name`, `lead_count`, `created_at` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the panel shows a sign-in prompt, not an empty state |
| TC-3 | Not found / wrong workspace | Request with a session whose workspace was removed | 404; no other workspace's segments are returned |
| TC-4 | Validation failure | `GET /lead-list/?limit=5000` | 422 naming `limit` and the 1-1000 range |
| TC-5 | Rate limited | Type quickly in the search box, firing 30 requests | 429 on the excess; the client debounces and backs off, and the last keystroke's result is the one shown |
| TC-6 | Empty result set | `GET /lead-list/?listName=zzzz` | 200 with `data: []`; "No segments match this search" plus a Clear button |
| TC-7 | Partial name match | Segments "SMB Tech Companies" and "Q1 2025 Enterprise Prospects"; `listName=tech` | 200 returning only "SMB Tech Companies" |
| TC-8 | Label filter | `tagIds=1,2` where segment 500 has label 1 only | 200 returning segment 500 |
| TC-9 | Paging boundary | 25 segments; request `limit=10&offset=20` | 200 with the final 5 segments, no repeats against the earlier pages |
| TC-10 | Default paging | `GET /lead-list/` with no parameters and 40 segments | 200 with 10 items, the documented default |
| TC-11 | Count accuracy | Add a lead to segment 500, then list | `lead_count` for 500 has increased by exactly 1 with no cache staleness |

## 4. Frontend user story

**As a** campaign owner, **I want** my segments listed with counts and a search box, **so that** picking a group to work on is a glance and a click.

**Scope**
- Leads page → Segments panel: a scannable list of segment name, lead count and label chips, sorted by most recently used, sitting directly beneath the existing stage filter strip.
- A single search input filtering by name (`listName`) with a 250ms debounce, plus a label filter reusing the same chip pattern as the stage strip so nothing new has to be learnt.
- Paging: the panel loads the first 25 and appends on scroll using `offset`, since a workspace can hold up to 1,000 segments. Counts render as "1,250 leads" with thousands separators.
- States: skeleton rows while loading; "No segments yet — create one to group leads you will reuse" when the workspace has none; "No segments match this search" with a Clear button when filters exclude everything; an inline retry on error.
- Accessibility: the list is a `<ul>` of buttons with the count in the accessible name ("Q1 2025 Enterprise Prospects, 1,250 leads"), search results announced via `aria-live="polite"`. Responsive: the panel becomes a dropdown above the table under 768px.

**Definition of done**
- [ ] Selecting a segment filters the existing Leads table rather than opening a separate view.
- [ ] Search and label filters combine and are both clearable in one action.
- [ ] Counts are never stale after adding or removing leads.
- [ ] The panel is usable with the keyboard alone.

## 5. Backend user story

**As a** Harry API, **I want** a listing route with name search, label filter and paging, **so that** the Segments panel stays fast with a thousand segments and a hundred thousand leads.

**Scope**
- Route in `server/routes.js`: `GET /api/lead-lists?q=&tagIds=&limit=&offset=`, workspace-scoped, mirroring the query-parameter conventions of the existing list handlers.
- Data model: reads `lead_lists`, left-joining `lead_list_leads` for a derived `leadCount` and `lead_list_tags` for the labels. Indexes on `(workspace_id, name)` and on the join tables keep the count aggregate cheap; the count is computed, never stored.
- `limit` clamped to 1-1000 defaulting to 25 for the panel, `offset` floored at 0; out-of-range values return 422 naming the parameter. `tagIds` is parsed from a comma-separated string and matched as "carries any of these".
- Standard app rate limiting applies; the client debounces search and backs off on 429.
- Logged: no `events` row for a read; `telemetry` records query duration and result size so Monitoring can catch the count aggregate degrading as segments grow.

**Definition of done**
- [ ] Name search is case-insensitive and partial.
- [ ] Label filter and name search compose in one SQL query, not two round trips.
- [ ] Paging is stable — a fixed sort means no item appears on two pages.
- [ ] Tests cover the 1-1000 clamp, the combined filter, and count accuracy after membership changes.

## 6. End-to-end test ticket

**Title:** E2E — Find a segment by name and label and filter the lead table with it

**Preconditions:** A workspace with 30 segments, one named "SMB Tech Companies" holding 850 leads and carrying the label "Q1", and one named "Q1 2025 Enterprise Prospects" holding 1,250.

**Flow**
1. Open Leads and look at the Segments panel.
2. Scroll to load beyond the first page.
3. Type "tech" in the segment search.
4. Add the "Q1" label filter.
5. Select the remaining segment.

**Assertions**
- [ ] The first load shows counts formatted with separators and no duplicate rows after scrolling.
- [ ] Searching "tech" narrows to "SMB Tech Companies".
- [ ] Adding the label filter keeps that segment and removes any that lack the label.
- [ ] Selecting it filters the Leads table to 850 rows and shows a removable chip naming the segment.
- [ ] Clearing filters restores the full segment list and the full lead table in one click.

**Teardown:** Clear the filters; no data is created by this flow.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Segments panel with search, label chips and counts | Medium | Placed under the existing stage strip and styled the same, so it reads as a second row of filters rather than a new feature |
| Leads table | A removable "Segment: X" chip when one is selected | Low | Identical to how the stage filter already indicates itself |
| Product navigation | None | Low | No new nav item — segments filter the page the user is already on |

**Verdict:** Fits an existing surface

This is the endpoint that decides whether segments feel like a feature or a filter, and it should feel like a filter: a list beneath the stage strip that narrows the same table. The honest risk is stacking search, stage and segment filters on one page, which is mitigated by showing every active filter as one row of removable chips with a single Clear all.
