# Levels API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/levels` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/levels |
| **Auth** | API key (query param `api_key`) |

Lists the seniority levels a prospect search can be limited to, such as Entry or Senior.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner, **I want** to filter prospects by seniority, **so that** my outreach reaches people who can actually decide, which is the same thing Harry's qualification already rewards when it scores a lead.

**Acceptance criteria**
- [ ] Given a valid API key, when I request levels, then I get 200 with `data` as an array of `{ id, level_name }` — for example `{ "id": 1, "level_name": "Entry" }` — plus a `pagination` object with `limit`, `offset`, `page` and `count`.
- [ ] Given the default `limit` is `"10"` within a 1–100 range, when the seniority picker opens, then Harry requests 100 so the full ladder is present in one call.
- [ ] Given `search` matches level names *starting with* the supplied text, when the list is short enough to show whole, then the picker shows all levels as tick boxes and no search box, because a starts-with search over a handful of values is friction rather than help.
- [ ] Given levels are selected, when the search runs, then the level **ids** are carried, not the labels.
- [ ] Given the provider's ladder is its own vocabulary, when the UI renders it, then labels are shown verbatim and Harry does not map them onto its own words — the docs give no mapping, so inventing one would be a guess presented as fact.
- [ ] Given a goal's ICP implies seniority in plain English (for example "decision-maker"), when the search draft is built, then Harry proposes matching levels and shows which it chose, leaving it removable.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and `count: 0`, and the picker shows "No levels match that".
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message with a link to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/levels?api_key=VALID` | 200, `data` array of `{ id, level_name }`; `pagination.page` 1 |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner |
| TC-3 | Not found / wrong workspace | Call with another account's key | Scoped to that account; Harry caches per workspace |
| TC-4 | Validation failure | GET `limit=0` | Fails the documented `^[1-9][0-9]*$` pattern; Harry clamps to 1–100 before calling |
| TC-5 | Rate limited | Open and close the seniority group repeatedly | 429 on the excess; the ladder is cached for hours so repeat opens make no request |
| TC-6 | Empty result set | GET `search=zzz` | 200, `data: []`, `count: 0`; "No levels match that" |
| TC-7 | Labels shown verbatim | Compare the stub's `level_name` values with the UI | Every label matches character for character; no relabelling, no reordering into an invented hierarchy |
| TC-8 | Ids carried, not labels | Tick two levels and run the search | The outgoing search carries level ids; changing a label in the stub does not change which people are matched |
| TC-9 | Ladder longer than one page | Serve 30 levels across pages at `limit=10` | Harry's route pages until exhausted and the picker shows all 30 with no pager |
| TC-10 | ICP seniority proposal | Build a goal whose ICP says "decision-makers" | Levels are proposed with a visible note, and the search does not run until the user accepts or changes it |
| TC-11 | Upstream 500 | Force a provider 500 | "Could not load seniority levels just now"; ticks kept, other filters usable |

## 4. Frontend user story

**As a** goal owner, **I want** seniority shown as a short tick list beside department and job title, **so that** the three together read as one sentence about who I am writing to.

**Scope**
- Leads → "Find prospects": a "Seniority" checkbox group in the people group, below Departments and Job titles, rendered as the provider's full ladder in the order returned.
- Goals → goal detail, "Refine the audience": the same group, with levels inferred from the ICP pre-ticked and marked "from your goal".
- The people group's shared summary line reads all three filters as one sentence ("People in Operations, at Senior level, with titles like Head of Operations").
- State: one fetch at `limit=100`, cached; skeleton rows while loading; error keeps existing ticks; empty reads "No levels match that".
- Accessibility: a fieldset with a legend and real checkboxes with visible labels; the summary line in a live region. Responsive: two columns above 640px, one below.

**Definition of done**
- [ ] The ladder renders verbatim from the provider, in order, as checkboxes.
- [ ] The people group's summary line includes seniority and updates live.
- [ ] ICP-derived pre-ticks are visible, explained and removable.
- [ ] Loading, empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a cached seniority lookup returning stable ids, **so that** a saved search still targets the same seniority after the provider relabels a level.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/filters/levels?search=&limit=&offset=` returning `{ items: [{ id, name }], pagination }`, paging until the ladder is exhausted so the client never pages a filter list.
- Validation: `limit` clamped to 1–100, `offset` floored at 0, `search` capped at 255 characters, both sent as strings since the parameters are documented as strings.
- Cache: the ladder is small and static; cache it for hours per workspace with a manual refresh to invalidate.
- Data model: none of its own; prospect search drafts persist level **ids** with cached labels for display.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload and the group hides.
- Retry on 429 and 5xx with bounded exponential backoff and jitter.
- Logged: `telemetry` per upstream call with latency, status and cache hit/miss; an `events` row when levels are inferred from an ICP, naming the phrase that caused it.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] Multi-page ladders are assembled server-side, proven by a test against a paging stub.
- [ ] Search drafts round-trip level ids and survive a label change.
- [ ] Unconfigured provider degrades without a thrown error.

## 6. End-to-end test ticket

**Title:** E2E — Restrict a prospect search to decision-maker seniority

**Preconditions:** A stubbed provider serving the documented levels payload across two pages, one goal whose ICP implies seniority, and a call counter on the stub.

**Flow**
1. Open the goal and expand "Refine the audience".
2. Inspect the Seniority group for pre-ticked levels.
3. Untick one and tick another.
4. Read the people group summary line.
5. Collapse and reopen the group twice, then save and reload.

**Assertions**
- [ ] All levels from both stub pages appear in one group with no pager.
- [ ] Pre-ticked levels carry a "from your goal" note and the activity trail names the phrase behind it.
- [ ] The summary line covers department, seniority and titles in one sentence and is announced when it changes.
- [ ] Reopening the group causes no further stub calls.
- [ ] After reload the ticks persist by id, and relabelling a level in the stub changes only the visible text.

**Teardown:** Discard the search draft; clear the level cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | A Seniority checkbox group | Low | A handful of tick boxes with no search field, sharing the people group and its single summary line |
| Goals → goal detail | Same group in "Refine the audience" | Low | Reuses the Leads component |
| Dashboard activity trail | An entry when levels are inferred from an ICP | Low | Existing trail |

**Verdict:** Fits an existing surface

Seniority is the third of the three people filters and the cheapest to render, since the ladder is short and fixed. It earns its place because Harry's qualification already scores decision-maker titles highly, and this is how a user asks for those people before paying to fetch them.
