# Reply Analytics API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/reply-analytics` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/reply-analytics |
| **Auth** | API key (query param `api_key`) |

Returns how many replies were received this month against last month, with the percentage change and whether it is going up or down.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

**Note on the source documentation.** This endpoint's page is thin: it documents no parameters beyond `api_key`, no date range, no way to scope the figures, and it does not say which replies are being counted or how a "month" is bounded. The story below is deliberately scoped to what is documented, and every gap is called out rather than filled in with an assumption.

## 2. User story

**As a** goal owner who has started sourcing prospects from a data provider, **I want** to see whether replies to my outreach are rising or falling month on month, **so that** I can tell whether the prospects I am buying are worth buying.

**Acceptance criteria**
- [ ] Given a valid API key, when I request reply analytics, then I get 200 with `data.currentMonth.replied`, `data.previousMonth.replied`, `data.percentage_change` (a preformatted string such as `"+25%"`) and `data.trend` (a word such as `"increase"`).
- [ ] Given `percentage_change` arrives as a preformatted string with its own sign and percent symbol, when it renders, then Harry displays it verbatim and does not reformat, round or recompute it.
- [ ] Given `trend` is a word, when it renders, then only the values actually observed are styled; any unrecognised value is shown as plain text rather than mapped to an arrow that might point the wrong way.
- [ ] Given the endpoint takes no parameters at all, when the figure is shown, then the UI must not offer a date range, a campaign filter or a comparison period, because none of those are supported.
- [ ] Given the documentation does not say which replies are counted or how the month boundary is drawn, when the figure is shown, then it is labelled as the provider's own count with its source named — it is never merged into, or compared against, Harry's own reply numbers in Reports, which are derived from real Gmail threads.
- [ ] Given a month with no replies at either end, when the response arrives, then zeros render as "0 replies" with the change shown as whatever the provider returns, and no division is attempted by Harry.
- [ ] Given a 401, when the request runs, then Harry shows "Prospect analytics are not connected" in the panel and the rest of Reports is unaffected.
- [ ] Given the provider is unreachable, when the panel loads, then the panel shows an inline "unavailable" state and never blocks Reports from rendering.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/reply-analytics?api_key=VALID` | 200 with `currentMonth.replied`, `previousMonth.replied`, `percentage_change`, `trend` |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; the panel shows "not connected" and Reports still renders |
| TC-3 | Not found / wrong workspace | Call with another account's key | Figures belong to that account only; Harry caches per workspace so no figure leaks between them |
| TC-4 | Validation failure | GET with an unexpected query parameter such as `?month=2025-01` | The parameter is ignored by the provider; Harry never sends one, and a test asserts the outgoing URL carries only `api_key` |
| TC-5 | Rate limited | Reload Reports repeatedly | 429 on the excess; the figure is cached for at least an hour, so reloads make no upstream call |
| TC-6 | Empty result set | Serve zeros for both months | "0 replies this month, 0 last month"; whatever `percentage_change` the provider sends is shown verbatim, and Harry computes nothing |
| TC-7 | Preformatted change string | Serve `percentage_change: "-12.5%"` | Rendered exactly as `-12.5%`; no rounding, no re-signing |
| TC-8 | Unrecognised trend value | Serve `trend: "flat"` | Shown as plain text with no arrow, proving the UI does not guess a direction |
| TC-9 | Contradictory payload | Serve `currentMonth.replied` lower than `previousMonth.replied` with `trend: "increase"` | Both are shown as received; Harry does not silently correct the provider, and telemetry records the mismatch for Monitoring |
| TC-10 | Upstream 500 | Force a provider 500 | The panel shows "Reply figures unavailable just now"; every other Reports section renders normally |
| TC-11 | Provider not configured | Remove the provider key | The panel does not render at all, matching how Harry hides other unconfigured integrations |

## 4. Frontend user story

**As a** goal owner, **I want** one small provider-sourced reply figure inside Reports, **so that** I can see it without believing it is the same number Harry measures itself.

**Scope**
- Reports: a single compact card in the existing rates area, headed with the provider's name, showing this month's replies, last month's, the change string and the trend word.
- The card carries one line of provenance: it states that the figure comes from the prospect data provider and that the documentation does not specify which replies it counts. Harry's own reply rate — derived from real Gmail threads — stays where it is and is never averaged with this.
- No controls. The endpoint takes no parameters, so the card offers no date picker, no campaign filter and no comparison selector.
- State: cached hourly; a skeleton card while loading; an inline "unavailable" state on error; the card is absent entirely when no provider key is configured.
- Accessibility: figures as text with the change string read alongside its label, trend as a word rather than colour or an arrow alone. Responsive: the card sits in the existing responsive grid and stacks under 640px.

**Definition of done**
- [ ] The card shows all four documented fields, with `percentage_change` verbatim.
- [ ] Provenance line is present and names the source and the documentation gap.
- [ ] The card never appears when the provider is unconfigured, and never blocks Reports when it fails.
- [ ] Loading, zero, error and unrecognised-trend states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a cached passthrough for the provider's reply figures, **so that** a parameterless upstream call is made rarely and its failure can never break Reports.

**Scope**
- Route in `server/routes.js`: `GET /api/prospects/reply-analytics` returning `{ currentMonth, previousMonth, percentageChange, trend, fetchedAt }`. No parameters are accepted, because none exist upstream.
- The `percentage_change` string is passed through untouched; a comment records that Harry must not recompute it, since the provider's month boundaries are undocumented.
- Cache: at least an hour per workspace, with `fetchedAt` returned so the card can say how fresh the figure is.
- Failure handling: the route never throws into the Reports response. Reports composes this section optionally, exactly as it already tolerates a missing AI key.
- Data model: none. No figure from this endpoint is written into Harry's own `messages` or reporting tables, because mixing a provider's undocumented count with Harry's derived reply rate would corrupt a number the product currently guarantees.
- Rate limiting and retry: one retry on 5xx with backoff; a 429 is served from cache instead.
- Logged: `telemetry` per upstream call with latency and status, plus a flag when `trend` disagrees with the two month figures, so Monitoring can show that the provider's numbers are internally inconsistent.

**Definition of done**
- [ ] Route added, workspace-scoped, parameterless, provider key server-side only.
- [ ] A test asserts the outgoing request carries only `api_key`.
- [ ] A failing upstream call leaves the rest of Reports fully rendered, covered by a test.
- [ ] No provider figure is written into Harry's own reporting tables.

## 6. End-to-end test ticket

**Title:** E2E — Show the provider's reply trend in Reports without contaminating Harry's own numbers

**Preconditions:** A stubbed provider serving the documented reply-analytics payload, a workspace with real sandbox campaign activity so Harry's own reply rate is non-zero, and stub modes for 500 and for a contradictory payload.

**Flow**
1. Open Reports and locate the provider card.
2. Compare the provider figure with Harry's own reply rate elsewhere on the page.
3. Reload Reports three times.
4. Switch the stub to return a contradictory payload.
5. Switch the stub to 500.
6. Remove the provider key and reload.

**Assertions**
- [ ] The card shows both month figures, the change string verbatim and the trend word.
- [ ] Harry's own reply rate is unchanged by the presence of the card, and the two numbers are visibly labelled as different sources.
- [ ] Three reloads produce at most one upstream call, per the stub counter.
- [ ] The contradictory payload renders as received and raises a Monitoring telemetry flag.
- [ ] With the stub at 500 the card shows "unavailable" and every other Reports section renders.
- [ ] With no provider key the card is absent entirely.

**Teardown:** Clear the reply-analytics cache; restore the provider key.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | One compact provider card in the existing rates area | Medium | It is one card with no controls, and it is absent unless a provider is configured; the risk is confusion with Harry's own reply rate, which the provenance line addresses directly |
| Monitoring | Provider latency and an inconsistency flag | Low | Rows in existing telemetry tables |

**Verdict:** Fits an existing surface

Reports is already where reply rates live, so a second, externally sourced reply figure belongs there or nowhere. Because the documentation does not say what this number counts, the card's most important element is the line saying so — a figure whose meaning is unknown is worth showing only if its uncertainty is shown with it.
