# Fetched Searches API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/fetched-searches` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/fetched-searches |
| **Auth** | API key (query param `api_key`) |

Lists the prospect searches you have already spent credits on, with what each one found.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** a history of every prospect search I have fetched and what it returned, **so that** I can see where my leads came from and stop paying twice for the same list.

**Acceptance criteria**
- [ ] Given a valid API key, when I request fetched searches, then I get 200 with `data.fetchedLeads` as an array and `data.totalCount` as the overall number — note the count sits at `data.totalCount`, not inside a `pagination` object as it does on other endpoints in this category.
- [ ] Given a fetched search row, when it renders, then it carries `id`, `user_id`, `search_string` (for example "Director in United States"), `filter_details`, `type`, `include_owned`, `is_saved`, `is_fetched`, `fetch_details`, `created_at` and `updated_at`.
- [ ] Given `fetch_details`, when the row's summary renders, then it shows `leads_found` and `email_fetched` plus the nested `metrics` — `totalContacts`, `totalEmails`, `noEmailFound`, `invalidEmails`, `catchAllEmails`, `verifiedEmails`, `completed`.
- [ ] Given `filter_details` (for example `{ "title": ["Director"], "country": ["United States"], "limit": 100 }`), when I open a row, then the original filters are shown as readable chips and can be reused to build a new search.
- [ ] Given `limit` defaults to `"10"` and must match `^[1-9][0-9]*$`, and `offset` must match `^[0-9]+$`, when I page, then those patterns are enforced before the call and paging never sends a zero or negative value.
- [ ] Given I have fetched nothing yet, when the list loads, then 200 with an empty `fetchedLeads` array and `totalCount: 0`, and the UI shows an empty state that points at starting a search rather than an error.
- [ ] Given a 401, when the list loads, then Harry shows "Prospect search is not connected" with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/search-filters/fetched-searches?api_key=VALID` | 200, `data.fetchedLeads` array with the documented fields, `data.totalCount` present |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Only that account's `user_id` rows are returned; Harry keys its cache per workspace so nothing crosses over |
| TC-4 | Validation failure | GET with `limit=0` | Fails the documented `^[1-9][0-9]*$` pattern; Harry clamps to at least 1 before calling |
| TC-5 | Rate limited | Poll the history every second | 429 on the excess; Harry refreshes on navigation and on an explicit refresh only, with backoff on 429 |
| TC-6 | Empty result set | Call on an account that has fetched nothing | 200, `fetchedLeads: []`, `totalCount: 0`; empty state reads "You have not fetched any prospect lists yet" with a link to start a search |
| TC-7 | Count lives outside pagination | Inspect the 200 body | `totalCount` is at `data.totalCount`; the client must not look for `pagination.count`, which this endpoint does not document |
| TC-8 | Paging | GET `limit=10&offset=0` then `offset=10` | Distinct rows on each page; `totalCount` stays constant and drives the pager |
| TC-9 | Rich fetch details | Open a row whose `metrics.noEmailFound` is greater than zero | The row summary states how many of the found leads had no email, not just `leads_found` |
| TC-10 | Reuse filters | Open a row and click "Search again with these filters" | The prospect search form opens pre-filled from `filter_details`, with a note saying where the filters came from |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load your fetch history just now"; the rest of the Leads page still works |

## 4. Frontend user story

**As a** goal owner, **I want** a "Fetch history" list on the Leads page, **so that** I can see what each prospect pull cost me in leads and emails, and reuse a good search instead of rebuilding it.

**Scope**
- Leads → "Find prospects" → a "History" tab beside the search form, listing fetched searches newest first with `search_string` as the row title and a one-line summary derived from `fetch_details` ("500 found, 480 with emails, 465 verified").
- Expanding a row shows `filter_details` as readable chips, the full metrics as a definition list, and `created_at` / `updated_at` as relative dates with exact values on hover.
- Row actions: "Search again with these filters" (pre-fills the search form) and "View the leads this created" (filters the Leads list by the fetch's source marker).
- State: paged with the documented `limit`/`offset`; loading is skeleton rows; empty state points at starting a first search; error keeps the tab usable.
- The `is_saved` and `is_fetched` flags are shown as plain text status, so a row that is saved but never fetched is not confused with one that cost credits.
- Accessibility: rows are a list with expandable disclosure buttons, not a grid of divs; metrics are a definition list; status is text, never colour alone. Responsive: the summary line wraps and the metrics list stacks under 640px.

**Definition of done**
- [ ] History lists fetched searches with search string, date and a plain-English metrics summary.
- [ ] Expanding a row shows the original filters as chips and all seven metric fields.
- [ ] "Search again with these filters" pre-fills the form and says where the filters came from.
- [ ] Paging uses the documented parameter patterns and the pager is driven by `totalCount`.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied fetch-history route reconciled with Harry's own fetch records, **so that** the history shows both what the provider charged for and which Harry leads resulted.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/fetches?limit=&offset=` returning `{ items: [...], totalCount }`, where each item merges the provider row with Harry's local `prospect_fetches` record (leads created, leads skipped, who ran it).
- Validation: `limit` at least 1 (documented pattern `^[1-9][0-9]*$`), `offset` at least 0 (`^[0-9]+$`), both sent to the provider as strings since the parameters are documented as strings.
- The response's count is read from `data.totalCount`, not from a `pagination` object; this is noted in the route so nobody later copies the pagination shape used by the cities and countries lookups.
- Data model: the `prospect_fetches` table introduced by the fetch-contacts work gains a `provider_filter_id` so provider rows and Harry rows can be joined; no new table.
- Pagination is passed straight through. Rate limiting and retry: bounded exponential backoff with jitter on 429 and 5xx; short cache so a tab switch does not re-call.
- Logged: `telemetry` per upstream call with latency and status. No `events` row — reading a history is not an action worth auditing.

**Definition of done**
- [ ] Route added and workspace-scoped; provider key server-side only.
- [ ] Provider rows join to local fetch records where one exists, and render sensibly where one does not.
- [ ] Parameter patterns enforced and covered by tests.
- [ ] Unconfigured provider returns the "not configured" payload and the History tab hides.

## 6. End-to-end test ticket

**Title:** E2E — Review fetch history and reuse a previous search

**Preconditions:** A stubbed provider serving the documented fetched-searches payload with two rows, one of which matches a local `prospect_fetches` record that created 12 leads.

**Flow**
1. Open Leads → "Find prospects" → History.
2. Read the summary line on the joined row.
3. Expand it and inspect the filters and metrics.
4. Click "View the leads this created".
5. Return to History and click "Search again with these filters".
6. Page to the second page of history.

**Assertions**
- [ ] The joined row shows both provider metrics and "12 leads created in Harry".
- [ ] The unjoined row still renders, without inventing a lead count.
- [ ] Expanding shows `title` and `country` from `filter_details` as chips and every documented metric field.
- [ ] "View the leads this created" filters the Leads list to exactly those 12 leads.
- [ ] "Search again with these filters" opens the search form pre-filled, with a visible note naming the source row.
- [ ] Paging keeps `totalCount` stable and shows different rows.

**Teardown:** Clear the history cache; leave the test leads in place for other cases or delete them if the suite owns them.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A History tab beside the search form | Medium | One tab, not a page; it is the natural home for "what have I already pulled" and stops the search form growing a history panel |
| Leads list | A source filter so a fetch's leads can be isolated | Low | Reuses the existing click-to-filter strip pattern from the progress tracker |
| Dashboard | Nothing | None | Fetch counts stay in the activity trail |

**Verdict:** Fits an existing surface

Fetch history answers a question that only arises inside prospecting — "did I already buy this list?" — so it belongs next to the search form rather than in the main navigation. Reusing the existing click-to-filter pattern on Leads means the link from a fetch to its leads costs no new concepts.
