# Keywords API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/keywords` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/keywords |
| **Auth** | API key (query param `api_key`) |

Lists the keywords a prospect search can be filtered by, such as marketing or sales.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner whose ideal customer profile is written in signals ("uses Jira", "hiring", "SaaS"), **I want** to search prospects by those keywords, **so that** the signals Harry's qualification already scores against are the same signals I search on.

**Acceptance criteria**
- [ ] Given a valid API key, when I request keywords, then I get 200 with `success: true`, `message: "Keywords retrieved successfully"` and `data` as an array of `{ keyword }` objects, for example `{ "keyword": "marketing" }`.
- [ ] Given the documented response, when I build the UI, then I do not rely on an id or a `pagination` object — neither is documented, so the keyword string is the key and "has more" is inferred from the page being full.
- [ ] Given no `limit` is supplied, when the request runs, then the documented default of 100 applies; `offset` defaults to 0.
- [ ] Given `search` is supplied, when the request runs, then keywords are filtered by name; the docs do not state prefix or substring behaviour, so the helper text stays neutral.
- [ ] Given a goal's ICP lists signals in plain English, when the search draft is built, then each signal is checked against this list and the matched ones proposed as chips, with unmatched signals shown so nobody assumes they were applied.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []`, and the picker shows "No keywords match that" with an option to keep the typed value as free text.
- [ ] Given a 401, when the request runs, then the documented body `{"statusCode": 401, "success": false, "message": "Unauthorized"}` is returned and Harry shows one "Prospect search is not connected" message.
- [ ] Given the docs do not explain how keywords are matched against a company or person, when the UI is written, then it describes the filter honestly as "keywords the provider associates with a prospect" rather than claiming it searches a website or job description.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/keywords?api_key=VALID` | 200, `data` array of `{ keyword }`, `message` reads "Keywords retrieved successfully" |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=-5` | Rejected; Harry floors it and falls back to the documented default before calling upstream |
| TC-5 | Rate limited | Type a keyword with no debounce | 429 on the excess; debounce to one call per 300ms, back off with jitter |
| TC-6 | Empty result set | GET `search=zzzzz` | 200, `data: []`; "No keywords match that" with a keep-as-typed option |
| TC-7 | No pagination block | Inspect the 200 body | No `pagination` key is documented; "has more" comes from `data.length === limit` |
| TC-8 | ICP signal reconciliation | Build a goal whose ICP signals include "jira" and "saas" | Matched signals appear as chips with a "from your goal" note; unmatched ones are listed separately |
| TC-9 | Free-text keyword | Type a keyword the provider does not list and keep it | The chip is visibly marked unmatched, and the search summary says it may not narrow anything |
| TC-10 | Deep offset | GET `offset=1000` | 200 with an empty or short array; "load more" hides, no error |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load keywords just now"; chips kept, other filters usable |

## 4. Frontend user story

**As a** goal owner, **I want** a keyword field in the prospect search that mirrors my ICP signals, **so that** the phrase I typed into a goal and the filter I search with are visibly the same thing.

**Scope**
- Leads → "Find prospects": a multi-select "Keywords" field in its own row beneath the company filters, with typeahead and free-text entry.
- Goals → goal detail, "Refine the audience": the same field, pre-filled from the goal's ICP signals with a "from your goal" marker, and a short list of signals that found no matching keyword.
- Because Harry's qualification already writes reasons like "Matches signals: jira, saas", the goal page shows the same signal words in both places so the connection is obvious without explanation.
- State: debounced typeahead, chips for selections, free-text chips visibly distinguished, and a one-line note under the field stating honestly what the provider matches keywords against — the docs do not say, so neither does Harry.
- Empty state "No keywords match that". Error state preserves chips.
- Accessibility: combobox semantics, keyboard-removable chips, unmatched status conveyed in text. Responsive: full-width sheet under 640px.

**Definition of done**
- [ ] Typeahead returns provider keywords, debounced, with in-flight cancellation.
- [ ] ICP signals are reconciled into chips and unmatched signals are listed rather than dropped.
- [ ] Free-text keywords are allowed and visibly marked.
- [ ] The helper text does not claim matching behaviour the docs do not describe.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied keyword lookup with ICP signal reconciliation, **so that** goal signals and search filters stay one concept rather than two lists that drift apart.

**Scope**
- Routes in `server/routes.js`: `GET /api/prospects/filters/keywords?search=&limit=&offset=` for typeahead, and `POST /api/prospects/filters/keywords/reconcile` taking `{ signals: [] }` and returning `{ matched: [], unmatched: [] }`.
- Reconcile reads a goal's stored ICP signals — the same values the AI qualification cites in its reasons — normalises case and whitespace, and checks each against the lookup.
- Because the documented response has no `pagination` object, `hasMore` is derived from `data.length === limit`, stated explicitly in the route.
- Validation: `limit` numeric with the documented default of 100, `offset` floored at 0, `search` length-capped, reconcile list capped with a 422 naming the maximum.
- Data model: none. Search drafts persist keyword strings, since no id is available.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter; short cache keyed by `(search, limit, offset)`.
- Logged: `telemetry` per upstream call; an `events` row per reconciliation with matched and unmatched counts, so a user can audit why a search targeted the keywords it did.

**Definition of done**
- [ ] Both routes added, workspace-scoped, provider key server-side only.
- [ ] Reconcile reads the goal's existing ICP signals rather than a second, duplicate list.
- [ ] `hasMore` derivation covered by tests.
- [ ] Unmatched signals are returned and never silently discarded, covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Turn a goal's ICP signals into prospect search keywords

**Preconditions:** A stubbed provider serving the documented keywords payload knowing "saas" but not "jira", and a goal created from "Generate 20 qualified meetings with Australian SaaS companies using Jira" so its ICP signals include both.

**Flow**
1. Open the goal and read the qualification reasons on a scored lead.
2. Expand "Refine the audience" and inspect the Keywords field.
3. Keep the unmatched signal as free text.
4. Add one more keyword from the typeahead.
5. Save the draft, reload, and open the same field from Leads → "Find prospects".

**Assertions**
- [ ] The signal words shown in the qualification reasons and the words in the Keywords field are the same strings.
- [ ] "saas" appears as a matched chip with a "from your goal" note; "jira" is listed as unmatched with its exact text.
- [ ] The kept free-text chip is visibly distinguished and carries a note that it may not narrow the search.
- [ ] After reload every chip persists with its matched or free-text nature intact, and the Leads page shows the same set.
- [ ] The activity trail records the reconciliation with counts.
- [ ] With the stub stopped, the field shows "Could not load keywords just now" and keeps all chips.

**Teardown:** Discard the search draft; clear the keyword cache; delete the test goal.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Keywords field with free-text chips | Low | One field on its own row; typeahead plus chips is the same pattern used by every other filter here |
| Goals → goal detail | Same field, pre-filled from ICP signals, plus an unmatched list | Medium | The unmatched list shows only when something is unmatched; the signals themselves are already on the page in qualification reasons, so no new vocabulary is introduced |
| Dashboard activity trail | An entry per reconciliation | Low | Existing trail |

**Verdict:** Fits an existing surface

Signals are already a first-class idea in Harry — the qualification scorer cites them by name — so a keyword filter is that same idea pointed outward at the prospect database. Keeping the words identical in both places is what stops this becoming a second vocabulary the user has to maintain.
