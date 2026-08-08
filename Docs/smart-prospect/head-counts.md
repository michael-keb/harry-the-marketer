# Head Counts API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/head-counts` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/head-counts |
| **Auth** | API key (query param `api_key`) |

Lists the company-size bands a prospect search can be limited to, such as 1-10 or 11-50 employees.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to limit a prospect search to companies of a certain size, **so that** I stop wasting sends on organisations too small to afford us or too large to answer a cold email.

**Acceptance criteria**
- [ ] Given a valid API key, when I request head counts, then I get 200 with `data` as an array of `{ id, head_count }` where `head_count` is a range string such as `"1-10"` or `"11-50"`, plus a `pagination` object with `limit`, `offset`, `page` and `count`.
- [ ] Given `head_count` is a string range and not a number, when the UI renders it, then it is displayed verbatim as a band — Harry must not parse it into numbers and invent a slider, because the provider's bands are the only values the search accepts.
- [ ] Given the default `limit` is `"10"` and the range is 1–100, when the size picker opens, then Harry requests 100 so the whole band list is present in one call.
- [ ] Given `search` matches head count values *starting with* the supplied text, when I type "1", then bands beginning with 1 are returned — this is a starts-with match on a range string, which is rarely what a user means, so the picker should present the full list rather than lead with a search box.
- [ ] Given bands are selected, when the search runs, then the selected band **ids** are carried, not the label strings.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No sizes match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message linking to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/head-counts?api_key=VALID` | 200, `data` array of `{ id, head_count }` with range strings; `pagination.page` 1 |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=0` | Fails the documented `^[1-9][0-9]*$` pattern; Harry clamps to 1–100 first |
| TC-5 | Rate limited | Open and close the size picker repeatedly | 429 on the excess; the band list is cached for hours, so repeat opens make no request at all |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No sizes match that" |
| TC-7 | Bands are strings, not numbers | Inspect `head_count` values | Values like `"1-10"` render verbatim as checkboxes; no slider, no numeric parsing |
| TC-8 | Prefix search on a range | GET `search=1` | Returns bands starting with "1" (for example `1-10`, `11-50`) — demonstrating why a plain list beats a search box here |
| TC-9 | Id is carried | Select two bands and run the search | The outgoing search carries band ids; changing a label in a stub does not change which companies are matched |
| TC-10 | Full list in one page | GET `limit=100` | The whole band taxonomy arrives in one call and the picker shows no pager |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load company sizes just now"; other filters keep working |

## 4. Frontend user story

**As a** goal owner, **I want** company size shown as a short list of tick boxes, **so that** choosing "small companies" takes one glance rather than a slider I have to interpret.

**Scope**
- Leads → "Find prospects": a "Company size" group in the company filters, rendered as a checkbox list of the provider's bands in their natural order, with no search box because the whole list fits.
- Goals → goal detail, "Refine the audience": the same group, with any band Harry inferred from the ICP pre-ticked and marked "from your goal".
- State: the list is fetched once at `limit=100` and cached; loading shows three skeleton rows; error keeps any ticks already made.
- A plain-English summary under the group ("Companies with 11-200 people") so a set of ticked ranges reads as one sentence.
- Accessibility: a fieldset with a legend, real checkboxes with visible labels, the summary line in a live region. Responsive: the checkbox list becomes two columns above 640px and one below.

**Definition of done**
- [ ] Bands render verbatim from the provider, in order, as checkboxes.
- [ ] The summary line collapses contiguous ticked bands into one readable phrase.
- [ ] ICP-derived pre-ticks are visible, explained and removable.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a cached head-count lookup returning stable ids, **so that** a saved search still means the same size range after the provider relabels a band.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/head-counts?search=&limit=&offset=` returning `{ items: [{ id, label }], pagination }`.
- Validation: `limit` clamped to 1–100 with a first-load value of 100, `offset` floored at 0, `search` capped at 255 characters.
- Cache: the smallest and most static list in this category — cache the full page for hours per workspace and serve everything from it.
- Data model: none of its own; a stored prospect search draft persists band **ids** with cached labels for display.
- Provider credentials env-gated in the pattern of `server/google.js`; unconfigured returns the "not configured" payload and the group hides.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row only when a band is inferred from an ICP, naming the phrase it matched.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] Cache serves repeat opens without an upstream call, proven by a test counting provider hits.
- [ ] Search drafts round-trip band ids and survive a label change in a stub.
- [ ] Unconfigured provider degrades without a thrown error.

## 6. End-to-end test ticket

**Title:** E2E — Limit a prospect search by company size

**Preconditions:** A stubbed provider serving the documented head-counts payload, one goal whose ICP mentions company size in plain English, and a counter on the stub recording how many times it is called.

**Flow**
1. Open the goal and expand "Refine the audience".
2. Inspect the Company size group for pre-ticked bands.
3. Tick two adjacent bands and read the summary line.
4. Collapse and reopen the group three times.
5. Change the band label in the stub and reload the saved draft.

**Assertions**
- [ ] Pre-ticked bands carry a visible "from your goal" note and the activity trail says which phrase caused it.
- [ ] The summary line reads as one phrase covering both ticked bands and is announced when it changes.
- [ ] Reopening the group three times causes no additional provider calls, per the stub counter.
- [ ] After the label change, the chip's text changes but the saved draft still targets the same band id.
- [ ] With the stub stopped, the group shows "Could not load company sizes just now" while the rest of the filters still work.

**Teardown:** Discard the search draft; clear the head-count cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Company size checkbox group | Low | Six or so tick boxes with no search field, inside the company filters group that already exists |
| Goals → goal detail | Same group in "Refine the audience" | Low | Reuses the Leads component |
| Dashboard activity trail | An entry when a band is inferred from an ICP | Low | Existing trail |

**Verdict:** Fits an existing surface

Company size is one of the few filters almost every user sets, and the provider's own bands make it a short tick list rather than a control that needs explaining. It belongs beside industry and revenue in the prospect search panel; nothing new to navigate to.
