# Domain API

| | |
|---|---|
| **Endpoint** | `GET https://prospect-api.smartlead.ai/api/v1/search-email-leads/domain` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/domain |
| **Auth** | API key (query param `api_key`) |

Lists company web domains known to the prospect database, so a search can be pinned to exact organisations by their website rather than by name.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner with a target account list exported from a CRM, **I want** to filter prospects by company domain, **so that** "Acme" means the one company I mean and not the four others sharing the name.

**Acceptance criteria**
- [ ] Given a valid API key, when I request domains, then I get 200 with `success: true` and `data` as an array of `{ domain_name }` objects, for example `{ "domain_name": "acme.com" }`.
- [ ] Given the documented response, when I build the UI, then I do not depend on an id or a `pagination` object — like the company lookup and unlike the city and country lookups, this endpoint documents neither, so the domain string is the key and "has more" is inferred from the page being full.
- [ ] Given no `limit` is supplied, when the request runs, then the documented default of 100 applies.
- [ ] Given a user pastes a list of domains, when each is checked against the lookup, then unknown domains are reported back rather than dropped, so nobody believes they targeted an account that the provider does not cover.
- [ ] Given a domain that already appears on a lead in this workspace, when results render, then it is marked "already in your leads", because domain is the most reliable dedupe key Harry has for a company.
- [ ] Given nothing matches, when the request runs, then 200 with `data: []` and the picker shows "No domains match that".
- [ ] Given the API key is missing or wrong, when the request runs, then 401 with `{"success": false, "message": "Unauthorized"}` and a single "Prospect search is not connected" message linking to Settings.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `/domain?api_key=VALID` | 200, `data` array of `{ domain_name }`; up to 100 rows given the documented default |
| TC-2 | Missing/invalid API key | GET `/domain` with no `api_key` | 401, `"error": "User not authenticated"`; one banner in the UI |
| TC-3 | Not found / wrong workspace | Call with another account's key | Results scoped to that account; Harry's cache is per workspace |
| TC-4 | Validation failure | GET `/domain?api_key=VALID&limit=-1` | Rejected; Harry validates and falls back to the default before calling upstream |
| TC-5 | Rate limited | Paste 400 domains and check each with its own request | 429 on the excess; Harry batches the checks and backs off with jitter, showing one progress indicator |
| TC-6 | Empty result set | GET `search=notarealdomain` | 200, `data: []`; "No domains match that", with an option to keep it as free text |
| TC-7 | No pagination block | Inspect the 200 body | No `pagination` key is documented; "has more" is derived from `data.length === limit` |
| TC-8 | Subdomain and www forms | Search `www.acme.com` and `mail.acme.com` | Harry normalises to the registrable domain before searching and says so in the UI, so the user is not told a real company is unknown |
| TC-9 | Dedupe against existing leads | Search a domain that matches three existing leads | Row is marked "already in your leads (3)" and is excluded from any fetch by default |
| TC-10 | Upstream 500 | Force a provider 500 | "Could not load domains just now"; pasted list is preserved for retry |

## 4. Frontend user story

**As a** goal owner, **I want** to paste a list of company websites into Harry's prospect search, **so that** an account list I already have becomes a search in one step.

**Scope**
- Leads → "Find prospects": a "Company domains" field in the companies group, with typeahead and a "Paste domains" textarea that accepts one per line or comma-separated.
- After a paste, a small reconciliation list shows three groups: matched, unknown to the provider, and already in your leads — each with a count and a way to keep or drop the whole group.
- Goals → goal detail, "Refine the audience": the same field, so an account-based goal can be described by domains.
- State: domains normalised client-side (lowercase, strip `www.` and protocol) before checking; progress shown as "checked 120 of 400" during a large paste; chips for the kept domains.
- Empty state "No domains match that" with a keep-as-typed option. Error state preserves the pasted text so nothing is retyped.
- Accessibility: the reconciliation groups are a labelled list with counts as text; progress is announced in a live region; chips are keyboard-removable. Responsive: the textarea and reconciliation list stack under 640px.

**Definition of done**
- [ ] Pasting a list of domains produces the three reconciliation groups with accurate counts.
- [ ] Normalisation of `www.`, protocol and trailing slash is applied before checking and is visible to the user.
- [ ] Large pastes show progress and never fire one request per domain without batching.
- [ ] Loading, empty, error and partially-checked states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied domain lookup with batch reconciliation, **so that** a pasted account list is resolved server-side in a few calls rather than hundreds from the browser.

**Scope**
- Routes in `server/routes.js`: `GET /api/prospects/filters/domains?search=&limit=&offset=` for typeahead, and `POST /api/prospects/filters/domains/reconcile` taking `{ domains: [] }` and returning `{ matched: [], unknown: [], existing: [] }`.
- Reconciliation normalises each domain, deduplicates, checks the workspace `leads` table for existing matches, and queries the provider for the remainder in batches with a cap on list size (documented in the route, with a clear 422 when exceeded).
- Because the documented response has no `pagination` object, `hasMore` is derived from `data.length === limit`; this is stated in the route so nobody later assumes a count exists.
- Provider credentials env-gated as in `server/google.js`; unconfigured returns the "not configured" payload.
- Retry on 429 and 5xx with bounded exponential backoff and jitter; short in-process cache keyed by normalised domain.
- Data model: none required for the lookup. If domain-based dedupe is adopted more widely, an index on the existing `leads` company-domain column is the only change.
- Logged: `telemetry` per upstream call and per reconcile batch (size, matched/unknown/existing counts, latency); an `events` row when a reconciled list is turned into a saved search, since that is a user action worth auditing.

**Definition of done**
- [ ] Both routes added and workspace-scoped, provider key server-side only.
- [ ] Normalisation and dedupe covered by tests including `www.`, protocol, uppercase and trailing slash.
- [ ] Batch size cap enforced with a 422 that names the limit.
- [ ] Reconcile counts appear in `telemetry` for Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Turn a pasted account list into a prospect search

**Preconditions:** A stubbed provider serving the documented domain payload and knowing three of five test domains, a workspace with one lead already at `acme.com`, and one goal.

**Flow**
1. Open Leads → "Find prospects" and expand the companies group.
2. Paste five domains in mixed formats, including `https://www.Acme.com/` and one the stub does not know.
3. Review the reconciliation groups.
4. Drop the unknown group and keep the rest.
5. Save the search draft, reload, and open the same field from the goal's "Refine the audience".

**Assertions**
- [ ] `https://www.Acme.com/` is normalised to `acme.com` and shown under "already in your leads", with the normalisation visible.
- [ ] The unknown domain is listed by name, not silently dropped.
- [ ] Dropping the unknown group removes exactly one chip.
- [ ] After reload the kept chips are intact, and the goal's field shows the same set.
- [ ] With the stub stopped mid-paste, the pasted text and progress are preserved and a retry finishes the job.

**Teardown:** Discard the search draft; clear the domain cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects | Domains field plus a paste-and-reconcile flow | Medium | The textarea is behind a "Paste domains" link; the default view is a single typeahead field |
| Leads list | "Already in your leads" marker on prospect results | Low | Text badge on existing rows, no new column |
| Goals → goal detail | Same field in "Refine the audience" | Low | Reuses the Leads component |
| Monitoring | Reconcile batch stats in provider telemetry | Low | One more row in an existing table |

**Verdict:** Fits an existing surface

Harry already imports leads from CSV with column mapping and dedupe, and pasting domains is the same act at company level, so it belongs in the same part of the product rather than a new one. The reconciliation list is the only new pattern, and it exists to prevent the silent failure of thinking you targeted an account you did not. No navigation item is added.
