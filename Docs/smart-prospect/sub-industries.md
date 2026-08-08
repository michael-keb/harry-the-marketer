# Sub-Industries API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/sub-industries` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/sub-industries |
| **Auth** | API key (query param `api_key`) |

Lists sub-industries a prospect search can be limited to, optionally just those belonging to one industry.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner who sells to one slice of a sector, **I want** to filter by sub-industry directly, **so that** "E-Learning" is something I can search for without first knowing which parent industry it sits under.

**Acceptance criteria**
- [ ] Given a valid API key, when I request sub-industries, then I get 200 with `data` as an array of `{ id, sub_industry_name, industry_id }` plus a `pagination` object with `limit`, `offset`, `page` and `count`, and the echoed `search` and `industry_id` values.
- [ ] Given this endpoint returns an `id` for each sub-industry, when a sub-industry is selected here, then that id can be stored — unlike the nested `sub_industry_list` returned by the industries lookup, which carries only `sub_industry_name`. Both shapes exist and the code must handle each explicitly.
- [ ] Given `industry_id` is an optional filter (a positive integer string), when a parent industry is already selected in the form, then it is passed so the sub-industry list is narrowed accordingly.
- [ ] Given `industry_id` is omitted, when the request runs, then the full flat list is returned and the response echoes `industry_id: null` — this is what makes searching for a sub-industry without knowing its parent possible.
- [ ] Given each row carries `industry_id`, when a sub-industry is chosen from the flat list, then Harry can show and, if the user wants, auto-select its parent industry, so the two filters never silently contradict each other.
- [ ] Given the default `limit` is `"10"` within a 1–100 range, when the picker opens, then Harry requests 100 and pages until exhausted.
- [ ] Given `search` matches sub-industry names *starting with* the supplied text, when I type "e-le", then E-Learning is returned; the helper text says matching is on the start of the name.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No sub-industries match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/sub-industries?api_key=VALID` | 200, `data` array of `{ id, sub_industry_name, industry_id }`; `pagination.page` 1; `industry_id` echoed as `null` |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `industry_id=abc` | Rejected; the parameter is documented as a positive integer string and Harry validates before calling |
| TC-5 | Rate limited | Type a sub-industry name with no debounce | 429 on the excess; the flat list is cached so typing filters locally and makes no request |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No sub-industries match that" |
| TC-7 | Narrowed by industry | GET `industry_id=1` | Only that industry's sub-industries return, and the response echoes `industry_id: 1` |
| TC-8 | Ids exist here, not in the industries payload | Compare a row here with a `sub_industry_list` entry from the industries lookup | This payload has `id` and `industry_id`; the nested one has only `sub_industry_name`. A test asserts each code path uses the right key |
| TC-9 | Parent inference | Select a sub-industry from the flat list | Its `industry_id` is used to show the parent industry, and the user is offered the choice to select the parent too |
| TC-10 | Contradiction guard | Select a sub-industry whose `industry_id` is not among the selected industries | Harry warns that the two filters may not agree and offers to add the parent |
| TC-11 | Paging | GET `limit=100&offset=0` then `offset=100` | Distinct sub-industries per page; `pagination.page` increments |
| TC-12 | Upstream 500 | Force a provider 500 | "Could not load sub-industries just now"; selections kept |

## 4. Frontend user story

**As a** goal owner, **I want** to search sub-industries directly as well as through their parent industry, **so that** I can start from the words my market actually uses.

**Scope**
- Leads → "Find prospects": inside the Industries group, a "Search all sub-industries" field beneath the industry tree. Typing there searches the flat sub-industry list, so a user who knows "E-Learning" but not "Education" is not stuck.
- Selecting from the flat field ticks the corresponding leaf in the tree by matching `industry_id`, so the two controls are one state rather than two.
- If a chosen sub-industry's parent is not selected, an inline note offers to add it, explaining plainly that the filters may otherwise disagree.
- When a parent industry is already selected, the flat field narrows to it via `industry_id` and its placeholder says which industry it is searching within.
- State: the flat list is fetched once at `limit=100`, paged until exhausted and cached; typing filters locally; loading shows skeleton rows; error keeps selections.
- Accessibility: the flat field is a combobox whose results announce their parent industry as part of the option text; the add-parent note is a live region. Responsive: the field and the tree stack under 640px.

**Definition of done**
- [ ] Searching the flat list finds a sub-industry without knowing its parent.
- [ ] Selecting there updates the industry tree's checkbox state through `industry_id`.
- [ ] A sub-industry whose parent is unselected triggers a clear, dismissible offer to add the parent.
- [ ] When an industry is selected, the flat field narrows and says so.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a sub-industry lookup that returns ids and parents, **so that** the industry tree and the flat search stay one consistent selection rather than two lists that can disagree.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/sub-industries?search=&industryId=&limit=&offset=` returning `{ items: [{ id, name, industryId }], pagination }`, paging until exhausted when no `industryId` is supplied.
- Validation: `industryId` matched against a positive-integer pattern, `limit` clamped to 1–100 with a first-load value of 100, `offset` floored at 0, `search` capped at 255 characters.
- Cache: the flat list is cached for hours per workspace and reused for both the tree and the flat search, so the two views cannot diverge.
- Consistency check: when a draft selects a sub-industry whose `industryId` is not among the selected industries, the route returns a `parentMissing` marker so the UI can offer to add it.
- Data model: none of its own. Prospect search drafts persist sub-industry **ids** from this endpoint; where a selection originated from the industries lookup's nested list it has only a name, so the draft schema tolerates both and a comment explains why.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row when a parent industry is auto-added on the user's acceptance, so the change is auditable.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] One cached list serves both the tree and the flat search, proven by a test.
- [ ] `parentMissing` detection is covered by a test.
- [ ] Drafts holding both id-based and name-only sub-industry selections round-trip correctly.

## 6. End-to-end test ticket

**Title:** E2E — Find a sub-industry without knowing its parent industry

**Preconditions:** A stubbed provider serving the documented sub-industries and industries payloads across two pages, with E-Learning under Education.

**Flow**
1. Open Leads → "Find prospects" and expand the Industries group.
2. Type "e-le" into "Search all sub-industries" without selecting any industry.
3. Select E-Learning from the results.
4. Read the offer to add its parent and accept it.
5. Select a different industry and observe the flat field narrow.
6. Save the draft and reload.

**Assertions**
- [ ] E-Learning is found with no parent industry selected, and its option text names Education.
- [ ] Selecting it ticks the matching leaf inside the industry tree.
- [ ] The add-parent offer appears, explains why, and adding Education is recorded in the activity trail.
- [ ] After selecting a different industry, the flat field's placeholder names that industry and its results are limited to it.
- [ ] After reload the sub-industry selection persists by id and the tree state matches.
- [ ] With the stub stopped, the field shows "Could not load sub-industries just now" and keeps selections.

**Teardown:** Discard the search draft; clear the sub-industry cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A flat sub-industry search field beneath the industry tree | Medium | One field, inside a group that is already collapsed by default; it exists to spare users from browsing a tree to find a word they already know |
| Goals → goal detail | Same field in "Refine the audience" | Low | Reuses the Leads component |
| Dashboard activity trail | An entry when a parent industry is auto-added | Low | Existing trail |

**Verdict:** Fits an existing surface

The flat search is the small addition that makes the industry tree usable, because most people know their niche's name rather than its parent category. Keeping both views backed by one cached list is what stops the tree and the field ever disagreeing about what is selected.
