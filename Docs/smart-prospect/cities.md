# Cities API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/cities` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/cities |
| **Auth** | API key (query param `api_key`) |

Lists city names you can filter a prospect search by, optionally narrowed to a state or country and matched against what the user has typed so far.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner building a prospect search, **I want** to pick cities from a list that responds as I type, **so that** I target the towns my ideal customer profile names without guessing at spellings.

**Acceptance criteria**
- [ ] Given a valid API key, when I request cities with no other parameters, then I get 200 with `success: true`, a `data` array of `{ id, city_name }` objects, and a `pagination` object carrying `limit`, `offset`, `page` and `count`.
- [ ] Given I have typed at least one character, when that text is sent as `search`, then only cities whose name *starts with* that value are returned and `search` is echoed back in the response instead of `null`.
- [ ] Given I pass `state=california,texas`, when the request runs, then only cities inside those states are returned; comma-separated values are accepted in one parameter.
- [ ] Given I pass `country` without `state`, when the request runs, then the request is rejected with a field-level message, because the documented rule is that `country` requires `state`.
- [ ] Given I ask for `limit=250`, when the request runs, then it is rejected — the documented range is 1–100 (default `"10"`) and `offset` must be zero or greater.
- [ ] Given a `search` value that matches nothing, when the request runs, then I get 200 with an empty `data` array and `count: 0`, and the picker shows "No cities match that" rather than an error.
- [ ] Given the API key is missing or wrong, when the request runs, then the upstream returns 401 with `{"statusCode": 401, "success": false, "message": "Unauthorized"}` and Harry shows a single "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, defaults | GET `/cities?api_key=VALID` | 200, `data` is an array of `{ id, city_name }`; `pagination.limit` is 10, `pagination.offset` 0, `pagination.page` 1 |
| TC-2 | Missing/invalid API key | GET `/cities` with no `api_key` | 401, `{"error": "User not authenticated"}`; Harry surfaces "Prospect search is not connected — add a key in Settings" |
| TC-3 | Not found / wrong workspace | Call with a key belonging to a different account, then look for a city previously seen in this workspace | Results are scoped to the authenticated account; nothing from another workspace appears |
| TC-4 | Validation failure — bad limit | GET `/cities?api_key=VALID&limit=0` | Rejected as outside the documented 1–100 range; Harry clamps to 100 before sending and logs the clamp |
| TC-5 | Rate limited | Fire the typeahead on every keystroke of a 12-character city name with no debounce | Excess requests 429; the client debounces to one request per 300ms, backs off with jitter, and the field never shows a stack of errors |
| TC-6 | Empty result set | GET `/cities?api_key=VALID&search=zzzzzz` | 200, `data: []`, `pagination.count: 0`; picker shows "No cities match that" |
| TC-7 | Prefix-only matching | GET `/cities?api_key=VALID&search=aus` then `search=ustin` | The first returns Austin; the second does not — matching is documented as starts-with, so the UI must not promise "contains" |
| TC-8 | State filter with several values | GET `/cities?api_key=VALID&state=california,texas` | Only cities in those two states; one parameter, comma-separated |
| TC-9 | Country without state | GET `/cities?api_key=VALID&country=usa` | Rejected; Harry disables the country filter in the city picker until at least one state is chosen and says why |
| TC-10 | Pagination walk | GET with `limit=100&offset=0`, then `offset=100` | Page 2 returns different cities; `pagination.page` increments and no city appears on both pages |
| TC-11 | Upstream failure | Force a 500 from the provider | Harry keeps any cities already chosen, shows "Could not load cities just now — try again", and the rest of the search form stays usable |

## 4. Frontend user story

**As a** goal owner, **I want** a city filter in Harry's prospect search that suggests real city names as I type, **so that** my search matches the provider's data instead of my typos.

**Scope**
- Leads → "Find prospects" panel: a multi-select city field with typeahead, sitting under the existing location group alongside country and state.
- Goals → goal detail: the same field appears inside "Refine the audience" when a goal's ICP mentions places, pre-filled from the ICP text where a place name is recognised.
- State: debounced typeahead (one request per 300ms of quiet), a spinner inside the field only, chosen cities rendered as removable chips above the input, and an "load more" affordance that advances `offset` by `limit` rather than an infinite scroll.
- Empty state inside the dropdown reads "No cities match that". Error state keeps the chips already chosen and offers "Try again"; it never clears the user's selection.
- The country sub-filter is disabled with an explanatory hint until a state is selected, mirroring the API's documented dependency, so the user is never told "no results" when the real problem is a missing state.
- Accessibility: a combobox with `aria-expanded`, `aria-activedescendant`, arrow-key navigation and Escape to close; chips are removable by keyboard and announce removal. Responsive: the dropdown becomes a full-width sheet under 640px.

**Definition of done**
- [ ] Typing in the city field returns suggestions from the live endpoint, debounced, with in-flight requests cancelled on the next keystroke.
- [ ] Selected cities persist through a page reload of the prospect search draft.
- [ ] Empty, loading, error and rate-limited states each have a designed appearance, verified in light and dark.
- [ ] The state/country dependency is enforced in the UI, not just reported by the server.

## 5. Backend user story

**As a** Harry API, **I want** a proxied city lookup route, **so that** the browser never holds the prospect-data provider's key and the filter list can be cached.

**Scope**
- Route in `server/routes.js` following the workspace-scoped pattern: `GET /api/prospects/filters/cities?search=&state=&country=&limit=&offset=`, returning `{ items: [{ id, name }], pagination }` so the web app is not coupled to the provider's field names (`city_name`).
- Provider credentials are env-gated exactly as `server/google.js` gates Google OAuth: no key configured means the route returns a documented "not configured" payload and the UI hides the panel instead of erroring.
- Validation before the upstream call: clamp `limit` to 1–100, floor `offset` at 0, reject `country` supplied without `state` with a 422 naming the field, cap `search` at 255 characters.
- Cache: city lists change rarely, so responses are cached in-process per `(search, state, country, limit, offset)` for a short TTL, which also blunts typeahead traffic.
- Rate limiting and retry: on 429 or 5xx, retry twice with exponential backoff and jitter, then return a soft failure the UI can present without losing form state.
- Data model: none. This endpoint is a lookup, not a record — nothing is written to `leads`.
- Logged: a `telemetry` row per upstream call with latency, status and cache hit/miss so Monitoring can show prospect-provider health beside the AI call log. No `events` row — a filter lookup is not user activity.

**Definition of done**
- [ ] Route added, workspace-scoped, with the provider key read only on the server.
- [ ] Parameter clamping and the state/country dependency are covered by tests.
- [ ] Cache hit/miss and upstream latency appear in `telemetry`.
- [ ] With no provider key configured, the route returns the "not configured" shape and no test fails.

## 6. End-to-end test ticket

**Title:** E2E — Filter a prospect search by city

**Preconditions:** A workspace with a prospect-data provider key configured against a stubbed provider that serves the documented city payload, one goal with an ICP naming a country, and an empty Leads list.

**Flow**
1. Open Leads and click "Find prospects".
2. In the location group, choose a state.
3. Type three letters into the city field.
4. Pick two suggested cities from the dropdown.
5. Clear the state selection.
6. Reload the page.

**Assertions**
- [ ] The dropdown lists cities from the stub within one debounce interval, and only one request was made for the three keystrokes.
- [ ] Both chosen cities appear as chips above the field.
- [ ] Before a state is chosen, the country sub-filter is visibly disabled with a hint explaining why.
- [ ] After reload, the two city chips are still selected in the draft search.
- [ ] Stopping the stub mid-typing shows "Could not load cities just now" while leaving both chips intact.

**Teardown:** Discard the draft search; clear the lookup cache; remove the stub provider key.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | One more field in the existing location group | Low | It sits with country and state, not on its own row; collapsed by default until the location group is opened |
| Goals → goal detail | Same field reused inside "Refine the audience" | Low | Same component, no second implementation |
| Settings | A prospect-provider key field | Low | Joins the existing list of env-gated integrations, same pattern as Gmail |
| Monitoring | Prospect-provider latency in the existing component checks | Low | One more row in a table that already exists |

**Verdict:** Fits an existing surface

A city picker is a filter control, not a destination — it belongs inside the prospect search panel on Leads, next to the filters it works with. No navigation item is added, and a user who never searches by place never opens the location group.
