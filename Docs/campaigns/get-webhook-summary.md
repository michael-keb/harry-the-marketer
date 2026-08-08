# Get Webhook Summary

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/webhooks/summary` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-webhook-summary |
| **Auth** | API key (query param `api_key`) |

Tells you how a campaign's outbound notifications have been doing over a period — how many were attempted, how many succeeded, how many failed, and the success rate.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** workspace owner who has wired Harry to Slack or Teams, **I want** a summary of how many notifications a campaign fired and how many failed over a period, **so that** I find out my alerts have been silently failing before I miss a reply.

**Acceptance criteria**
- [ ] Given a campaign with notification history, when I request a summary with `fromTime` and `toTime`, then I get `total_calls`, `successful_calls`, `failed_calls` and `success_rate` for that window.
- [ ] Given `successful_calls + failed_calls` does not equal `total_calls`, when the summary is rendered, then the discrepancy is logged rather than silently displayed.
- [ ] Given no notifications were attempted in the window, when I request the summary, then I get a 200 with all counters at `0` and a success rate of `0`, not a divide-by-zero.
- [ ] Given `fromTime` or `toTime` is missing or not ISO 8601 (`2024-01-01T00:00:00.000Z` form), when I request the summary, then I get a validation error naming the field.
- [ ] Given `failed_calls` is above zero, when the summary is shown, then there is a one-click path to the failures themselves, not just the count.
- [ ] Given the campaign belongs to another workspace, when I request the summary, then I get a not-found response.
- [ ] Given `success_rate` is returned as a percentage (for example `96.7`), when it is displayed, then it is shown to one decimal place with a `%` suffix.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 150 notification attempts, 145 successful, inside January. Request with `fromTime=2024-01-01T00:00:00.000Z`, `toTime=2024-01-31T23:59:59.999Z` | 200 with `total_calls: 150`, `successful_calls: 145`, `failed_calls: 5`, `success_rate: 96.7` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; UI shows the integration as "not verified", not as healthy |
| TC-3 | Not found / wrong workspace | Request the summary for another workspace's campaign | 404, empty body |
| TC-4 | Validation failure | Send `fromTime=yesterday` | 422 naming `fromTime` and stating the expected ISO format |
| TC-5 | Rate limited | Poll the summary once per second for a minute | 429; the panel backs off to its normal refresh interval and keeps the last figures |
| TC-6 | Empty result set | Request a window before the integration was configured | 200 with all zeros; panel reads "No notifications sent in this period" |
| TC-7 | All failures | Seed 20 attempts, all failed | `success_rate: 0`; the panel raises a warning state and links to the failure list |
| TC-8 | Integration disconnected mid-window | Remove the webhook URL halfway through the window | Counts cover only the period while it was configured; the panel says when it stopped |
| TC-9 | Inverted window | `fromTime` after `toTime` | 422; no counts returned |
| TC-10 | Rounding | Seed 3 of 7 successful | `success_rate` is `42.9`, not `42.86` or `43` |

## 4. Frontend user story

**As a** workspace owner, **I want** a notification health panel on Monitoring, **so that** I can see at a glance whether my Slack and Teams alerts are actually arriving.

**Scope**
- Monitoring page: a "Notifications" card in the existing component-checks column, showing attempted, delivered, failed and success rate for the last 24 hours with a range toggle for 7 and 30 days.
- Campaign detail: a single line in the campaign header area only when `failed_calls > 0`, linking to the Monitoring card. Healthy campaigns show nothing.
- Loading shows a skeleton row; empty shows "No notifications sent in this period"; error keeps the last known figures and marks them stale.
- Accessibility: the card is a labelled region, the success rate has a text equivalent ("96.7 percent delivered"), and the warning state is signalled by text as well as colour. On mobile the card stacks below the component checks.

**Definition of done**
- [ ] Failed count above zero drives a visible warning state on Monitoring.
- [ ] The range toggle changes all four figures from one request.
- [ ] A healthy campaign adds no new pixels to the campaign detail page.
- [ ] Empty, error and all-failed states have component tests.

## 5. Backend user story

**As a** Harry server, **I want** to summarise outbound notification attempts per campaign over a window, **so that** alert failures are visible instead of buried in telemetry.

**Scope**
- Add `GET /api/campaigns/:id/notifications/summary?from=&to=` to `server/routes.js`, workspace-scoped.
- Data model: none new — derive from the existing `telemetry` rows the Slack/Teams sender already writes; ensure those rows record outcome and campaign id.
- Validate both timestamps as ISO 8601 with milliseconds; reject an inverted window with a 422.
- Compute `success_rate` server-side to one decimal, guarding the zero-attempt case.
- Log the summary call itself to `telemetry` with duration so a slow summary shows up on Monitoring.

**Definition of done**
- [ ] Returns `{ total_calls, successful_calls, failed_calls, success_rate }`.
- [ ] Zero attempts return zeros, never nulls or `NaN`.
- [ ] Notification failures remain non-blocking for sends, as today.
- [ ] Unit tests cover the zero case, the all-failed case and rounding.

## 6. End-to-end test ticket

**Title:** E2E — notification health for a campaign

**Preconditions:** A workspace with a configured incoming-webhook URL pointing at a local stub, one campaign, and a stub that fails every third call.

**Flow**
1. Sign in, run the engine so several notifications fire.
2. Open Monitoring and read the Notifications card.
3. Switch the range from 24 hours to 7 days.
4. Point the stub at a URL that always fails, trigger more notifications, refresh Monitoring.
5. Open the campaign detail page.

**Assertions**
- [ ] The card's attempted count matches the number of stub hits.
- [ ] The failed count matches the stub's forced failures and the success rate matches to one decimal.
- [ ] After step 4 the card shows a warning state in text, not colour alone.
- [ ] The campaign detail page shows the failure line only after step 4, not before.
- [ ] No send was blocked by any notification failure.

**Teardown:** Remove the webhook URL, delete the campaign, prune the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring | One new card among existing component checks | Low | Reuses the existing check card layout; no new section heading |
| Campaign detail | A conditional one-line warning | Low | Renders nothing at all when notifications are healthy |
| Settings | No change | Low | Webhook URL stays where it already is |

**Verdict:** Fits an existing surface

Monitoring already exists to answer "is every hop working", and notifications are a hop. Adding a card there costs one tile; adding a separate integrations dashboard would cost a navigation item for something a healthy user should never need to look at.
