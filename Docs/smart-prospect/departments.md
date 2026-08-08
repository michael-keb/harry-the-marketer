# Departments API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/departments` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/departments |
| **Auth** | API key (query param `api_key`) |

Lists the departments a prospect search can be limited to, such as Engineering or Sales.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to filter prospects by the department they sit in, **so that** my outreach reaches the function that owns the problem I solve rather than whoever happens to have a matching job title.

**Acceptance criteria**
- [ ] Given a valid API key, when I request departments, then I get 200 with `data` as an array of `{ id, department_name }` — for example `{ "id": 1, "department_name": "Engineering" }` — plus a `pagination` object with `limit`, `offset`, `page` and `count`.
- [ ] Given the documented default `limit` of `"10"`, when the department picker opens, then Harry requests up to 100 so the user sees the real breadth of the taxonomy rather than the first ten.
- [ ] Given I type into the field, when the text is sent as `search`, then only departments whose name starts with that value are returned, and `search` is echoed back instead of `null`.
- [ ] Given a department is selected, when the prospect search runs, then the chosen department ids are what get passed onward — the search must carry the id, not the display name, because the display name is not guaranteed stable.
- [ ] Given a goal whose ICP names a function in plain English (for example "operations leaders"), when the search draft is built, then Harry proposes the closest department and shows which one it picked, leaving it removable.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No departments match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message linking to Settings, and other filters keep working.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/departments?api_key=VALID` | 200, `data` array of `{ id, department_name }`; `pagination.page` 1 |
| TC-2 | Missing/invalid API key | GET `/departments` with no `api_key` | 401 with `"error": "User not authenticated"`; single banner, no per-row errors |
| TC-3 | Not found / wrong workspace | Call with another account's key | Results scoped to that account; Harry's cache is keyed per workspace so nothing crosses over |
| TC-4 | Validation failure | GET `/departments?api_key=VALID&limit=101` | Rejected against the documented 1–100 range; Harry clamps to 100 first and records the clamp in telemetry |
| TC-5 | Rate limited | Type "engineering" with no debounce | 429 on the excess; one request per 300ms after debouncing, backoff with jitter |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No departments match that" in the dropdown |
| TC-7 | Prefix matching only | GET `search=eng` then `search=neering` | The first returns Engineering, the second does not; the UI must not describe the field as "contains" |
| TC-8 | Full taxonomy | GET `limit=100&offset=0` then `offset=100` | Both pages return distinct departments; `pagination.page` increments |
| TC-9 | Id is carried, not the name | Select "Sales", then run the search | The outgoing search carries the department id; renaming the display label in a stub does not change which prospects come back |
| TC-10 | ICP mapping is a proposal | Build a goal reading "reach operations leaders" | A department is proposed with a visible note, and the search does not run until the user accepts or changes it |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load departments just now"; selections kept, other filters usable |

## 4. Frontend user story

**As a** goal owner, **I want** a department filter beside the job-title filter in Harry's prospect search, **so that** I can say "anyone in Operations" without listing twenty job titles.

**Scope**
- Leads → "Find prospects": a multi-select "Departments" field in the people group, directly above job title and seniority level, because department is the coarser of the three.
- Goals → goal detail, "Refine the audience": the same field, showing any department Harry proposed from the ICP with a "from your goal" marker.
- State: debounced typeahead over the lookup, chips for selections, first-open fetch at `limit=100`, "load more" advancing `offset` when the taxonomy is larger than one page.
- Empty state "No departments match that". Error state keeps chips and offers retry. Loading is confined to the field.
- Because the three people filters interact, the panel shows a plain-English summary line under them ("People in Operations, at Head or VP level") so the user is never left guessing what the combination means.
- Accessibility: combobox semantics, keyboard-removable chips, the summary line in a live region so it is announced when filters change. Responsive: the people group stacks to one column under 640px.

**Definition of done**
- [ ] Department field lists provider departments, filters as the user types and stores ids.
- [ ] The plain-English summary line updates as department, title and level change.
- [ ] ICP-proposed departments are visibly marked and removable.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied department lookup that returns stable ids, **so that** saved searches keep meaning the same thing when the provider relabels a department.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/departments?search=&limit=&offset=` returning `{ items: [{ id, name }], pagination }`.
- Validation: `limit` clamped to 1–100, `offset` floored at 0, `search` capped at 255 characters; the first load requests 100 rather than the provider default of 10.
- Cache: the department taxonomy is small and static, so cache the full first page for hours per workspace and serve prefix filtering from it, falling back to the provider for misses.
- Data model: none of its own, but any stored prospect search draft persists department **ids** with a cached display name for rendering, so a relabelled department still resolves.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload and the people group hides the field.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row when Harry proposes a department from an ICP, naming the phrase it matched.

**Definition of done**
- [ ] Route added, workspace-scoped, key server-side only.
- [ ] Search drafts round-trip department ids and survive a display-name change in a stub.
- [ ] ICP proposals are logged to `events` with their source phrase.
- [ ] Unconfigured provider degrades without error.

## 6. End-to-end test ticket

**Title:** E2E — Target a department in a prospect search

**Preconditions:** A stubbed provider serving the documented departments payload, one goal whose ICP names a function, and an empty Leads list.

**Flow**
1. Open the goal and expand "Refine the audience".
2. Check the Departments field for a proposal.
3. Replace it with a department chosen from the typeahead.
4. Add a seniority level and a job title so all three people filters are set.
5. Read the summary line, then save the search draft and reload.

**Assertions**
- [ ] The proposed department is visible with a "from your goal" note and can be removed in one action.
- [ ] Typing three letters returns only departments starting with those letters.
- [ ] The summary line reads as one plain-English sentence covering all three filters and is announced to screen readers when it changes.
- [ ] After reload the department chip is still present and still resolves to the same id.
- [ ] Renaming the department in the stub changes the chip's label but not which prospects the saved search targets.

**Teardown:** Discard the search draft; clear the department cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | Departments field plus a shared summary line for the people group | Medium | One summary line replaces three separate explanatory hints, so the group gets shorter rather than longer |
| Goals → goal detail | Same field in "Refine the audience" | Low | Reuses the Leads component |
| Dashboard activity trail | An entry when a department is proposed from an ICP | Low | Existing trail, one more entry type |

**Verdict:** Fits an existing surface

Department, job title and seniority are three views of the same question — who at the company should hear from us — so they belong together in the prospect search panel Harry already needs. The summary line is what keeps three filters from feeling like a form. No navigation item is added.
