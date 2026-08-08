# States API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/states` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/states |
| **Auth** | API key (query param `api_key`) |

Lists states or regions a prospect search can be limited to, optionally narrowed to one or more countries.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner targeting a region rather than a whole country, **I want** to pick states filtered by the countries I have already chosen, **so that** the location filters build on each other instead of offering me every region on earth.

**Acceptance criteria**
- [ ] Given a valid API key, when I request states, then I get 200 with `data` as an array of `{ id, state_name }` plus a `pagination` object carrying `limit`, `offset`, `page` and `count`.
- [ ] Given `country` accepts comma-separated country names (for example `india,usa,canada`), when countries are already selected in the form, then those names are passed so the state list is narrowed to them.
- [ ] Given the state lookup's `country` filter has **no** dependency of its own — unlike the city lookup, where `country` requires `state` — when no country is selected, then the state list still loads unfiltered, and the UI does not block it.
- [ ] Given `country` takes names rather than ids, when countries are chosen from the countries lookup (which returns `{ id, country_name }`), then the **names** are what get passed here; the mismatch is written down in the code because passing ids would silently return nothing.
- [ ] Given the default `limit` is `"10"` within a 1–100 range, when the state picker opens, then Harry requests 100 and pages until the list for the selected countries is exhausted.
- [ ] Given `search` matches state names *starting with* the supplied text, when I type "cal", then California is returned and states merely containing "cal" are not, and the helper text says so.
- [ ] Given selected countries change, when the state list reloads, then any selected state no longer available under the new countries is flagged rather than silently dropped.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No states match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/states?api_key=VALID` | 200, `data` array of `{ id, state_name }`; `pagination.limit` 10, `page` 1 |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `offset=-1` | Fails the documented `^[0-9]+$` pattern; Harry floors it at 0 before calling |
| TC-5 | Rate limited | Type a state name with no debounce | 429 on the excess; debounce to one call per 300ms with backoff and jitter |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No states match that" |
| TC-7 | Country narrowing | GET `country=usa,canada` | Only states in those countries return; one parameter, comma-separated names |
| TC-8 | Names not ids | GET `country=1` using a country id | Returns nothing useful; a test asserts Harry always sends country **names** taken from the countries lookup's `country_name` field |
| TC-9 | No dependency | GET `country=usa` with no state selected anywhere | Succeeds — unlike the city lookup, this endpoint's `country` filter stands alone |
| TC-10 | Prefix matching only | GET `search=cal` then `search=ifornia` | The first returns California, the second does not |
| TC-11 | Selection invalidated by a country change | Select a state, then remove its country | The state chip is flagged "not in your selected countries" rather than disappearing, with a one-click removal |
| TC-12 | Paging | GET `limit=100&offset=0` then `offset=100` | Distinct states per page; `pagination.page` increments |
| TC-13 | Upstream 500 | Force a provider 500 | "Could not load states just now"; chips kept, other filters usable |

## 4. Frontend user story

**As a** goal owner, **I want** the state picker to follow the countries I chose, **so that** the location filters read top-down and I never scroll past regions I do not care about.

**Scope**
- Leads → "Find prospects": a multi-select "States or regions" field in the location group, between Countries and Cities, reflecting the natural narrowing order.
- When countries are selected, the state lookup is called with those country names and the field's placeholder says which countries it is narrowed to; with none selected, the field loads unfiltered and says so.
- Changing countries re-runs the state lookup and flags any now-invalid state chip rather than removing it, so a user always sees what changed.
- Because the city lookup requires a state, the location group shows a short hint on the city field explaining that a state is needed there — a rule that belongs to cities, not states, and must not be applied here by mistake.
- State: debounced typeahead, chips for selections, first-open fetch at `limit=100` with paging until exhausted.
- Empty state "No states match that". Error state keeps chips.
- Accessibility: combobox semantics, keyboard-removable chips, invalidated chips labelled in text, the narrowing note in a live region. Responsive: full-width sheet under 640px.

**Definition of done**
- [ ] The state field narrows to the selected countries by name, with the narrowing visible.
- [ ] Changing countries flags invalid state chips rather than dropping them.
- [ ] The state field never enforces the city field's country-requires-state rule.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied state lookup that translates selected country ids into names, **so that** the two location lookups' mismatched vocabularies are reconciled in one place.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/states?search=&countryIds=&limit=&offset=`, resolving country ids to `country_name` values from the cached countries list and passing them as a comma-separated `country` value.
- Validation: `limit` clamped to 1–100 with a first-load value of 100, `offset` floored at 0, `search` and the assembled `country` string each capped at 255 characters — the documented limit for both, which matters because a long comma-separated country list can exceed it. When it would, the route splits the request per country and merges the results.
- Cache: keyed by `(countryIds, search)` for hours, since state lists change rarely.
- Invalidated-selection detection: when a draft's selected state ids are absent from the current list, the route marks them stale so the UI can flag them.
- Data model: none of its own; prospect search drafts persist state **ids** with cached labels.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call with latency, status, cache hit/miss and whether the request had to be split for length.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] Country ids are resolved to names before the call, covered by a test.
- [ ] A country list exceeding 255 characters is split and merged correctly, covered by a test.
- [ ] Stale state selections are flagged rather than dropped.

## 6. End-to-end test ticket

**Title:** E2E — Narrow a prospect search to states within chosen countries

**Preconditions:** A stubbed provider serving the documented states and countries payloads, with a country whose states are known, and a search draft holding one state selection.

**Flow**
1. Open Leads → "Find prospects" and expand the location group.
2. Select two countries.
3. Open the States field and observe the narrowing note.
4. Select two states and type three letters to filter.
5. Remove one of the countries.
6. Select twenty countries to force a long country string.

**Assertions**
- [ ] The outgoing state request carries country **names**, comma-separated, not ids.
- [ ] The States field shows which countries it is narrowed to.
- [ ] Typing three letters returns only states starting with them.
- [ ] Removing a country flags the affected state chip as "not in your selected countries" and offers one-click removal.
- [ ] With twenty countries the request is split and the merged list contains states from all of them, with no duplicates.
- [ ] The Cities field, not the States field, is the one showing the "choose a state first" hint.

**Teardown:** Discard the search draft; clear the state cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A States field in the middle of the location group | Low | It sits between Countries and Cities so the group reads top-down; it is hidden until the location group is opened |
| Goals → goal detail | Same field in "Refine the audience" | Low | Reuses the Leads component |

**Verdict:** Fits an existing surface

States are the middle rung of a three-rung location filter, so the only design decision is ordering the three so that narrowing feels natural. Flagging rather than dropping a state when its country is removed is the small honesty that prevents a search quietly changing meaning behind the user's back.
