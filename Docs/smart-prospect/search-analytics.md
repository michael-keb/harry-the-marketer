# Search Analytics API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-analytics` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/search-analytics |
| **Auth** | API key (query param `api_key`) |

Reports how many prospects were found and how many emails were fetched this month against last, how many credits remain, and the daily and per-fetch ceilings.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner about to fetch a list, **I want** to see my remaining credits and my daily and single-fetch ceilings before I commit, **so that** a fetch never fails halfway because I asked for more than my plan allows.

**Acceptance criteria**
- [ ] Given a valid API key, when I request search analytics, then I get 200 with `data.leadsFound`, `data.emailsFetched`, `data.availableCredits`, `data.leadsFoundToday`, `data.maxDailyFetchLimit` and `data.maxSingleFetchLimit`.
- [ ] Given `leadsFound` and `emailsFetched`, when they render, then each carries `current`, `previousMonth`, `percentageChange` (a number), `percentageChangeText` (a preformatted string such as `"+15.79%"`), `trend` and `total` — note that both a numeric and a preformatted change are supplied, so Harry displays the text and never reformats the number.
- [ ] Given `availableCredits` carries `available`, `total` and `used`, when it renders, then all three are shown, because "500 of 1000 used" is a materially different message from "500 left".
- [ ] Given `maxSingleFetchLimit`, when the fetch dialog opens, then the count field is capped at that value and the cap is stated in the field's help text — this is the number that decides whether a fetch can succeed at all.
- [ ] Given `maxDailyFetchLimit` and `leadsFoundToday`, when the fetch dialog opens, then the remaining daily allowance is shown, in the same spirit as Harry's per-mailbox daily send allowance which the product already surfaces.
- [ ] Given the optional `filter_id` query parameter (pattern `^[0-9]+$`), when it is supplied, then `data.filterData` carries `leadsFound` and `emailsFetched` for that saved search alone, and the UI attributes it to that search by name.
- [ ] Given `filter_id` is omitted, when the response arrives, then `filterData` is not meaningful for any particular search, so the UI must not display it as if it were an account total.
- [ ] Given credits are exhausted, when the fetch dialog opens, then the fetch action is disabled with the reason stated up front, rather than letting the fetch fail with a `200` and `success: false`.
- [ ] Given a 401, when the request runs, then Harry shows "Prospect analytics are not connected" in place of the figures and the rest of the page still works.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, account-wide | GET `/search-analytics?api_key=VALID` | 200 with all six documented top-level sections |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; figures replaced by a "not connected" state |
| TC-3 | Not found / wrong workspace | GET with a `filter_id` from another account | The per-filter block is empty or absent; Harry attributes nothing and shows "No figures for that search" |
| TC-4 | Validation failure | GET `filter_id=abc` | Fails the documented `^[0-9]+$` pattern; Harry rejects it before calling |
| TC-5 | Rate limited | Open and close the fetch dialog repeatedly | 429 on the excess; figures are cached for minutes and the dialog reads from cache, refreshing only when stale |
| TC-6 | Empty result set | Serve zeros throughout | "0 found this month", "0 credits used"; no division is performed by Harry and the preformatted change text is shown as received |
| TC-7 | Preformatted versus numeric change | Serve `percentageChange: 15.79` and `percentageChangeText: "+15.79%"` | The text is displayed; a test asserts Harry never formats the number itself |
| TC-8 | Single-fetch cap enforced | Set `maxSingleFetchLimit: 500` and try to fetch 600 | The count field caps at 500 and states the cap; no request is sent |
| TC-9 | Daily cap enforced | Set `maxDailyFetchLimit: 1000` and `leadsFoundToday: 950` | The dialog shows 50 remaining today and caps the count accordingly |
| TC-10 | Credits exhausted | Set `availableCredits.available: 0` | The fetch action is disabled with "No credits left" stated before any attempt |
| TC-11 | Per-filter figures | GET with a valid `filter_id` | `filterData` figures render attributed to that saved search by name, never as an account total |
| TC-12 | Contradictory payload | Serve `trend: "increase"` with `current` below `previousMonth` | Both are shown as received; telemetry flags the inconsistency for Monitoring |
| TC-13 | Upstream 500 | Force a provider 500 | The figures area shows "unavailable"; the fetch action falls back to a conservative cap and says why |

## 4. Frontend user story

**As a** goal owner, **I want** my credits and limits shown at the moment I decide how many contacts to fetch, **so that** the decision is informed rather than a guess I discover was wrong afterwards.

**Scope**
- Leads → "Find prospects" → fetch confirmation dialog: a compact strip above the count field showing credits available of total, remaining daily allowance (`maxDailyFetchLimit` minus `leadsFoundToday`) and the single-fetch cap. The count field is validated against both caps live.
- Leads → "Find prospects" panel header: a small figures row for leads found and emails fetched this month, with the provider's own `percentageChangeText` and `trend`.
- Saved search rows: when a row is expanded, its per-filter `leadsFound` and `emailsFetched` are shown, fetched with `filter_id` and attributed to that search by name.
- Reports: nothing new. These are provider-account figures, not outreach outcomes, so they stay inside the prospecting surfaces rather than mixing with Harry's own funnel numbers.
- State: cached for minutes with a visible freshness note; a skeleton strip while loading; on error the dialog still opens but the fetch count is capped conservatively and the reason is stated.
- Accessibility: figures as text with labels, caps announced when they change the field's maximum, the credit state described in words rather than a bar alone. Responsive: the strip wraps to two lines under 640px.

**Definition of done**
- [ ] Credits, daily remaining and single-fetch cap appear in the fetch dialog and constrain the count field.
- [ ] Fetch is disabled with a stated reason when credits are zero.
- [ ] Per-filter figures are shown only when fetched with that `filter_id` and are attributed by name.
- [ ] The provider's preformatted change text is displayed verbatim.
- [ ] Loading, zero, error and capped states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** search analytics fetched, cached and enforced server-side, **so that** a fetch request that would exceed a documented cap is refused before it costs anything.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/analytics?filterId=` returning `{ leadsFound, emailsFetched, credits, foundToday, maxDailyFetchLimit, maxSingleFetchLimit, filterData?, fetchedAt }`, with `filterId` validated against `^[0-9]+$`.
- The fetch route from the fetch-contacts work reads these figures before issuing a fetch and refuses a request exceeding `maxSingleFetchLimit` or the remaining daily allowance with a 422 stating the cap — the client-side cap is a convenience, the server-side one is the guarantee.
- `percentageChangeText` is passed through untouched; a comment records that Harry must not recompute it, since the provider's month boundaries are undocumented.
- Cache: minutes per workspace with `fetchedAt` returned; the cache is invalidated immediately after any fetch, since a fetch changes the credit balance.
- Data model: none. These figures are never written into Harry's own reporting tables, because mixing a provider's account metrics with Harry's outreach funnel would corrupt numbers the product currently derives from real messages.
- Rate limiting and retry: one retry on 5xx with backoff; a 429 is served from cache.
- Logged: `telemetry` per upstream call with latency and status, a snapshot of remaining credits so Monitoring can warn before they run out, and a flag when `trend` disagrees with the month figures.

**Definition of done**
- [ ] Route added, workspace-scoped, `filterId` validated, provider key server-side only.
- [ ] The fetch route enforces both caps server-side, covered by tests.
- [ ] The analytics cache is invalidated by a fetch, covered by a test.
- [ ] Credit levels reach Monitoring so a workspace can be warned before it is blocked.
- [ ] No provider figure is written into Harry's own reporting tables.

## 6. End-to-end test ticket

**Title:** E2E — See credits and limits before fetching contacts

**Preconditions:** A stubbed provider serving the documented search-analytics payload, one saved search, and stub modes for zero credits, for a near-exhausted daily allowance, and for a 500.

**Flow**
1. Open Leads → "Find prospects" and read the figures row in the panel header.
2. Expand a saved search and read its per-filter figures.
3. Open the fetch dialog and read the credits and caps strip.
4. Try to enter a count above the single-fetch cap.
5. Switch the stub to a near-exhausted daily allowance and reopen the dialog.
6. Switch to zero credits, then to a 500.
7. Complete a real fetch and reopen the dialog.

**Assertions**
- [ ] The header figures show the provider's change text verbatim for both leads found and emails fetched.
- [ ] Per-filter figures are attributed to the saved search by name and are absent when no `filter_id` was sent.
- [ ] The count field will not accept a value above `maxSingleFetchLimit`, and states the cap.
- [ ] With the near-exhausted allowance, the cap drops to the remaining daily amount and the dialog says so.
- [ ] With zero credits the fetch action is disabled with a stated reason and no request is sent.
- [ ] With the stub at 500 the dialog still opens, caps conservatively and explains why.
- [ ] After a real fetch, reopening the dialog shows a reduced credit balance, proving the cache was invalidated.

**Teardown:** Clear the analytics cache; restore the stub's credit balance.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects fetch dialog | A credits and caps strip constraining the count field | Low | Three short figures directly above the field they govern — this is the moment they matter, and showing them anywhere else would be decoration |
| Leads → Find prospects panel header | A month-on-month figures row | Medium | One row of two figures; it is the only always-visible part and can be collapsed once a user stops caring about it |
| Saved search rows | Per-filter found and fetched figures on expand | Low | Two numbers inside a row that already expands |
| Monitoring | Credit-level snapshots and provider latency | Low | Rows in existing telemetry tables |

**Verdict:** Fits an existing surface

The valuable half of this endpoint is the limits, and limits belong beside the field they constrain — exactly as Harry already shows a mailbox's remaining daily send allowance where sending is decided. The month-on-month figures are the decorative half, so they get one quiet row and stay out of Reports, where they would be mistaken for outreach results.
