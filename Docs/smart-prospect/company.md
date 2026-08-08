# Company API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/company` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/company |
| **Auth** | API key (query param `api_key`) |

Lists company names known to the prospect database so a user can name specific companies to search inside, or to exclude.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner with a named account list, **I want** to search the prospect database for companies by name, **so that** I can point a campaign at the exact organisations I care about rather than a broad industry filter.

**Acceptance criteria**
- [ ] Given a valid API key, when I request companies, then I get 200 with `success: true` and a `data` array of `{ company_name }` objects.
- [ ] Given the documented response, when I build the UI, then I do not rely on an id or a pagination block — unlike the cities and countries lookups, this endpoint's example returns `company_name` only and no `pagination` object, so the client must treat the company name itself as the key.
- [ ] Given I pass `search=acme`, when the request runs, then results are filtered by company name; the docs describe this as a filter without specifying prefix or substring matching, so the UI must not promise either.
- [ ] Given no `limit` is supplied, when the request runs, then the documented default of 100 applies — ten times the default of the city and country lookups, so the client must not assume a page of ten.
- [ ] Given I walk pages with `offset`, when I reach the end, then a short or empty `data` array is the only end-of-list signal available, and the "load more" control disappears on that basis.
- [ ] Given the API key is missing or wrong, when the request runs, then 401 is returned with `{"success": false, "message": "Unauthorized", "error": "User not authenticated"}` and Harry shows one connection message, not one per row.
- [ ] Given a company appears in the results that already exists in Harry's Leads, when the results render, then it is marked "already in your leads" so the user does not pay to fetch a contact they have.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/company?api_key=VALID` | 200, `data` is an array of `{ company_name }`; up to 100 entries given the documented default |
| TC-2 | Missing/invalid API key | GET `/company` with no `api_key` | 401, `{"error": "User not authenticated"}`; Harry shows "Prospect search is not connected" |
| TC-3 | Not found / wrong workspace | Call with a key from a different account | Results are scoped to that account only; no cross-workspace leakage into Harry's cache |
| TC-4 | Validation failure | GET `/company?api_key=VALID&limit=abc` | Non-numeric limit rejected; Harry validates and falls back to the default before calling upstream |
| TC-5 | Rate limited | Type a nine-character company name with no debounce | 429 on the excess; client debounces and retries with backoff, showing one inline "Retrying…" state |
| TC-6 | Empty result set | GET `/company?api_key=VALID&search=qqqqzzz` | 200 with `data: []`; the picker shows "No companies match that name" and offers to add it as free text instead |
| TC-7 | No pagination block | Inspect the 200 body | No `pagination` key is documented for this endpoint; the client derives "has more" from `data.length === limit` rather than reading a count |
| TC-8 | Duplicate names | Search a name shared by several companies (for example "Acme") | Every match renders; because only `company_name` is returned there is no id to disambiguate, so the UI must show them as one entry and say so honestly |
| TC-9 | Deep offset | GET with `offset=1000` | 200 with an empty or short array; "load more" hides and no error is shown |
| TC-10 | Upstream 500 | Force a provider 500 | Harry keeps the rest of the search form usable and shows "Could not load companies just now" |

## 4. Frontend user story

**As a** goal owner, **I want** a company filter in Harry's prospect search that suggests real company names, **so that** my target account list matches the provider's spelling of each company.

**Scope**
- Leads → "Find prospects" panel: a multi-select "Companies" field with typeahead, plus an "Exclude these companies" twin using the same component and the same lookup.
- Goals → goal detail, "Refine the audience": the same field, pre-seeded with any company names the ICP already mentions.
- State: debounced typeahead, chosen companies as removable chips, and a "Paste a list" affordance for users who already have an account list — pasted names are matched against the lookup and anything unmatched is flagged rather than silently dropped.
- Because only `company_name` is returned, chips carry the name as their identity; the UI must not imply that two identically named companies are distinguishable.
- Empty state: "No companies match that name" with an option to keep the typed value as a free-text filter. Error state preserves chips.
- Accessibility: combobox semantics, keyboard-removable chips, unmatched pasted names announced in a live region. Responsive: full-width sheet under 640px.

**Definition of done**
- [ ] Typeahead returns provider company names, debounced, with cancellation of in-flight requests.
- [ ] Paste-a-list matches names against the lookup and reports the unmatched ones.
- [ ] The include and exclude fields cannot both hold the same company; adding to one removes it from the other.
- [ ] Loading, empty, error and "already in your leads" states are all designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied company lookup route, **so that** the provider key stays on the server and the results can be reconciled with existing leads before they reach the browser.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/companies?search=&limit=&offset=` returning `{ items: [{ name, alreadyInLeads }], hasMore }`. The `alreadyInLeads` flag is computed server-side by matching against the workspace's `leads` table so the browser is not sent the whole lead list.
- Because the documented response has no `pagination` object, `hasMore` is derived from `data.length === limit`; this is written down in the route so nobody later assumes a count exists.
- Validation: `limit` numeric and clamped to a sane maximum, `offset` floored at 0, `search` length-capped. Default limit mirrors the provider's documented 100.
- Provider credentials env-gated in the same pattern as `server/google.js`; unconfigured returns a "not configured" payload rather than a 500.
- Retry on 429 and 5xx with bounded exponential backoff and jitter; short in-process cache keyed by `(search, limit, offset)`.
- Data model: none — no rows are written by a lookup.
- Logged: `telemetry` per upstream call (latency, status, cache hit) for Monitoring. No `events` row.

**Definition of done**
- [ ] Route added and workspace-scoped, provider key never sent to the client.
- [ ] `hasMore` derivation tested against a stub returning exactly `limit` rows and fewer than `limit` rows.
- [ ] `alreadyInLeads` matching tested for case and whitespace differences.
- [ ] Unconfigured provider returns the documented shape with no thrown error.

## 6. End-to-end test ticket

**Title:** E2E — Target a named account list in a prospect search

**Preconditions:** A stubbed provider serving the documented company payload, a workspace with three existing leads at "Acme Corp", and one goal with an ICP.

**Flow**
1. Open Leads and click "Find prospects".
2. Type "ac" into the Companies field and choose "Acme Corp".
3. Paste a list of five company names, one of which the stub does not know.
4. Move one company into "Exclude these companies".
5. Save the search draft and reload.

**Assertions**
- [ ] "Acme Corp" is marked "already in your leads" in the dropdown.
- [ ] Four pasted names become chips and the fifth is listed as unmatched with a way to keep or drop it.
- [ ] The excluded company disappears from the include field the moment it is excluded.
- [ ] After reload, both include and exclude selections survive.
- [ ] With the stub stopped, the field shows "Could not load companies just now" and no chip is lost.

**Teardown:** Discard the draft search; clear the lookup cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | Companies include/exclude fields | Medium | Both use one component and live inside a collapsed "Companies" group; exclude is revealed by a link, not shown by default |
| Goals → goal detail | Same field in "Refine the audience" | Low | Reuses the Leads component |
| Leads list | An "already in your leads" marker in prospect results | Low | A text badge on rows that already exist, no new column |

**Verdict:** Fits an existing surface

Naming target companies is part of describing an audience, which Harry already does in the goal's ICP and in the prospect search panel. Putting it anywhere else would ask the user to hold their account list in two places. No navigation item is added.
