# Revenue API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/revenue` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/revenue |
| **Auth** | API key (query param `api_key`) |

Lists the company revenue bands a prospect search can be limited to, such as $1M-$10M.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner selling a product with a price floor, **I want** to limit a prospect search to companies in a revenue band, **so that** I stop writing to organisations that could never buy.

**Acceptance criteria**
- [ ] Given a valid API key, when I request revenue bands, then I get 200 with `success: true` and `data` as an array of `{ id, revenue }` where `revenue` is a band string such as `"$1M-$10M"`.
- [ ] Given this endpoint documents **no** `limit`, `offset` or `search` parameters — unlike head counts, levels and industries — when Harry calls it, then it sends only `api_key` and expects the whole list in one response. There is no pagination to implement and none should be built.
- [ ] Given the docs describe these as "active revenue options", when the list renders, then Harry shows exactly what is returned and does not cache a hardcoded set of bands, because the active options can change without notice.
- [ ] Given `revenue` values carry a currency symbol, when they render, then they are shown verbatim; Harry does not convert currency or reformat the band, because the docs do not say which currency is implied beyond the symbol shown.
- [ ] Given bands are selected, when the search runs, then the band **ids** are carried, not the label strings.
- [ ] Given the response is empty, when the list loads, then the revenue filter is hidden rather than shown empty, since an empty band list means the filter cannot be used at all.
- [ ] Given a 401, when the request runs, then the documented body `{"statusCode": 401, "success": false, "message": "Unauthorized"}` is returned and Harry shows one "Prospect search is not connected" message.
- [ ] Given revenue data is frequently missing for smaller companies in any prospect database, when the filter is applied, then the UI warns that setting it may exclude companies whose revenue is simply unknown.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/revenue?api_key=VALID` | 200, `data` array of `{ id, revenue }` with band strings; no `pagination` object |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Bands returned are that account's active options; Harry caches per workspace |
| TC-4 | Validation failure | Attempt to send `limit=10` | Harry never sends it; a test asserts the outgoing URL carries only `api_key`, because no other parameter is documented |
| TC-5 | Rate limited | Open and close the revenue group repeatedly | 429 on the excess; the band list is cached for hours so repeat opens make no request |
| TC-6 | Empty result set | Serve `data: []` | The revenue filter is hidden entirely with no empty dropdown left behind |
| TC-7 | Bands shown verbatim | Compare stub `revenue` strings with the UI | Every label matches character for character, currency symbol included |
| TC-8 | Ids carried, not labels | Tick two bands and run the search | The outgoing search carries band ids; relabelling in the stub does not change which companies are matched |
| TC-9 | Active options change | Change the stub's band list and force a cache refresh | The new bands appear and any selected band that no longer exists is flagged rather than silently dropped |
| TC-10 | Unknown-revenue warning | Tick any band | The group shows a note that companies with no revenue on record may be excluded |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load revenue bands just now"; other filters keep working |

## 4. Frontend user story

**As a** goal owner, **I want** revenue shown as a short list of tick boxes with an honest caveat, **so that** I understand I am filtering on data the provider may not have for every company.

**Scope**
- Leads → "Find prospects": a "Company revenue" checkbox group in the company filters, beside Company size, rendered from the provider's active options in the order returned, with no search box and no pager because the endpoint supports neither.
- A one-line caveat under the group: companies without revenue on record are excluded when this filter is set. It appears only once a band is ticked, so an untouched form stays quiet.
- Goals → goal detail, "Refine the audience": the same group, with any band Harry inferred from the ICP pre-ticked and marked "from your goal".
- A plain-English summary under the company filters combines size and revenue into one sentence ("Companies with 11-200 people and $1M-$50M revenue").
- State: one fetch, cached for hours; skeleton rows while loading; error keeps ticks; an empty band list hides the group.
- If a saved search references a band no longer in the active list, the chip renders with a "no longer available" note rather than disappearing.
- Accessibility: a fieldset with a legend and real checkboxes; the caveat and summary in a live region. Responsive: two columns above 640px, one below.

**Definition of done**
- [ ] Bands render verbatim from the provider, in order, as checkboxes.
- [ ] The caveat appears when the filter is in use and is announced to screen readers.
- [ ] A stale saved band is flagged, never silently dropped.
- [ ] An empty band list hides the group instead of showing an empty control.
- [ ] Loading, error and stale-band states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a cached, parameterless revenue lookup, **so that** the browser gets stable ids and the provider is called once per workspace per hour.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/revenue` returning `{ items: [{ id, label }], fetchedAt }`. No query parameters are accepted, mirroring the upstream endpoint.
- Cache: hours per workspace, with `fetchedAt` returned so the UI can show freshness and a manual refresh can invalidate.
- Stale-band detection: when a search draft references a band id absent from the current list, the route marks it stale in the response rather than dropping it, so the UI can tell the user.
- Data model: none of its own; prospect search drafts persist band **ids** with cached labels for display.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload and the group hides.
- Retry on 429 and 5xx with bounded exponential backoff and jitter; a 429 is served from cache where one exists.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss, plus a flag when the active band list changes between fetches, since that is worth knowing before a saved search quietly behaves differently.

**Definition of done**
- [ ] Route added, workspace-scoped, parameterless, provider key server-side only.
- [ ] A test asserts the outgoing request carries only `api_key`.
- [ ] Stale band ids are detected and surfaced, covered by a test.
- [ ] A change in the active band list raises a telemetry flag.

## 6. End-to-end test ticket

**Title:** E2E — Limit a prospect search by company revenue

**Preconditions:** A stubbed provider serving the documented revenue payload, a saved search draft referencing a band the stub can be made to drop, and a call counter on the stub.

**Flow**
1. Open Leads → "Find prospects" and expand the company filters.
2. Tick one revenue band and read the caveat.
3. Read the combined size-and-revenue summary line.
4. Collapse and reopen the group twice.
5. Remove that band from the stub's list, refresh the cache and reload the saved draft.
6. Serve an empty band list and reload.

**Assertions**
- [ ] Bands render verbatim including the currency symbol, with no pager and no search box.
- [ ] The caveat about missing revenue data appears only once a band is ticked, and is announced.
- [ ] The summary line covers size and revenue in one sentence.
- [ ] Reopening the group causes no further stub calls.
- [ ] After the band is removed upstream, the saved draft shows it flagged "no longer available" rather than dropping it.
- [ ] With an empty band list the group is absent entirely and no empty control is left behind.

**Teardown:** Discard the search draft; clear the revenue cache; restore the stub's full band list.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Company revenue checkbox group with a caveat line | Low | A handful of tick boxes with no search or pager, sharing the company filter group and its summary line with Company size |
| Goals → goal detail | Same group in "Refine the audience" | Low | Reuses the Leads component |
| Monitoring | A flag when the active band list changes | Low | One more telemetry row type |

**Verdict:** Fits an existing surface

Revenue is the natural partner to company size and belongs directly beside it, sharing one summary sentence so two filters read as one thought. The only element worth its space beyond the tick boxes is the caveat, because a revenue filter silently excludes every company whose revenue the provider does not know — and a user who is not told that will blame the search.
