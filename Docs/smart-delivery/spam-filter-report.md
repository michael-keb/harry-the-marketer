# Spam Filter Report

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/spam-filter-details` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/spam-filter-report |
| **Auth** | API key (query param `api_key`) |

Says which spam filters flagged your email and the reasons they gave.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation note.** The published examples disagree on method — cURL and Python use GET, the JavaScript sample uses POST — and all attach an empty body. This is a read, so the story treats it as a GET and keeps the method inside one adapter function.

## 2. User story

**As a** marketer whose email landed in spam, **I want** to know which filter caught it and why, **so that** I can change the email instead of guessing.

**Acceptance criteria**
- [ ] Given a completed test, when I open the spam filter report, then I get one group per `from_email`, each with a `spam_filter_details` array carrying `filter`, `triggered_count`, `trigger_percentage` and `reasons`.
- [ ] Given a filter entry, when it renders, then each string in `reasons` is shown as its own line ("High spam score", "Missing DKIM signature") rather than joined into a sentence.
- [ ] Given a reason names an authentication problem, when it renders, then it links to the matching row in the Authentication section rather than repeating the diagnosis.
- [ ] Given `triggered_count` and `trigger_percentage`, when they render, then both are shown, because 5 of 100 and 5% mean the same thing to different readers.
- [ ] Given no filter was triggered for a sending address, when it renders, then the group reads "No spam filters triggered" rather than being omitted, so an absent group cannot be mistaken for a missing result.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no spam filter results are available yet, never a clean verdict.
- [ ] Given a reason relates to the email's wording, when it renders, then the report links to the campaign's `Send:` node that produced the tested email, so the fix happens in the playbook.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch spam filter details for a completed test | 200; two groups — `campaigns@example.com` with SpamAssassin (5, 5.0%) and Gmail Spam Filter (3, 3.0%), `support@example.com` with Outlook Junk Filter (2, 2.0%) |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing rendered |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the report every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch a test whose seeds are undelivered | 200 with `[]`; "No spam filter results yet"; never "no filters triggered" |
| TC-7 | Reasons rendered individually | The SpamAssassin entry with two reasons | Two separate lines; the DKIM reason links to the Authentication section's DKIM row |
| TC-8 | Empty reasons array | A filter entry with `reasons: []` | The filter and its counts still render, with "No reason given" rather than a blank cell |
| TC-9 | Unknown filter name | A filter not in the documented set | Rendered verbatim; no attempt to map it to a friendly name or an advice string that might be wrong |
| TC-10 | Upstream unavailable | Provider returns 503 | "Spam filter analysis is temporarily unavailable"; last known result kept with a timestamp; retried on the next tick |

## 4. Frontend user story

**As a** marketer, **I want** the spam filter reasons written plainly and linked to where I would fix them, **so that** the report ends in an action rather than a diagnosis.

**Scope**
- Monitoring → Deliverability report detail: a "Spam filters" section, one group per sending address, each listing the filters triggered with their counts and reasons.
- Each reason carries a destination where one exists: authentication reasons link to the Authentication section, reputation reasons to the blocklist and IP panels, content reasons to the campaign's `Send:` node in the campaign editor.
- Campaigns → campaign editor: a `Send:` node whose tested email triggered a content-related filter shows a quiet note linking back to the report — this is the one place the deliverability data reaches the playbook.
- Loading: skeleton rows. Empty: "No spam filter results yet." No triggers: "No spam filters triggered" as an explicit positive. Error: last result with a staleness note.
- Accessibility: reasons are a real list; filter names and counts are text; the section is readable without any severity styling. Responsive: groups stack under 640px with the address as the heading.

**Definition of done**
- [ ] Every reason string is rendered individually and verbatim.
- [ ] Reasons link to the section that would fix them, with no duplicated explanation.
- [ ] "No filters triggered" is stated explicitly rather than implied by absence.
- [ ] Loading, empty, no-trigger, unknown-filter and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** spam filter results fetched, cached and classified by reason type, **so that** the UI can link each reason somewhere useful.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/spam-filters`, workspace-scoped, returning the grouped shape plus a `reasonType` per reason (`authentication`, `reputation`, `content`, `unknown`).
- Data model: a `deliverability_spam_filters` table in `server/db.js` (`test_id`, `from_email`, `filter`, `triggered_count`, `trigger_percentage`, `reasons` as JSON, `fetched_at`).
- Reason classification is a small keyword map applied server-side, defaulting to `unknown` so an unrecognised reason still renders with no link rather than a wrong one. The raw reason string is always returned unchanged alongside the classification.
- The adapter owns the HTTP method, since the documented samples disagree; it uses GET and falls back once to POST on a 405, recording which worked.
- No pagination. Refresh throttled per test; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a content-type reason first appears for a campaign, since that is the one the user can actually act on; `telemetry` records unclassified reason strings so the keyword map can be improved from real data.

**Definition of done**
- [ ] Raw reason strings are never rewritten, only classified alongside.
- [ ] An unknown reason yields `unknown` and no link, covered by a test.
- [ ] Route is workspace-scoped and 404s on another workspace's test.
- [ ] Unclassified reasons are counted in telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Turn a spam filter result into a playbook edit

**Preconditions:** A workspace with two sandbox mailboxes, one campaign whose first `Send:` node produced the tested email, and a completed test fixture returning the documented spam filter body.

**Flow**
1. Open Monitoring → Deliverability and choose the fixture report.
2. Open the "Spam filters" section.
3. Read the SpamAssassin entry under `campaigns@example.com`.
4. Follow the "Missing DKIM signature" reason.
5. Return and follow a content reason to the campaign editor.
6. Open the campaign editor's `Send:` node.

**Assertions**
- [ ] Both reasons appear as separate lines, worded exactly as returned.
- [ ] Counts appear as both a number (5) and a percentage (5.0%).
- [ ] The DKIM reason lands on the Authentication section's DKIM row for the same test.
- [ ] The content reason lands on the campaign editor with the relevant `Send:` node in view.
- [ ] The `Send:` node shows a quiet note linking back to the report, and it disappears once a later test triggers no content reason.

**Teardown:** Delete the fixture test and its cached spam filter rows; the campaign note must clear automatically.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | "Spam filters" section grouped by sending address | Medium | Reasons link out instead of explaining in place, so the section stays short |
| Campaigns → campaign editor | Quiet note on a `Send:` node with a content-related trigger | Medium | Conditional, one line, and it clears itself; it is the only place deliverability data touches the playbook |

**Verdict:** Fits an existing surface

This is the one report in the category whose conclusion is usually "change the email", so it earns a small footprint in the campaign editor — the place that change actually happens. Everything else links rather than repeats, which keeps a report of five sections from becoming five explanations of the same DKIM problem. No new navigation item.
