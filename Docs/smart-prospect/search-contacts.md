# Search Contacts API

| | |
|---|---|
| **Endpoint** | `POST https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-contacts` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/search-contacts |
| **Auth** | API key (query param `api_key`) |

Searches the prospect database with a set of filters and returns a preview page of matching people, how many there are in total, and a filter id you can use to fetch them.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to preview who matches my ideal customer profile before paying for anything, **so that** I can adjust the filters until the sample looks like the people I actually want to write to.

**Acceptance criteria**
- [ ] Given a search, when the request is built, then `limit` is required and between 1 and 500; every other field is optional and every array field accepts at most 2000 items.
- [ ] Given the documented filters, when Harry's form is translated, then it maps onto `name`, `firstName`, `lastName`, `title`, `includeTitle`, `excludeTitle`, `includeCompany`, `excludeCompany`, `includeCompanyDomain`, `excludeCompanyDomain`, `department`, `level`, `companyName`, `companyDomain`, `companyKeyword`, `companyHeadCount`, `companyRevenue`, `companyIndustry`, `companySubIndustry`, `city`, `state`, `country`, plus `dontDisplayOwnedContact`, `titleExactMatch`, `companyExactMatch` and `companyDomainExactMatch`.
- [ ] Given a successful response, when it is read, then `data.list` holds contacts with `id`, `firstName`, `lastName`, `fullName`, `title`, `company: { name, website }`, `department` (an **array**), `level`, `industry`, `subIndustry`, `companyHeadCount`, `companyRevenue`, `country`, `state`, `city`, `email`, `linkedin`, `emailDeliverability` (a number such as `0.95`) and `address`.
- [ ] Given `department` is an array while `level`, `industry` and the rest are plain strings, when the row renders, then the code handles that asymmetry explicitly rather than assuming a uniform shape.
- [ ] Given `data.total_count` can be enormous (the documented example is 16,064,669), when it renders, then it is shown as an approximate scale ("about 16 million matches") with a clear message that the filters are far too broad, rather than as a precise figure that invites a fetch.
- [ ] Given `data.scroll_id`, when the next page is requested, then that value is sent back as `scroll_id` — this is cursor paging, not offset paging, so a page cannot be jumped to and the UI offers "next" rather than page numbers.
- [ ] Given `data.filter_id` is returned by the search, when the user then fetches, saves or reviews, then that `filter_id` is the handle those endpoints require — the search is what creates it.
- [ ] Given `email` values appear in the preview, when the preview renders, then Harry must not present them as usable addresses; the fetch step is what produces real, paid-for contacts, and the preview says so.
- [ ] Given `emailDeliverability` is a number between 0 and 1, when it renders, then it is shown as a plain-English confidence rather than a raw decimal.
- [ ] Given a 401, when the request runs, then the documented body carries `"error": "API key is required"` — different wording from other endpoints in this category — and Harry's error parser must not match on the message text.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, minimum body | POST `{"limit": 10}` | 200, `data.list` with 10 contacts, `data.scroll_id`, `data.filter_id` and `data.total_count` present |
| TC-2 | Missing/invalid API key | Same body with no `api_key` | 401 with `"error": "API key is required"`; parsed by status code, not message text; one connection banner |
| TC-3 | Not found / wrong workspace | Reuse a `filter_id` from another account on a later fetch | That fetch fails; Harry scopes every `filter_id` it stores to the workspace that created it |
| TC-4 | Validation failure — no limit | POST `{"title": ["Director"]}` with no `limit` | 400; Harry blocks it first, since `limit` is documented as required |
| TC-5 | Rate limited | Re-run the search on every filter change with no debounce | 429 on the excess; Harry debounces the preview and backs off with jitter, keeping the last good results on screen |
| TC-6 | Empty result set | Search a filter combination matching nobody | 200 with `data.list: []` and `total_count: 0`; "No one matches these filters" with a suggestion to relax the narrowest one |
| TC-7 | Enormous total count | Search with no filters at all | `total_count` in the millions; the UI reads "about 16 million matches — add filters before fetching" and the fetch action is discouraged with an explanatory note |
| TC-8 | Cursor paging | Take `scroll_id` from page one and send it for page two | Different contacts; no page numbers offered, only "next", because offset paging is not supported |
| TC-9 | Stale scroll id | Send a `scroll_id` from a search run with different filters | Treated as invalid; Harry re-runs the search from the start rather than showing mixed results |
| TC-10 | Limit ceiling | POST `limit: 501` | Rejected against the documented 1–500 range before the upstream call |
| TC-11 | Array ceiling | POST `companyDomain` with 2001 entries | Rejected with a message naming the documented 2000-item maximum, and the paste flow warns before it reaches that size |
| TC-12 | Department is an array | Render a contact whose `department` is `["Sales"]` | The row joins the array for display; a contact with several departments renders all of them |
| TC-13 | Exact-match toggles | Search with `titleExactMatch: true` versus false | The result counts differ and the summary states that exact title matching is on |
| TC-14 | Preview emails are not usable | Inspect a preview row | The email column is masked or labelled as a preview, and the UI states that fetching is what produces real addresses |
| TC-15 | Upstream 500 | Force a provider 500 | The last good preview stays on screen with its timestamp and a retry is offered |

## 4. Frontend user story

**As a** goal owner, **I want** a live preview of who matches my filters, with a count and a sample, **so that** I can tune the audience before spending a credit.

**Scope**
- Leads → "Find prospects": the search form on the left, a results preview on the right showing the total count first, then a sample table of the returned contacts with name, title, company, location, seniority and a plain-English deliverability confidence.
- The count is the headline and is scaled honestly: exact under a threshold, "about 16 million" above it, with a note that a very broad audience should be narrowed before fetching.
- Paging is "Show more" using `scroll_id`, never numbered pages, because the API is cursor-based.
- The preview's email column is explicitly marked as not a usable address; the "Get email addresses" action beside the count is the step that produces real contacts and carries the credits confirmation described in the fetch-contacts story.
- The `filter_id` returned by the search is held for the session and used by save, fetch and review, so a user never sees it.
- Goals → goal detail, "Refine the audience": the same preview embedded beneath the ICP, so the effect of an ICP change on real matches is visible immediately.
- State: debounced re-search on filter change with the previous results kept visible and dimmed while loading; empty state naming the likely culprit filter; error keeps the last good preview with its timestamp.
- Accessibility: a real table with header scopes, the count in a live region so it is announced when filters change, deliverability as words rather than a bar alone. Responsive: the preview moves below the form under 900px and becomes stacked cards under 640px.

**Definition of done**
- [ ] The preview shows the count and a sample and re-runs on filter change, debounced.
- [ ] Very large counts are shown as an approximate scale with a narrowing prompt.
- [ ] Paging uses `scroll_id` and offers only "Show more".
- [ ] Preview emails are visibly not presented as usable addresses.
- [ ] `department` arrays and every other documented field render correctly.
- [ ] Loading, empty, too-broad, error and stale-cursor states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a search route that translates Harry's filter model, enforces every documented ceiling, and manages the cursor, **so that** the browser holds no provider concepts and no oversized request ever leaves the server.

**Scope**
- Route in `server/routes.js`: `POST /api/prospects/search` taking Harry's normalised filter object plus `limit` and an optional `cursor`, translating to the documented body and returning `{ items, cursor, filterId, totalCount }`.
- Translation is one explicit mapping table covering every documented field, with a test asserting no undocumented key is ever sent. Booleans pass through; every criteria value is coerced to an array.
- Enforcement before the upstream call: `limit` 1–500, each array at most 2000 items, with a 422 naming the field and the ceiling. The paste-domains flow warns well before 2000 so a user never hits this blind.
- Cursor handling: `scroll_id` is returned to the client as an opaque `cursor` tied to a filter fingerprint. A cursor presented against different filters is rejected server-side and the search restarts, so mixed pages are impossible.
- `filter_id` is stored on the session's search draft and, when the user saves, written to the `prospect_searches` row as `provider_filter_id`, giving fetch, review and analytics the handle they need.
- Error parsing: this endpoint's 401 says `"API key is required"` rather than `"User not authenticated"`, so the shared parser keys on status code and never on message text — with a test.
- Data model: no new table; `prospect_searches` from the save work carries the filter id.
- Rate limiting and retry: previews are debounced server-side per session; 429 and 5xx retried with bounded exponential backoff and jitter; results cached briefly per filter fingerprint so a back-and-forth edit does not re-call.
- Logged: `telemetry` per search with latency, status, total count and which filters were set (names, not values) so Monitoring can show which filters correlate with a workable audience size. An `events` row only when a search is saved or fetched, not on every preview.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] The mapping table covers every documented field and sends nothing else, covered by a test.
- [ ] `limit` and the 2000-item array ceiling are enforced with 422s naming the field.
- [ ] A cursor used against changed filters restarts the search rather than mixing pages, covered by a test.
- [ ] The 401 is parsed by status code, proven by a test using this endpoint's distinct message.
- [ ] `filter_id` flows through to save, fetch and review without the client ever seeing it.

## 6. End-to-end test ticket

**Title:** E2E — Preview a prospect audience and tune it before spending credits

**Preconditions:** A stubbed provider serving the documented search-contacts payload, with modes for a huge `total_count`, an empty result, a stale `scroll_id`, and a 500. One goal with a built ICP.

**Flow**
1. Open the goal and expand "Refine the audience"; read the embedded preview.
2. Remove all filters and observe the count.
3. Add a country, an industry and a seniority level; watch the count fall.
4. Turn on exact title matching and observe the count change again.
5. Click "Show more" twice.
6. Change a filter, then attempt to page with the previous cursor.
7. Narrow to a filter set matching nobody.
8. Switch the stub to 500.

**Assertions**
- [ ] With no filters the count reads as an approximate scale with a narrowing prompt, and the fetch action carries a warning.
- [ ] Each added filter lowers the count and the count is announced to screen readers.
- [ ] Exact title matching visibly changes the result and is named in the summary.
- [ ] "Show more" appends contacts using the cursor; no page numbers are offered.
- [ ] After a filter change, the old cursor is refused and the search restarts from page one with no mixed rows.
- [ ] The empty state names a likely culprit filter rather than saying only "no results".
- [ ] Preview email values are visibly marked as not usable addresses.
- [ ] With the stub at 500 the last good preview stays visible with its timestamp.

**Teardown:** Discard the search draft; clear the preview cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | The core two-pane search and preview | High | This is the one genuinely new surface in the category, and every other endpoint here feeds it rather than adding its own; the form's groups stay collapsed until opened, and the count is the only thing always visible |
| Goals → goal detail | The same preview embedded under the ICP | Medium | Read-only and collapsed by default; it exists so an ICP change shows its consequence immediately |
| Leads list | Nothing until contacts are fetched | None | Leads still arrive through the existing import path |
| Monitoring | Search latency and audience-size telemetry | Low | Rows in an existing table |

**Verdict:** New surface needed

Every other endpoint in this category is a filter, a list or a receipt for this one — search is where a user actually describes an audience and sees who is in it, and there is nowhere in Harry today that does that. It sits inside Leads as "Find prospects" rather than as a top-level navigation item, because finding people and managing people are the same job. Keeping the preview embedded in the goal page too is what stops prospecting drifting away from the plain-English outcome that started it.
