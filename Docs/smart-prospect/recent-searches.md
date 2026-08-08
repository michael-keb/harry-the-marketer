# Recent Searches API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/recent-searches` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/recent-searches |
| **Auth** | API key (query param `api_key`) |

Lists the prospect searches you ran most recently, with the filters each one used.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner who tried four variations of a search yesterday, **I want** to see and reopen my recent searches, **so that** I can get back to the one that looked right without rebuilding it filter by filter.

**Acceptance criteria**
- [ ] Given a valid API key, when I request recent searches, then I get 200 with `data.recentSearches` as an array and `data.totalCount` alongside it — the count sits at `data.totalCount`, not inside a `pagination` object.
- [ ] Given a recent search row, when it renders, then it carries `id`, `search_string` (for example "Director in United States"), `filter_details`, `created_at` and `updated_at`. Unlike the fetched-searches payload, there is **no** `fetch_details`, `is_saved` or `is_fetched` here — a recent search is a search that was run, and the docs give nothing about results or cost.
- [ ] Given `filter_details` (for example `{ "title": ["Director"], "country": ["United States"], "limit": 100 }`), when I open a row, then those filters are rendered as readable chips and can be loaded straight back into the search form.
- [ ] Given `search_string` is a human-readable summary supplied by the provider, when a row renders, then that string is the row title and Harry does not compose its own summary over the top of it.
- [ ] Given `limit` defaults to `"10"` and must match `^[1-9][0-9]*$`, and `offset` must match `^[0-9]+$`, when I page, then those patterns are enforced before the call.
- [ ] Given I have run nothing yet, when the list loads, then 200 with an empty `recentSearches` array and `totalCount: 0`, and the UI shows an empty state pointing at the search form rather than an error.
- [ ] Given a recent search is reopened, when it loads into the form, then it is a starting point the user can edit — reopening never re-runs a fetch or spends credits.
- [ ] Given a 401, when the list loads, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/search-filters/recent-searches?api_key=VALID` | 200, `data.recentSearches` array with `id`, `search_string`, `filter_details`, `created_at`, `updated_at`; `data.totalCount` present |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Only that account's searches return; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=0` | Fails the documented `^[1-9][0-9]*$` pattern; Harry clamps to at least 1 before calling |
| TC-5 | Rate limited | Poll the recent list every second | 429 on the excess; Harry refreshes on navigation and on explicit refresh only, with backoff |
| TC-6 | Empty result set | Call on an account that has run nothing | 200, `recentSearches: []`, `totalCount: 0`; "You have not run any prospect searches yet" with a link to the form |
| TC-7 | Count lives outside pagination | Inspect the 200 body | `totalCount` sits at `data.totalCount`; the client must not read `pagination.count` |
| TC-8 | No fetch data on this endpoint | Compare a row with a fetched-searches row | The recent row has no `fetch_details`; the UI must not display a lead count for it or imply the search was fetched |
| TC-9 | Reopen a search | Click a row and land in the search form | Every filter in `filter_details` is applied, the row's date is shown as provenance, and no fetch is triggered |
| TC-10 | Paging | GET `limit=10&offset=0` then `offset=10` | Distinct rows per page; `totalCount` stays constant and drives the pager |
| TC-11 | Unknown filter key | Serve a `filter_details` key Harry does not render | The unknown key is listed as raw text rather than dropped, so a reopened search is never quietly narrower than the original |
| TC-12 | Upstream 500 | Force a provider 500 | "Could not load recent searches just now"; the search form still works |

## 4. Frontend user story

**As a** goal owner, **I want** my last few prospect searches listed beside the search form, **so that** iterating on a search feels like editing rather than starting over.

**Scope**
- Leads → "Find prospects": a "Recent" list in the same panel as the History tab, showing `search_string` as the row title with a relative date beneath and the exact timestamp on hover.
- Clicking a row loads its `filter_details` into the form and shows a dismissible note: "Loaded from your search of 15 January". Nothing is fetched by the click.
- Rows show only what the payload contains — no lead counts, no cost, because this endpoint documents none. That restraint is deliberate and is the difference between this list and the fetch history beside it.
- Any `filter_details` key Harry does not have a control for is listed as raw text on the row, so reopening never silently drops a filter.
- State: paged with the documented `limit`/`offset`; skeleton rows while loading; an empty state pointing at the form; errors leave the form usable.
- Accessibility: a list of buttons rather than clickable divs, dates as text with a `title` for the exact value, the loaded-from note announced in a live region. Responsive: the panel moves below the form under 640px.

**Definition of done**
- [ ] Recent searches list with the provider's own `search_string` as the title.
- [ ] Clicking a row loads the filters and never triggers a fetch.
- [ ] Unrenderable filter keys are shown as raw text, not dropped.
- [ ] Paging follows the documented parameter patterns and is driven by `totalCount`.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied recent-searches route, **so that** the browser sees a normalised list and the provider key stays server-side.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/searches/recent?limit=&offset=` returning `{ items: [{ id, summary, filters, createdAt, updatedAt }], totalCount }`.
- The count is read from `data.totalCount`; a comment records that this endpoint does not use the `pagination` object seen on the filter lookups.
- Validation: `limit` at least 1 per `^[1-9][0-9]*$`, `offset` at least 0 per `^[0-9]+$`, both sent as strings.
- Filter translation: `filter_details` keys are mapped to Harry's own filter names where a mapping exists, and passed through untouched where it does not, so the UI can show unknown keys honestly.
- Data model: none. Recent searches live with the provider; Harry stores nothing of its own here, which is why this endpoint costs no migration.
- Rate limiting and retry: 429 and 5xx retried with bounded exponential backoff and jitter; short cache so switching tabs does not re-call.
- Logged: `telemetry` per upstream call with latency and status. No `events` row — listing recent searches is not an action worth auditing; reopening one is logged only if the user then saves or fetches.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] `totalCount` read from the documented location, covered by a test.
- [ ] Unknown `filter_details` keys survive translation and reach the client.
- [ ] Unconfigured provider returns the "not configured" payload and the Recent list hides.

## 6. End-to-end test ticket

**Title:** E2E — Reopen a recent prospect search and refine it

**Preconditions:** A stubbed provider serving the documented recent-searches payload with three rows, one of which carries a `filter_details` key Harry has no control for.

**Flow**
1. Open Leads → "Find prospects" and look at the Recent list.
2. Click the row whose filters Harry fully understands.
3. Change one filter and note that the loaded-from note stays visible.
4. Return to Recent and open the row with the unknown filter key.
5. Page to the second page of recent searches.

**Assertions**
- [ ] Each row's title is the provider's `search_string`, unchanged.
- [ ] No row shows a lead count or a cost, because the payload has none.
- [ ] Clicking a row applies every filter and fires no fetch request, verified against the stub's call log.
- [ ] The unknown filter key appears as raw text on the row and in the loaded-from note.
- [ ] The loaded-from note names the original search date and can be dismissed.
- [ ] Paging keeps `totalCount` stable and shows different rows.

**Teardown:** Discard the loaded search draft; clear the recent-searches cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Recent list sharing the panel with fetch History | Low | Two tabs in one panel rather than two panels; Recent is the default because it is the cheaper, more common need |
| Leads → Find prospects form | A dismissible "loaded from" note | Low | One line, dismissible, and it prevents the confusion of not knowing where the current filters came from |

**Verdict:** Fits an existing surface

Recent searches only make sense next to the form they refill, so they share the panel with fetch history rather than earning a page. The honest constraint here is what the payload does not contain: no counts, no cost, no results — so the UI shows none, and the fetch history beside it remains the place those questions are answered.
