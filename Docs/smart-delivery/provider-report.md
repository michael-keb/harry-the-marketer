# Provider-wise Report

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/providerwise` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/provider-report |
| **Auth** | API key (query param `api_key`) |

Breaks a deliverability test down by receiving email provider, so you can see that Gmail takes your mail but Outlook files it as spam.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The request body is documented as an empty object (`{}`) and only `api_key` is published; this endpoint is behind SmartLead support access. The story is grounded in the documented **200 response** — `overallTotalCount`, `status`, and a `result` array per provider — and treats the body as opaque until the provider confirms it.

## 2. User story

**As a** marketer whose prospects are mostly on Outlook, **I want** placement broken down by receiving provider, **so that** I know whether my problem is with the provider my buyers actually use.

**Acceptance criteria**
- [ ] Given a completed test, when I open the provider report, then I get `overallTotalCount`, `status` and a `result` array where each row has `provider`, `inbox_rate`, `spam_rate`, `bounce_rate`, `mailbox_count` and `avg_delivery_time_seconds`.
- [ ] Given `status` is not `completed`, when the view renders, then figures are labelled partial and no verdict sentence is generated.
- [ ] Given `avg_delivery_time_seconds`, when it renders, then it is shown in plain words ("delivered in about 45 seconds"), because a slow provider is a throttling signal even when placement looks fine.
- [ ] Given one provider's `inbox_rate` is materially below the others, when the view renders, then a summary sentence names it and states the gap in points, rather than leaving the comparison to the reader.
- [ ] Given `mailbox_count` varies by provider, when rates render, then the count sits beside each rate so a small sample is not over-read.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given `result` is empty, when it renders, then the panel shows an empty state with `overallTotalCount` and the status, and draws no chart.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST the providerwise route for a completed test | 200; `status: "completed"`, `overallTotalCount: 900`, three rows: Gmail 94.2, Outlook 88.5, Yahoo 89.1, with counts 350 / 310 / 240 and delivery times 45 / 52 / 48 |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing rendered |
| TC-3 | Test not found / wrong workspace | POST with another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | POST a body the provider rejects | 422 `{"error": "Invalid parameters provided"}`; the client falls back to `{}` and logs the rejected body to telemetry |
| TC-5 | Rate limited | Poll the report every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | POST for a test with no delivered seeds | 200 with `result: []`; "No provider results yet" plus the status; no chart drawn |
| TC-7 | Still running | `status: "running"` with two of three providers present | Figures labelled partial; the missing provider shows as pending, not 0% |
| TC-8 | Weakest provider named | The documented data set | The summary names Outlook as weakest at 88.5, about 5.7 points below Gmail |
| TC-9 | Slow delivery | A provider with `avg_delivery_time_seconds: 600` | The row is noted as unusually slow even though its inbox rate may be high, with the figure in words |
| TC-10 | Upstream unavailable | Provider returns 503 | "Provider breakdown is temporarily unavailable"; last known figures kept with a timestamp; retried on the next tick |

## 4. Frontend user story

**As a** marketer, **I want** a by-provider table beside the by-region table in the deliverability report, **so that** I can tell a provider problem from a geography problem.

**Scope**
- Monitoring → Deliverability report detail: a "By provider" section with one row per `provider` showing inbox, spam and bounce rates, mailbox count and average delivery time, plus a summary sentence naming the weakest provider.
- It sits directly beneath "By region" and shares its layout, so the two breakdowns read as one idea seen two ways.
- Reports: the existing per-campaign rates gain a link to this section when the campaign has a completed test, rather than a duplicate table.
- Loading: skeleton rows. Empty: "No provider results yet." Partial: figures with a "test still running" label. Error: last figures with a staleness note.
- Accessibility: a real table with caption and scoped headers, readable without any bar visualisation; delivery time is given in words as well as seconds. Responsive: scrolls inside its own container under 640px; the page never scrolls horizontally.

**Definition of done**
- [ ] Every documented field appears, including `avg_delivery_time_seconds`.
- [ ] The summary sentence is generated from the data and names the actual weakest provider with the gap.
- [ ] By-provider and by-region share one component, not two similar ones.
- [ ] Loading, empty, partial, error and small-sample states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving the by-provider breakdown, **so that** the report and Reports read the same figures.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/providers` (the upstream POST lives in the adapter), workspace-scoped.
- Data model: a `deliverability_provider_results` table in `server/db.js` (`test_id`, `provider`, `inbox_rate`, `spam_rate`, `bounce_rate`, `mailbox_count`, `avg_delivery_time_seconds`, `status`, `overall_total_count`, `fetched_at`) sharing its shape with the region table so one component can render both.
- No pagination — providers number in single digits. Refresh throttled while `status` is not `completed`, cached permanently once it is; upstream 429 and 503 back off with jitter.
- One adapter owns the POST body; it sends `{}` and logs any 422 with the body sent, so the real contract is discovered from telemetry rather than guessed.
- Logged: an `events` row when a completed test shows a provider below the benchmark Monitoring already grades against; `telemetry` records latency, 422 bodies and per-provider inbox rates.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] Provider and region results are stored in the same shape and rendered by one component.
- [ ] Rates are stored as numbers and rendered without recomputation.
- [ ] A below-benchmark provider on a completed test writes exactly one event.

## 6. End-to-end test ticket

**Title:** E2E — Diagnose a provider-specific placement problem

**Preconditions:** A workspace with a completed placement test fixture returning the documented provider body (Gmail 94.2, Outlook 88.5, Yahoo 89.1) and a campaign linked to that test whose leads are mostly on Outlook.

**Flow**
1. Open Monitoring → Deliverability and choose the fixture report.
2. Open the "By provider" section.
3. Read the summary sentence.
4. Compare it with the "By region" section directly above.
5. Open Reports and follow the campaign's link back to this section.

**Assertions**
- [ ] Three provider rows appear with all six documented fields, including delivery times of 45, 52 and 48 seconds.
- [ ] The summary names Outlook as weakest and states the gap against Gmail in points.
- [ ] `overallTotalCount` (900) is shown as the total mailboxes tested.
- [ ] By-provider and by-region use the same table layout and sit adjacent.
- [ ] The Reports link lands on this section, not the top of the report.

**Teardown:** Delete the fixture test and its cached provider rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | "By provider" table beneath "By region" | Medium | Shares one component and layout with the region breakdown; the summary sentence carries the meaning so the table can be skipped |
| Reports | One conditional link per campaign | Low | Link only; no table duplicated |

**Verdict:** Fits an existing surface

By-provider and by-region are the same table with a different first column, so they should be one component shown twice rather than two panels competing for attention. Putting the conclusion in a sentence above each table is what keeps the report readable when a third breakdown inevitably arrives. No new navigation item.
