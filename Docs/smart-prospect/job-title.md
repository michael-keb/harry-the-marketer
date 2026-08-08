# Job Title API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/job-title` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/job-title |
| **Auth** | API key (query param `api_key`) |

Lists job titles known to the prospect database so a search can target the exact roles you sell to.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to build a prospect search from real job titles, **so that** the same titles that make Harry's AI qualification score a lead highly are the titles I search for in the first place.

**Acceptance criteria**
- [ ] Given a valid API key, when I request job titles, then I get 200 with `success: true` and `data` as an array of `{ job_title }` objects, for example `{ "job_title": "Product Manager" }`.
- [ ] Given the documented response, when I build the UI, then I do not rely on an id or a `pagination` object — like the company, domain and keyword lookups in this category, this endpoint documents neither, so the title string is the key and "has more" is inferred from the page being full.
- [ ] Given no `limit` is supplied, when the request runs, then the documented default of 100 applies.
- [ ] Given `search` is supplied, when the request runs, then titles are filtered by name; the docs do not state whether this is a prefix or substring match, so the UI must not promise either and the helper text stays neutral.
- [ ] Given a goal's ICP already names decision-maker titles (Harry's qualification writes reasons such as "Decision-maker title: Head of Operations"), when the search draft is built, then those titles are matched against this list and proposed, with unmatched ones shown rather than dropped.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []`, and the picker shows "No job titles match that" with an option to keep the typed value as free text.
- [ ] Given the API key is missing or wrong, when the request runs, then 401 with `{"statusCode": 401, "success": false, "message": "Unauthorized"}` and a single connection message.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/job-title?api_key=VALID` | 200, `data` array of `{ job_title }`; up to 100 rows given the documented default |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=abc` | Non-numeric limit rejected; Harry validates and falls back to the default before calling upstream |
| TC-5 | Rate limited | Type "product manager" with no debounce | 429 on the excess; debounce to one call per 300ms with backoff and jitter |
| TC-6 | Empty result set | GET `search=zzzzz` | 200, `data: []`; "No job titles match that", with a keep-as-typed option |
| TC-7 | No pagination block | Inspect the 200 body | No `pagination` key is documented; "has more" comes from `data.length === limit` |
| TC-8 | Match behaviour unknown | GET `search=manager` | Whatever the provider returns is shown as-is; the helper text says "titles matching what you type", not "starting with" or "containing" |
| TC-9 | ICP title proposal | Build a goal whose qualification reasons name a decision-maker title | That title is proposed in the field with a "from your goal" note; an unmatched title is listed separately, not dropped |
| TC-10 | Deep offset | GET `offset=1000` | 200 with an empty or short array; "load more" hides and no error is shown |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load job titles just now"; existing chips kept |

## 4. Frontend user story

**As a** goal owner, **I want** a job-title field that suggests titles the provider actually indexes, **so that** I do not build a search around a title nobody's records use.

**Scope**
- Leads → "Find prospects": a multi-select "Job titles" field in the people group, below Departments and beside Seniority level, with typeahead and a free-text fallback for titles the provider does not list.
- Goals → goal detail, "Refine the audience": the same field, pre-filled from the goal's ICP with a "from your goal" marker, and a small list of ICP titles that had no match so the user can decide what to do with them.
- State: debounced typeahead, chips for selections, free-text entries visibly distinguished from matched ones so nobody assumes a typo was validated.
- The people group's shared summary line reads all three filters as one sentence ("People in Operations, at Head or VP level, with titles like Head of Operations").
- Empty state "No job titles match that" with a keep-as-typed option. Error state preserves chips.
- Accessibility: combobox semantics with arrow keys and Escape, keyboard-removable chips, free-text chips labelled as such in text rather than styling alone. Responsive: full-width sheet under 640px.

**Definition of done**
- [ ] Typeahead returns provider job titles, debounced, with in-flight cancellation.
- [ ] Free-text titles are allowed and visibly marked as unmatched.
- [ ] ICP-derived titles are proposed, and unmatched ICP titles are listed rather than dropped.
- [ ] The people group's summary line includes titles and updates live.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied job-title lookup that also reconciles a goal's ICP titles, **so that** the mapping from plain-English ICP to provider filter happens once, on the server, and can be audited.

**Scope**
- Routes in `server/routes.js`: `GET /api/prospects/filters/job-titles?search=&limit=&offset=` for typeahead, and `POST /api/prospects/filters/job-titles/reconcile` taking `{ titles: [] }` and returning `{ matched: [], unmatched: [] }` for ICP mapping.
- Because the documented response has no `pagination` object, `hasMore` is derived from `data.length === limit`, stated explicitly in the route so nobody copies the pagination shape used by the cities and industries lookups.
- Validation: `limit` numeric with the provider default of 100, `offset` floored at 0, `search` length-capped, reconcile list capped with a 422 naming the maximum.
- Data model: none. Search drafts persist title strings, since no id is available; the schema comment records why.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload and the field hides.
- Retry on 429 and 5xx with bounded exponential backoff and jitter; short cache keyed by `(search, limit, offset)`.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row when ICP titles are reconciled, naming how many matched and how many did not, so a user can later see why their search targeted the titles it did.

**Definition of done**
- [ ] Both routes added, workspace-scoped, provider key server-side only.
- [ ] `hasMore` derivation covered by tests against full and partial pages.
- [ ] Reconcile returns unmatched titles rather than silently dropping them, covered by a test.
- [ ] ICP reconciliation writes an auditable `events` row.

## 6. End-to-end test ticket

**Title:** E2E — Build a prospect search from the job titles in a goal's ICP

**Preconditions:** A stubbed provider serving the documented job-title payload knowing two of three ICP titles, one goal whose qualification reasons name decision-maker titles, and an empty Leads list.

**Flow**
1. Open the goal and expand "Refine the audience".
2. Inspect the Job titles field and the unmatched list.
3. Keep one unmatched title as free text and drop the other.
4. Add a fourth title from the typeahead.
5. Read the people group's summary line, save the draft and reload.

**Assertions**
- [ ] Two ICP titles appear as matched chips with a "from your goal" note.
- [ ] The third is listed as unmatched with its exact text, not dropped.
- [ ] The kept free-text title is visibly distinguished from matched chips.
- [ ] The summary line names department, level and titles in one sentence and is announced when it changes.
- [ ] After reload every chip persists with its matched or free-text nature intact.
- [ ] The activity trail records the reconciliation with matched and unmatched counts.

**Teardown:** Discard the search draft; clear the job-title cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Job titles field plus free-text chips | Medium | It shares the people group and the single summary line with Departments and Levels, so three filters read as one sentence rather than three controls |
| Goals → goal detail | Same field, plus an unmatched-titles list | Medium | The unmatched list appears only when there is something unmatched, and disappears once resolved |
| Dashboard activity trail | An entry per ICP title reconciliation | Low | Existing trail |

**Verdict:** Fits an existing surface

Harry already reasons about job titles when it scores a lead against an ICP, so exposing them as a search filter closes a loop rather than opening a new one. The only new idea is showing which ICP titles the provider does not recognise, and that exists to prevent a search that quietly targets nobody.
