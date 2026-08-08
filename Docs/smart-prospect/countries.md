# Countries API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/countries` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/countries |
| **Auth** | API key (query param `api_key`) |

Lists the countries a prospect search can be limited to, matched against what the user has typed so far.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner whose ideal customer profile names a market, **I want** to pick countries from the provider's own list, **so that** the search understands "Australian SaaS companies" the same way the goal statement does.

**Acceptance criteria**
- [ ] Given a valid API key, when I request countries with no other parameters, then I get 200 with `data` as an array of `{ id, country_name }` and a `pagination` object with `limit`, `offset`, `page` and `count`.
- [ ] Given the default `limit` is `"10"`, when the country picker opens cold, then the UI does not present those ten as the complete list — it either raises `limit` to 100 or shows a "keep typing to narrow" hint.
- [ ] Given I type into the field, when the text is sent as `search`, then only countries whose name *starts with* that value are returned and `search` is echoed in the response.
- [ ] Given `limit` outside 1–100 or a negative `offset`, when the request runs, then it is rejected against the documented patterns before it reaches the provider.
- [ ] Given a goal statement that names a country in plain English (for example "Australian SaaS companies using Jira"), when the goal's ICP is built, then Harry pre-selects the matching country from this list and shows which one it chose.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No countries match that".
- [ ] Given a 401, when the request runs, then Harry shows "Prospect search is not connected" once, with a link to Settings, and the rest of the search form stays usable.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, defaults | GET `/countries?api_key=VALID` | 200, `data` array of `{ id, country_name }`; `pagination.limit` 10, `offset` 0, `page` 1 |
| TC-2 | Missing/invalid API key | GET `/countries` with no `api_key` | 401 with `"error": "User not authenticated"`; single connection banner in the UI |
| TC-3 | Not found / wrong workspace | Call with another account's key | Only that account's data is returned; nothing is written into this workspace's cache |
| TC-4 | Validation failure | GET `/countries?api_key=VALID&offset=-5` | Rejected against the documented `^[0-9]+$` pattern; Harry floors it at 0 before the call and records the correction |
| TC-5 | Rate limited | Type a country name letter by letter with no debounce | 429 on the excess; debounce to one call per 300ms and back off with jitter |
| TC-6 | Empty result set | GET `/countries?api_key=VALID&search=zz` | 200, `data: []`, `pagination.count: 0`; "No countries match that" in the dropdown |
| TC-7 | Prefix matching only | GET `search=united` then `search=kingdom` | The first returns United States and United Kingdom; the second returns neither, because matching is starts-with |
| TC-8 | Full list beyond the default page | GET `limit=100` | Up to 100 countries in one call; the picker no longer implies the world has ten countries |
| TC-9 | ICP pre-selection | Create a goal reading "20 qualified meetings with Australian SaaS companies" | The country field opens with the matching country selected and a visible note saying it came from the goal |
| TC-10 | Upstream 500 | Force a provider 500 | "Could not load countries just now"; already-selected countries are kept |

## 4. Frontend user story

**As a** goal owner, **I want** the country filter in the prospect search to be a real list rather than a free-text box, **so that** I cannot silently search for a country the provider has never heard of.

**Scope**
- Leads → "Find prospects": a multi-select "Countries" field at the top of the location group, above states and cities, because the city lookup's `country` filter depends on a state being chosen first.
- Goals → goal detail, "Refine the audience": the same field, pre-filled from the goal's ICP with a visible "from your goal" marker the user can clear.
- State: debounced typeahead, chips for chosen countries, and a first-open fetch at `limit=100` so the list does not look like it has ten entries.
- Empty state "No countries match that". Error state keeps chips and offers a retry. Loading is a spinner inside the field only.
- Accessibility: combobox with arrow-key navigation and Escape, chips removable by keyboard, the "from your goal" marker read out as text rather than shown by colour. Responsive: full-width sheet under 640px.

**Definition of done**
- [ ] The country field lists provider countries and filters as the user types.
- [ ] ICP-derived pre-selection is visible, explained and removable.
- [ ] The location group's order makes the state/country dependency obvious without a tooltip.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied country lookup with a long cache, **so that** a list that barely changes is not fetched on every keystroke.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/countries?search=&limit=&offset=` returning `{ items: [{ id, name }], pagination }`.
- Validation: `limit` clamped to 1–100 with the provider default of 10 raised to 100 for the first load, `offset` floored at 0, `search` capped at 255 characters.
- Cache: countries are the most static list in this category, so cache the unfiltered `limit=100` page for hours and serve prefix filtering from that cached page where possible, falling back to the provider for anything unusual.
- Provider credentials env-gated in the pattern of `server/google.js`; unconfigured returns the documented "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Data model: none. A helper in the goals code maps ICP text to a country id using this list, and stores only the chosen id on the goal's search draft.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row only when the ICP mapper auto-selects a country, because that is a decision the user should be able to audit.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] Cached-page prefix filtering returns the same results as the provider for the documented starts-with behaviour, covered by tests.
- [ ] ICP auto-selection writes an `events` row naming the country and the phrase it matched.
- [ ] Unconfigured provider degrades without a thrown error.

## 6. End-to-end test ticket

**Title:** E2E — Restrict a prospect search to a country named in the goal

**Preconditions:** A stubbed provider serving the documented countries payload, and a new goal typed as "Generate 20 qualified meetings with Australian SaaS companies using Jira".

**Flow**
1. Create the goal from the Goals page and let the ICP build.
2. Open "Refine the audience" on the goal.
3. Inspect the Countries field.
4. Remove the pre-selected country and type two letters to pick a different one.
5. Open Leads → "Find prospects" and confirm the same field behaves identically.

**Assertions**
- [ ] The Countries field opens with the goal's country selected and a visible "from your goal" note.
- [ ] The activity trail records that the country was chosen automatically and from which phrase.
- [ ] Removing the chip clears the note; the search draft updates without a page reload.
- [ ] Typing two letters returns only countries starting with those letters.
- [ ] With the stub stopped, the field shows "Could not load countries just now" and keeps the current selection.

**Teardown:** Delete the goal and its search draft; clear the country cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | Country field at the top of the location group | Low | It is the group's first field and the one most users set; states and cities stay collapsed until it is set |
| Goals → goal detail | Country shown in "Refine the audience" with provenance | Low | One chip and one line of text, inside a panel that already exists |
| Dashboard activity trail | An entry when a country is auto-selected from the ICP | Low | Uses the existing trail; no new surface |

**Verdict:** Fits an existing surface

Country is the coarsest audience filter Harry has and it is already implied by the plain-English goal statement, so the honest place for it is beside the ICP and inside the prospect search panel. Showing where the pre-selection came from is what stops the automation feeling like a guess. No navigation item is added.
