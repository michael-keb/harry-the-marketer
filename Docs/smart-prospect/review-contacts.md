# Review Contacts API

| | |
|---|---|
| **Endpoint** | `PATCH https://prospect-api.smartlead.ai/api/v1/search-email-leads/review-contacts/{filter_id}` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/review-contacts |
| **Auth** | API key (query param `api_key`) |

Re-checks the contacts belonging to one saved search and returns updated counts of how many have usable, invalid or catch-all email addresses.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner whose fetched list is a few weeks old, **I want** to refresh the email-quality figures for that list, **so that** I do not send to addresses that have gone bad since I bought them.

**Acceptance criteria**
- [ ] Given a saved search, when I trigger a review, then the request is a `PATCH` to `/review-contacts/{filter_id}` carrying only `api_key` as a query parameter — the endpoint documents no request body at all.
- [ ] Given `filter_id` must match `^[0-9]+$`, when a non-numeric id is supplied, then Harry rejects it before calling rather than letting the provider return a 400.
- [ ] Given a successful review, when the response arrives, then `data` carries `filter_id`, `records_updated` and a `fetch_details` object.
- [ ] Given `fetch_details`, when the summary renders, then it shows `leads_found`, `email_fetched` and the nested `metrics` — `totalContacts`, `totalEmails`, `noEmailFound`, `invalidEmails`, `catchAllEmails`, `verifiedEmails`, `completed`.
- [ ] Given `fetch_details` also returns `catch_all_status_list` and `verification_status_list` — arrays such as `["catch_all_verified", "catch_all_unknown"]` and `["valid", "invalid"]` — when the contacts view renders, then those arrays drive the available quality filters, rather than a hardcoded set.
- [ ] Given `records_updated` is returned, when the review completes, then the UI states how many records changed; a review that updates zero records is reported as "nothing changed", not as a failure.
- [ ] Given the documented 404, when the `filter_id` does not exist or belongs to another account, then Harry shows "That saved search is not available" and returns the user to the search list.
- [ ] Given a review changes an address's verification status, when a Harry lead was created from that contact, then the lead's stored verification status is updated too, so the Inbox approval card shows current information — the docs do not say whether the email itself can change, so Harry updates status only and says so.
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message with a link to Settings and nothing is updated.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PATCH `/review-contacts/327105?api_key=VALID` | 200, `message` reads "Contacts reviewed successfully", `data.records_updated` is a number, `fetch_details.metrics` fully populated |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; no lead is updated |
| TC-3 | Not found / wrong workspace | PATCH a `filter_id` from another account | 404; "That saved search is not available"; the user is returned to the search list and nothing is written |
| TC-4 | Validation failure | PATCH `/review-contacts/abc` | Fails the documented `^[0-9]+$` pattern; Harry rejects it client-side with a field-level message and never calls upstream |
| TC-5 | Rate limited | Trigger reviews on several searches at once | 429 on the excess; Harry serialises reviews per workspace and shows "Waiting to review…" rather than an error |
| TC-6 | Empty result set | Review a filter whose contact list is empty | 200 with zeroed metrics and `records_updated: 0`; the UI reads "Nothing to review in this list" |
| TC-7 | Nothing changed | Review twice in quick succession | The second returns `records_updated: 0`; the UI says "No changes since the last review" rather than showing a success that implies work was done |
| TC-8 | Status lists drive the filters | Serve `verification_status_list: ["valid"]` only | The contacts view offers only "valid" as a verification filter, proving the filter options come from the response and are not hardcoded |
| TC-9 | Quality got worse | Review a list where `invalidEmails` rises | The UI shows the change against the previous review, and any Harry leads created from newly invalid contacts are flagged before their next approval |
| TC-10 | Bad Request | Force the documented 400 | Surfaced with the provider's message; no partial lead updates are written |
| TC-11 | Upstream 500 mid-review | Force a 500 | The previous review's figures remain on screen, clearly dated, and a retry is offered |
| TC-12 | Concurrent review | Trigger the same review twice at once | The second is coalesced onto the first rather than issuing two PATCHes |

## 4. Frontend user story

**As a** goal owner, **I want** a "Re-check this list" action on a fetched search, **so that** I can see whether its email quality has decayed before I attach those leads to a campaign.

**Scope**
- Leads → "Find prospects" → History → a fetched search: a "Re-check email quality" action, with the last review's date shown beside it so staleness is visible without clicking.
- After a review, the metrics panel updates in place and shows what moved since the previous review, using the same seven metric names in plain English.
- The contacts table's verification and email-risk filters are populated from `verification_status_list` and `catch_all_status_list` rather than a hardcoded list, so the options always match the data.
- A short banner appears when the review downgrades any address that already became a Harry lead: "3 leads now have an address that failed verification", linking to those leads.
- State: the action is disabled while a review runs and shows progress; on failure the previous figures stay visible with their date; `records_updated: 0` is presented as "no changes", not as an error or a silent success.
- Accessibility: the action is a button with an accessible busy state, metric changes are described in text ("invalid addresses up from 8 to 10") rather than by colour, and the banner is a live region. Responsive: the metrics panel stacks under 640px.

**Definition of done**
- [ ] Re-check runs, updates the metrics panel in place and shows the delta since the last review.
- [ ] Quality filters are driven by the response's status lists.
- [ ] Downgraded leads are flagged with a link to them.
- [ ] Zero-change reviews read honestly.
- [ ] Loading, empty, unchanged and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a review route that records each review and reconciles the result onto existing leads, **so that** an address that has gone bad cannot quietly sit in an approval queue.

**Scope**
- Route in `server/routes.js`: `PATCH /api/prospects/searches/:filterId/review`, taking no body, validating `filterId` against `^[0-9]+$` and the workspace's ownership of that search before calling upstream.
- Response handling: store `records_updated` and the whole `fetch_details` block against the local `prospect_fetches` row, so the previous review's figures survive for a delta.
- Reconciliation: for contacts already imported as leads, update `email_verification_status`; the docs do not state that the address itself changes, so the email field is left alone and this restriction is written into the code comment. Leads whose status worsens are flagged so the Inbox approval card can warn before a send is approved.
- Concurrency: reviews are serialised and coalesced per `(workspace, filterId)` so a double click issues one PATCH.
- Data model: `prospect_fetches` gains `last_reviewed_at` and `last_review_json`; `leads` reuses the `email_verification_status` column introduced by the email-finder work. No new table.
- Rate limiting and retry: 429 and 5xx retried with bounded exponential backoff and jitter; a 404 is never retried.
- Logged: an `events` row per review naming who ran it, the search, `records_updated` and how many leads were flagged; `telemetry` per upstream call with latency, status and the metric deltas so Monitoring can chart list decay.

**Definition of done**
- [ ] Route added, workspace-scoped, `filterId` pattern validated before any upstream call.
- [ ] Previous review figures are retained so a delta can be shown, covered by a test.
- [ ] Lead email addresses are provably never modified by a review; only status is.
- [ ] Downgraded leads are flagged and visible on the approval card.
- [ ] Double-click coalescing covered by a test asserting one upstream PATCH.

## 6. End-to-end test ticket

**Title:** E2E — Re-check a fetched list's email quality before sending

**Preconditions:** A stubbed provider serving the documented review payload, one fetched search whose contacts produced 20 Harry leads, one lead currently sitting in Inbox → Needs your OK, and a stub mode where that lead's contact becomes invalid on review.

**Flow**
1. Open Leads → "Find prospects" → History and open the fetched search.
2. Note the last-reviewed date and the current metrics.
3. Click "Re-check email quality".
4. Read the updated metrics and the delta.
5. Follow the downgrade banner to the affected leads.
6. Open Inbox → Needs your OK for the affected lead.
7. Click re-check again immediately.

**Assertions**
- [ ] The metrics panel updates in place and states what moved since the previous review.
- [ ] The verification and email-risk filters offer exactly the values in the response's status lists.
- [ ] The banner names the count of downgraded leads and links to them.
- [ ] The affected lead's approval card warns that its address failed verification, before anyone can approve the send.
- [ ] The lead's email address itself is unchanged; only its status moved.
- [ ] The immediate second re-check reports "no changes" and issues one PATCH, not two.
- [ ] The activity trail records the review with `records_updated`.

**Teardown:** Reset the stub's verification statuses; delete the test leads; clear `last_review_json` for the fetch.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects → History | A "Re-check email quality" action plus a last-reviewed date and a metric delta | Medium | One button on a panel that already shows metrics; the delta replaces the static numbers rather than adding a second block |
| Inbox → Needs your OK | A warning on the approval card when an address failed its latest verification | Low | One line, at exactly the moment a human decides to send — the most valuable place in the product for this information |
| Leads | A flag on leads whose address was downgraded | Low | Reuses the existing needs-attention pattern |
| Monitoring | List-decay telemetry | Low | Rows in an existing table |

**Verdict:** Fits an existing surface

Re-checking a list is a maintenance action on a list that already has a home, so it belongs on that list's panel. The genuinely important change is the warning on the approval card: Harry's whole promise is that a human sees the email before it goes, and knowing the address just failed verification is part of what that human should see.
