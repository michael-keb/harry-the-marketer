# Industries API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/industries` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/industries |
| **Auth** | API key (query param `api_key`) |

Lists the industries a prospect search can be limited to, optionally with each industry's sub-industries nested inside it.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner whose ideal customer profile names a sector, **I want** to choose industries — and drill into sub-industries where they exist — **so that** "SaaS companies" becomes a real filter rather than a hopeful phrase.

**Acceptance criteria**
- [ ] Given a valid API key, when I request industries, then I get 200 with `data` as an array of `{ id, industry_name, sub_industry_list }` plus a `pagination` object carrying `limit`, `offset`, `page` and `count`.
- [ ] Given `withSubIndustry=true`, when the request runs, then each industry's `sub_industry_list` is populated with `{ sub_industry_name }` entries; the documented values for this parameter are the strings `true` and `false`.
- [ ] Given an industry with no sub-industries, when it renders, then `sub_industry_list` is an empty array and the row shows no expander — a real case in the documented example, where Healthcare has none while Technology has Software and Hardware.
- [ ] Given sub-industry entries carry only `sub_industry_name` and no id, when a sub-industry is selected, then the search must carry the name; this asymmetry with the parent's `id` is stated in the code so nobody assumes an id exists.
- [ ] Given the default `limit` is `"10"` within a 1–100 range, when the industry picker opens, then Harry requests 100 so the taxonomy is not silently truncated at ten.
- [ ] Given `search` matches industry names *starting with* the supplied text, when I type "tech", then Technology is returned and industries merely containing "tech" are not, and the field's helper text says so.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No industries match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/industries?api_key=VALID` | 200, `data` array of `{ id, industry_name, sub_industry_list }`; `pagination.page` 1 |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=200` | Outside the documented 1–100 range; Harry clamps to 100 before calling and records the clamp |
| TC-5 | Rate limited | Type an industry name with no debounce | 429 on the excess; the full list is cached so typing filters locally and makes no request |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No industries match that" |
| TC-7 | Sub-industries on | GET `withSubIndustry=true` | Technology returns `sub_industry_list` with Software and Hardware; Healthcare returns an empty array and no expander is rendered |
| TC-8 | Sub-industries off | GET `withSubIndustry=false` | Sub-industry lists are absent or empty; the UI shows no expanders and does not imply drilling is broken |
| TC-9 | Sub-industry has no id | Select a sub-industry, then run the search | The search carries the sub-industry **name**; a test asserts the code never reads `sub_industry.id` |
| TC-10 | Prefix matching only | GET `search=soft` | Returns nothing at industry level even though Software exists as a sub-industry, so the UI must search the cached sub-industry names client-side too |
| TC-11 | Paging the taxonomy | GET `limit=100&offset=0` then `offset=100` | Distinct industries per page; `pagination.page` increments |
| TC-12 | Upstream 500 | Force a provider 500 | "Could not load industries just now"; selections kept |

## 4. Frontend user story

**As a** goal owner, **I want** an industry picker that lets me expand into sub-industries where they exist, **so that** I can be as broad or as precise as my ideal customer profile needs.

**Scope**
- Leads → "Find prospects": an "Industries" group rendered as a two-level checkbox tree, fetched once with `withSubIndustry=true` at `limit=100` and filtered client-side as the user types.
- Ticking a parent industry selects the whole industry; expanding it and ticking specific sub-industries narrows to those. The parent shows an indeterminate state when only some children are ticked.
- Because the provider matches only on prefixes, Harry's own type-to-filter runs over the cached tree and matches sub-industry names too, so typing "software" finds it under Technology. The helper text explains that the list is filtered locally.
- Goals → goal detail, "Refine the audience": the same tree, with industries inferred from the ICP pre-ticked and marked "from your goal".
- State: one fetch, cached for hours; skeleton rows while loading; error keeps existing ticks; empty reads "No industries match that".
- Accessibility: a real tree with `aria-expanded` on parents, checkboxes with `aria-checked="mixed"` for the indeterminate state, keyboard expansion with arrow keys. Responsive: the tree scrolls within a fixed-height panel under 640px rather than pushing the form down the page.

**Definition of done**
- [ ] The tree renders parents and children with an accurate indeterminate state.
- [ ] Type-to-filter matches both industry and sub-industry names from the cached tree.
- [ ] Industries with an empty `sub_industry_list` render without an expander.
- [ ] ICP-derived pre-ticks are visible, explained and removable.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** one cached industry-tree route, **so that** the browser holds the whole taxonomy and the provider is called once rather than per keystroke.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/industries?withSubIndustry=&limit=&offset=` returning `{ items: [{ id, name, subIndustries: [{ name }] }], pagination }`.
- The route always requests `withSubIndustry=true` and `limit=100`, pages until the taxonomy is exhausted, and returns the assembled tree, so the client never has to page a filter list.
- Validation: `limit` clamped to 1–100, `offset` floored at 0, `search` capped at 255 characters, `withSubIndustry` coerced to the documented string values `true` or `false`.
- Cache: the assembled tree is cached for hours per workspace; a manual refresh action invalidates it.
- Data model: none of its own; prospect search drafts persist industry **ids** and sub-industry **names**, and the asymmetry is documented in the schema comment because it will otherwise look like a bug.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call and per tree assembly (page count, total industries, latency); an `events` row when industries are inferred from an ICP.

**Definition of done**
- [ ] Route assembles the full tree across pages and caches it, proven by a test counting provider calls.
- [ ] Sub-industries are returned by name only; no code path reads an id from them.
- [ ] Search drafts round-trip both selection kinds.
- [ ] Unconfigured provider degrades without a thrown error.

## 6. End-to-end test ticket

**Title:** E2E — Target an industry and its sub-industries in a prospect search

**Preconditions:** A stubbed provider serving the documented industries payload across two pages, one industry with sub-industries and one without, a goal whose ICP names a sector, and a call counter on the stub.

**Flow**
1. Open Leads → "Find prospects" and expand the Industries group.
2. Type "soft" into the filter box.
3. Expand Technology and tick only Software.
4. Tick the Healthcare parent, which has no children.
5. Save the draft, reload, and open the same tree from the goal.

**Assertions**
- [ ] The whole taxonomy loads in one client request even though the stub serves two pages.
- [ ] Typing "soft" surfaces Software under Technology, proving the local filter reaches sub-industry names.
- [ ] Technology shows an indeterminate checkbox while only Software is ticked.
- [ ] Healthcare renders without an expander and ticks as a leaf.
- [ ] After reload both selections persist, the industry by id and the sub-industry by name.
- [ ] The stub call counter shows no further calls when the group is collapsed and reopened.

**Teardown:** Discard the search draft; clear the industry tree cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A two-level industry tree with a local filter box | High | The tree is collapsed to its parents by default and lives in a fixed-height scrolling panel, so it cannot dominate the form; children appear only when a user asks for them |
| Goals → goal detail | Same tree in "Refine the audience" | Low | Reuses the Leads component |
| Dashboard activity trail | An entry when industries are inferred from an ICP | Low | Existing trail |

**Verdict:** Fits an existing surface

Industry is the filter most likely to bloat a search form, which is why it earns a contained, collapsed tree rather than a sprawl of tick boxes. It belongs with the other company filters on the prospect search panel; a user who only wants "Technology" never opens a single expander.
