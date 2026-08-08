# Save Search API

| | |
|---|---|
| **Endpoint** | `POST https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/save-search` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/save-search |
| **Auth** | API key (query param `api_key`) |

Saves a named set of prospect search filters so the same audience can be found again later.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to save the audience I have described as a named search, **so that** a goal's ideal customer profile becomes a reusable definition rather than a form I rebuild every month.

**Acceptance criteria**
- [ ] Given a search to save, when the request is built, then `search_string` is required and at least one character long — it is the human-readable name and the only mandatory field; every other field is optional criteria.
- [ ] Given the full set of documented criteria, when a save is built from Harry's form, then each of Harry's filters maps to exactly one documented field: `title`, `includeTitle`, `excludeTitle`, `department`, `level`, `companyName`, `companyDomain`, `includeCompany`, `excludeCompany`, `includeCompanyDomain`, `excludeCompanyDomain`, `companyKeyword`, `companyHeadCount`, `companyRevenue`, `companyIndustry`, `companySubIndustry`, `city`, `state`, `country`, plus `name`, `firstName` and `lastName`.
- [ ] Given every criteria field is an array of strings, when a single value is chosen in the UI, then it is still sent as a one-element array, never a bare string.
- [ ] Given the three exact-match booleans `titleExactMatch`, `companyExactMatch` and `companyDomainExactMatch`, when they are offered in the UI, then each is a plain toggle beside the field it governs rather than a settings block, and the default is off.
- [ ] Given `dontDisplayOwnedContact` is a boolean, when it is offered, then it is worded plainly — "hide contacts I already own" — rather than by its field name.
- [ ] Given `limit` accepts 1–10000, when a value outside that range is entered, then Harry rejects it before calling and states the range.
- [ ] Given a successful save, when the response arrives, then it is only `{"success": true, "message": "Search saved successfully"}` — **no id is returned**. Harry must re-list saved searches to discover the new record's id, and this is called out in the code because every later operation on a saved search needs that id.
- [ ] Given two saves with the same `search_string`, when both complete, then the docs describe no uniqueness rule, so Harry warns about a duplicate name before saving rather than assuming the provider will refuse it.
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message and the unsaved form is preserved.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, minimum body | POST `{"search_string": "Directors in United States"}` | 200, `{"success": true, "message": "Search saved successfully"}` |
| TC-2 | Missing/invalid API key | Same body with no `api_key` | 401, `"error": "User not authenticated"`; the form's contents are preserved for a retry |
| TC-3 | Not found / wrong workspace | Save while authenticated as another account, then list saved searches from the first | The saved search does not appear in the first account; Harry scopes its own record per workspace |
| TC-4 | Validation failure — no name | POST `{"title": ["Director"]}` with no `search_string` | Rejected; Harry blocks it client-side with a field-level message on the name field |
| TC-5 | Rate limited | Save several searches in a burst | 429 on the excess; Harry backs off with jitter and retries once, preserving the form |
| TC-6 | Empty result set | Save a search whose criteria match nobody | The save still succeeds — saving is not searching — and the UI does not claim the audience is non-empty |
| TC-7 | No id in the response | Inspect the 200 body | No id field; Harry re-lists saved searches to resolve the new record and only then enables actions that need an id |
| TC-8 | Arrays, not strings | Choose one country in the UI and inspect the outgoing body | `country` is `["United States"]`, an array with one element |
| TC-9 | Limit out of range | POST `limit: 20000` | Rejected against the documented 1–10000 range before the upstream call |
| TC-10 | Exact-match toggles | Save with `titleExactMatch: true` | The toggle is sent and the saved search's summary states "exact title match" in plain English |
| TC-11 | Duplicate name | Save the same `search_string` twice | Harry warns before the second save; if the user proceeds, both exist and the list shows their dates to tell them apart |
| TC-12 | Include and exclude conflict | Put the same company in `includeCompany` and `excludeCompany` | Harry blocks it with a field-level message, since the provider's behaviour in this case is undocumented |
| TC-13 | Upstream 500 | Force a provider 500 | "Could not save that search just now"; the form keeps everything and offers a retry |

## 4. Frontend user story

**As a** goal owner, **I want** a "Save this search" step that names the audience in my own words, **so that** the search becomes something I can return to and share with my team.

**Scope**
- Leads → "Find prospects": a "Save search" action at the foot of the form, opening a small dialog asking for the name (`search_string`) with a suggestion pre-filled from the chosen filters ("Directors in Operations, United States").
- The form's fields map one-to-one to the documented criteria, grouped as they already are: people (titles, department, level, names), companies (name, domain, keyword, head count, revenue, industry, sub-industry), and location (city, state, country).
- Include and exclude are two modes of the same field for titles, companies and domains, matching the documented pairs, rather than six separate controls.
- Exact-match toggles sit beside their own field, worded as "match exactly", not in a separate options block.
- A single "hide contacts I already own" toggle for `dontDisplayOwnedContact`, plus a result-limit field validated to 1–10000.
- Because the save returns no id, the dialog shows a brief "Saved" state and the saved-searches list refreshes to reveal the new entry; actions needing an id are disabled until that refresh lands.
- Duplicate-name warning before saving. Conflict warning when a value appears in both an include and its matching exclude.
- Accessibility: the dialog is a labelled modal with focus trap and Escape; toggles are real checkboxes with visible labels; the warning is a live region. Responsive: the dialog is full-screen under 640px.

**Definition of done**
- [ ] Every documented criteria field is reachable from the form, and nothing is sent that the docs do not define.
- [ ] Single selections are sent as one-element arrays.
- [ ] The name is pre-filled from the filters and freely editable.
- [ ] Duplicate names and include/exclude conflicts are warned about before the call.
- [ ] The post-save refresh resolves the new id before id-dependent actions are enabled.
- [ ] Loading, saved, duplicate-warning and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a save route that translates Harry's filter model into the documented body and resolves the missing id, **so that** the client never has to know the provider's field names or work around the empty response.

**Scope**
- Route in `server/routes.js`: `POST /api/prospects/searches` taking Harry's normalised filter object plus a name, translating it into the documented body, and — because the response carries no id — immediately listing saved searches to find the new record and returning `{ id, name, filters }` to the client.
- Translation is one explicit mapping table covering all documented fields, with a test asserting no undocumented key is ever sent. Values are coerced to arrays; booleans are passed as booleans; `limit` is validated to 1–10000.
- Conflict validation before the call: the same value in `includeCompany` and `excludeCompany` (or the title and domain equivalents) returns a 422 naming both fields.
- Data model: a `prospect_searches` row (`id`, `workspace_id`, `provider_filter_id`, `name`, `filters_json`, `goal_id`, `created_at`) so a saved search can be linked to a Harry goal — this is what lets an ICP and a provider search stay one idea. The `provider_filter_id` is filled from the resolution step and is nullable until it resolves.
- Id resolution is retried a bounded number of times; if it never resolves, the local row is kept with a clear "not linked yet" state rather than being discarded.
- Rate limiting and retry: 429 and 5xx retried with bounded exponential backoff and jitter; a save is not retried blindly after an ambiguous failure — the resolution step is used to check whether it landed, which is what makes a retry safe.
- Logged: an `events` row per save naming who saved it, the name and the goal it is linked to; `telemetry` per upstream call with latency and status, plus a flag when id resolution fails.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] The mapping table covers every documented field and sends nothing else, covered by a test.
- [ ] Id resolution works and its failure leaves a usable "not linked yet" record.
- [ ] An ambiguous save failure is resolved by checking rather than by blind retry, so no duplicate is created.
- [ ] Include/exclude conflicts are rejected with a 422 naming both fields.

## 6. End-to-end test ticket

**Title:** E2E — Save a goal's audience as a named prospect search

**Preconditions:** A stubbed provider implementing save plus saved-searches listing, one goal with a built ICP, and a stub mode where the save succeeds but the listing lags by one call.

**Flow**
1. Open the goal and expand "Refine the audience".
2. Set a title, a department, a country and a head-count band, and turn on exact title matching.
3. Click "Save this search" and accept the suggested name.
4. Watch the saved list refresh and the id resolve.
5. Save a second search with the same name.
6. Repeat with the lagging-listing stub mode.

**Assertions**
- [ ] The outgoing body contains only documented fields, with every criteria value as an array.
- [ ] `titleExactMatch` is sent as `true` and the saved entry's summary says "exact title match" in plain English.
- [ ] Id-dependent actions stay disabled until the listing resolves the new id, then enable.
- [ ] The duplicate name triggers a warning before the second save and both entries are distinguishable by date afterwards.
- [ ] In the lagging mode the entry appears as "not linked yet" and resolves on the next refresh without creating a second save.
- [ ] The saved search is linked to the goal, visible on both the goal and the saved-search list.
- [ ] The activity trail records the save with the name and the linked goal.

**Teardown:** Delete the saved searches from the stub and the local `prospect_searches` rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A "Save search" action and naming dialog | Low | One button and one small dialog with one required field; the name is pre-filled so most users press Save without typing |
| Leads → Find prospects form | Include/exclude modes and exact-match toggles on existing fields | Medium | Include/exclude is a mode switch inside one field rather than a second field, and each exact-match toggle sits on its own field rather than in an options panel |
| Goals → goal detail | A saved search linked to the goal | Low | One line naming the search, which is what turns an ICP into something reusable |
| Dashboard activity trail | An entry per save | Low | Existing trail |

**Verdict:** Fits an existing surface

Saving is the act that turns Harry's plain-English goal into a durable audience definition, so it belongs at the foot of the search form and linked to the goal — not in a separate library. The one thing worth engineering carefully is invisible: because the save returns no id, the resolution step is what stops a retry creating two copies of the same audience.
