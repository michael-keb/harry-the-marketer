# Saved Searches API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/saved-searches` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/saved-searches |
| **Auth** | API key (query param `api_key`) |

Lists the prospect searches you have saved, with the filters each one holds.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner running outreach every month, **I want** my saved audiences listed with their filters, **so that** I can top up a campaign's leads from the same definition instead of describing the audience again.

**Acceptance criteria**
- [ ] Given a valid API key, when I request saved searches, then I get 200 with `data.savedSearches` as an array and `data.totalCount` alongside — the count sits at `data.totalCount`, not inside a `pagination` object.
- [ ] Given a saved search row, when it renders, then it carries `id`, `search_string`, `filter_details`, `created_at` and `updated_at`. The payload shape is identical to recent searches; the difference is that these rows persist because a user chose to keep them.
- [ ] Given `id` is present here and absent from the save response, when a search is saved, then this endpoint is the only documented way to learn the new search's id — so it is the resolution step every id-dependent action depends on.
- [ ] Given `filter_details` (for example `{ "title": ["Director"], "country": ["United States"], "limit": 100 }`), when a row is opened, then the filters are shown as readable chips and load back into the search form unchanged.
- [ ] Given `limit` defaults to `"10"` and must match `^[1-9][0-9]*$`, and `offset` must match `^[0-9]+$`, when I page, then those patterns are enforced before the call.
- [ ] Given a saved search is linked to a Harry goal, when the list renders, then the linked goal is named on the row, so a user can see which audience belongs to which outcome.
- [ ] Given I have saved nothing, when the list loads, then 200 with an empty `savedSearches` array and `totalCount: 0`, and the UI shows an empty state that points at the search form.
- [ ] Given a 401, when the list loads, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/search-filters/saved-searches?api_key=VALID` | 200, `data.savedSearches` with `id`, `search_string`, `filter_details`, `created_at`, `updated_at`; `data.totalCount` present |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Only that account's saved searches return; Harry's local records are workspace-scoped |
| TC-4 | Validation failure | GET `limit=0` | Fails the documented `^[1-9][0-9]*$` pattern; Harry clamps to at least 1 before calling |
| TC-5 | Rate limited | Poll the list every second | 429 on the excess; Harry refreshes on navigation, after a save, and on explicit refresh only |
| TC-6 | Empty result set | Call on an account with nothing saved | 200, `savedSearches: []`, `totalCount: 0`; "You have not saved any audiences yet" with a link to the form |
| TC-7 | Count lives outside pagination | Inspect the 200 body | `totalCount` sits at `data.totalCount`; the client must not read `pagination.count` |
| TC-8 | Id resolution after a save | Save a search, then list | The new row appears with its `id`; Harry writes it to the local `provider_filter_id` and enables id-dependent actions |
| TC-9 | Paging | GET `limit=10&offset=0` then `offset=10` | Distinct rows per page; `totalCount` stays constant and drives the pager |
| TC-10 | Orphaned local record | Delete a search at the provider, then list | The local row is marked "no longer at the provider" rather than silently vanishing, and offers to be removed |
| TC-11 | Unknown filter key | Serve a `filter_details` key Harry cannot render | Shown as raw text on the row, so loading it never quietly drops a filter |
| TC-12 | Upstream 500 | Force a provider 500 | "Could not load your saved audiences just now"; locally known searches still render, clearly marked as possibly stale |

## 4. Frontend user story

**As a** goal owner, **I want** a list of saved audiences that shows which goal each one serves, **so that** choosing where to get more leads from takes one glance.

**Scope**
- Leads → "Find prospects": a "Saved" tab in the same panel as Recent and History, listing saved searches newest first with `search_string` as the title, the linked goal beneath it, and relative dates with exact values on hover.
- Row actions: "Load into the form", "Fetch contacts" (which needs the id and is disabled until it resolves), and "Rename or edit".
- Expanding a row shows `filter_details` as readable chips, including any key Harry cannot render, shown as raw text.
- Goals → goal detail: the linked saved search is named in "Refine the audience" with a link into this list, so the relationship is visible from both directions.
- State: paged with the documented `limit`/`offset`; skeleton rows while loading; empty state pointing at the form; on error, locally known searches still render marked as possibly stale.
- Orphaned rows — local records whose provider search has gone — are shown with an explanation and a remove action rather than disappearing.
- Accessibility: rows are a list with expandable disclosure buttons, dates as text with exact values in a `title`, disabled actions carrying an accessible reason. Responsive: the panel moves below the form under 640px.

**Definition of done**
- [ ] Saved searches list with names, linked goals and dates.
- [ ] Expanding shows every filter, including unrenderable keys as raw text.
- [ ] Id-dependent actions are disabled with a stated reason until the id resolves.
- [ ] Orphaned local records are explained, never silently dropped.
- [ ] Loading, empty, stale and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a saved-searches route that reconciles provider rows with Harry's own records, **so that** a saved audience and the goal it serves stay one linked thing.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/searches?limit=&offset=` returning `{ items: [{ id, providerFilterId, name, filters, goalId, goalName, createdAt, updatedAt, orphaned }], totalCount }`.
- Reconciliation joins provider rows against the `prospect_searches` table introduced by the save work, on `provider_filter_id`. Provider rows with no local record render as unlinked; local rows with no provider row are marked `orphaned: true`.
- This route is also the id-resolution step used immediately after a save, since the save response returns no id; that dual role is written down in the route comment.
- Validation: `limit` at least 1 per `^[1-9][0-9]*$`, `offset` at least 0 per `^[0-9]+$`, both sent as strings.
- The count is read from `data.totalCount`, with a comment noting this endpoint does not use the `pagination` object seen on the filter lookups.
- Filter translation maps provider keys to Harry's filter names where a mapping exists and passes unknown keys through untouched.
- Rate limiting and retry: 429 and 5xx retried with bounded exponential backoff and jitter; a short cache that is invalidated by any save, rename or delete so the list is never stale immediately after a user's own action.
- Logged: `telemetry` per upstream call with latency and status, plus a flag when orphaned local records are found. No `events` row for reading the list.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] Provider and local records reconcile in both directions, with orphans flagged, covered by tests.
- [ ] The cache is invalidated by the user's own mutations so a save is visible immediately.
- [ ] Unknown filter keys survive translation and reach the client.

## 6. End-to-end test ticket

**Title:** E2E — Reuse a saved audience to top up a campaign's leads

**Preconditions:** A stubbed provider implementing saved-searches listing with three rows, two of which have local records linked to goals, one local record whose provider row has been deleted, and one goal with a live campaign.

**Flow**
1. Open Leads → "Find prospects" → Saved.
2. Read the rows, their linked goals and their dates.
3. Expand the row carrying an unrenderable filter key.
4. Load a saved search into the form and confirm every filter arrives.
5. Return to the list and inspect the orphaned record.
6. Open the linked goal and follow the link back to the saved search.

**Assertions**
- [ ] Each linked row names its goal; the unlinked provider row renders without inventing one.
- [ ] The unrenderable filter key appears as raw text and survives being loaded into the form.
- [ ] Loading a saved search fires no fetch and spends no credits.
- [ ] The orphaned record is explained and offers removal rather than disappearing.
- [ ] The goal names its saved search, and the link returns to the correct row.
- [ ] With the stub stopped, locally known searches still render, marked as possibly stale.

**Teardown:** Remove the orphaned local record; clear the saved-search cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Saved tab sharing the panel with Recent and History | Medium | Three tabs in one panel rather than three surfaces; Saved is where a returning user starts, so it earns the space Recent and History share |
| Goals → goal detail | The linked saved search named in "Refine the audience" | Low | One line with a link, which is what makes the ICP-to-audience relationship visible |
| Leads list | Nothing | None | Leads still arrive through the existing import path |

**Verdict:** Fits an existing surface

Saved audiences are the durable half of prospecting, so they live in the same panel as the searches that produced them, one tab away. Naming the linked goal on each row is the detail that keeps this from becoming a second, disconnected list of things to maintain.
