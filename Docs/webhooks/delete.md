# Delete Campaign Webhook

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/webhook/delete` |
| **Category** | webhooks |
| **Source** | https://api.smartlead.ai/api-reference/webhooks/delete |
| **Auth** | API key (query param `api_key`) |

Removes a registered endpoint for good, so nothing further is ever posted to that URL.

## 1. Epic

**Outbound event notifications**

The epic lets a Harry workspace push what it already knows — an email sent, opened, clicked, replied to, bounced, a lead unsubscribed, a campaign's status changed — to any URL the user names, so a CRM, a spreadsheet or a team's own tooling learns about it without anyone copying anything across. It matters because Harry today can only tell one Slack or Teams webhook about four kinds of thing, in a message shaped for humans; everything else it knows stops at the edge of the app.

**Where Harry stands:** Settings holds one incoming-webhook URL for Slack or Teams alerts, and the engine, AI layer and mailer already write a `telemetry` row and an `events` row for the moments that matter. Outbound, per-event, machine-readable webhooks are new build on top of existing signals — not new signals.

## 2. User story

**As a** marketer decommissioning an integration, **I want** to remove an endpoint and know that nothing more will be sent to it, **so that** a retired service does not keep receiving my leads' details.

**Acceptance criteria**
- [ ] Given a webhook `id` the caller owns, when it is deleted, then a 200 `{"ok": true}` is returned and the row disappears from Settings without a page reload.
- [ ] Given the endpoint is deleted, when the next matching event occurs, then no POST is attempted to that URL at all, including retries of attempts that were already queued.
- [ ] Given deletion is requested, when the user confirms, then the confirmation names the endpoint and its URL host and states that delivery history will be kept for the audit trail but the endpoint cannot be restored.
- [ ] Given the `id` does not exist or belongs to another workspace, when deletion is attempted, then a 404 `{"error": "Resource not found"}` is returned with the same body in both cases.
- [ ] Given `id` is missing from the body, when deletion is attempted, then a 422 `{"error": "Invalid parameters provided"}` names `id` and nothing is deleted.
- [ ] Given the endpoint is deleted, when the activity trail is read, then one entry records who deleted it, when, and which URL host it pointed at — never the signing secret.
- [ ] Given a user wants to stop delivery temporarily, when they open the row's menu, then Pause is offered above Delete, so the reversible action is the easier one to reach.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `DELETE /webhook/delete` with `{"id": 12345}` | 200 `{"ok": true}`; the row disappears from the list |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the endpoint still exists afterwards |
| TC-3 | Not found / wrong workspace | Delete an id from another workspace, then a non-existent id | 404 `{"error": "Resource not found"}` both times; the other workspace's endpoint is untouched |
| TC-4 | Validation failure | Call with an empty body | 422 `{"error": "Invalid parameters provided"}` naming `id`; nothing deleted |
| TC-5 | Rate limited | Delete 20 endpoints in one second | 429 with `Retry-After`; the list reflects exactly the deletions that succeeded |
| TC-6 | Empty result set | Delete the only endpoint, then read the list | 200 with an empty list; "No endpoints yet" and one Add button |
| TC-7 | Delivery stops | Delete an endpoint, then trigger a subscribed event | No request reaches the receiver, and no delivery row is written for the attempt |
| TC-8 | Queued retries dropped | Force a failing delivery so a retry is pending, delete the endpoint, then wait past the retry window | The pending retry is cancelled; the receiver gets nothing further |
| TC-9 | Idempotency | Delete the same id twice | First 200, second 404; the UI treats the second as already gone rather than an error |
| TC-10 | History retained | Delete an endpoint that had ten deliveries, then read the activity trail and Monitoring | The deletion entry is present, past delivery counts still contribute to Monitoring's aggregate, and no secret appears anywhere |
| TC-11 | Scope fallback | Delete a user-level endpoint that was overriding a campaign-level one, then trigger the event | The campaign-level endpoint starts receiving the event, and its row no longer shows as overridden |

## 4. Frontend user story

**As a** marketer, **I want** deleting an endpoint to be deliberate and clearly explained, **so that** I never lose an integration by misclicking and never keep one I meant to kill.

**Scope**
- Settings → Notifications: each endpoint row has a menu offering Pause, Edit and Delete, in that order, with Delete visually last and separated.
- The delete confirmation names the endpoint, shows its URL host, states that nothing further will be sent there, and says the delivery history stays in the activity trail. It requires an explicit confirm, not a hover.
- On success the row is removed optimistically with a short undo window that simply recreates an identical endpoint if used within it, and a plain message if the window has passed.
- Loading disables the row's actions; a 404 is treated as already deleted and the row is removed quietly; a genuine error restores the row and explains.
- Accessibility: the menu is keyboard-operable, the confirmation dialog traps focus and returns it to the row, the destructive action is announced as such, and the undo notice is a live region rather than a disappearing toast only.

**Definition of done**
- [ ] Pause is reachable in fewer actions than Delete.
- [ ] The confirmation names both the endpoint and its host.
- [ ] A 404 on delete removes the row without showing an error.
- [ ] Optimistic removal, undo and failure-restore have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** deletion to stop delivery immediately including queued retries, **so that** removing an endpoint is a real guarantee rather than a list change.

**Scope**
- Route: `DELETE /api/webhooks/:id` in `server/routes.js`, workspace-scoped, returning `{ ok: true }`. The upstream shape puts the id in the body; Harry puts it in the path, which is the convention the rest of `server/routes.js` already follows.
- Data model: the `webhooks` row is deleted; `webhook_deliveries` rows are kept with a null-safe reference so Monitoring's aggregate and the audit trail survive. A retention job prunes delivery rows on the same schedule the `telemetry` table already self-prunes.
- The delivery worker checks the endpoint still exists immediately before each attempt, so a retry scheduled before the deletion cannot fire after it.
- Rate limited on the settings bucket. Logged to `events`: deletion with actor, endpoint name and URL host, never the secret. Deletion latency to `telemetry`.
- Deleting a user-level endpoint restores the priority of any campaign-level endpoints it was overriding, in the same single place where scope priority is decided.

**Definition of done**
- [ ] A queued retry is provably cancelled by deletion, covered by a test.
- [ ] Delivery history survives deletion and still counts toward Monitoring's aggregate.
- [ ] Deleting twice returns 200 then 404.
- [ ] Scope-priority fallback after deleting a user-level endpoint is tested.

## 6. End-to-end test ticket

**Title:** E2E — Delete an endpoint and prove delivery stops

**Preconditions:** A workspace with one campaign, a sandbox mailbox, two endpoints — a user-level one and a campaign-level one both listening for replies — and a local receiver per endpoint, one of which can be forced to return 500.

**Flow**
1. Sign in and open Settings → Notifications.
2. Force a failure on the user-level endpoint so a retry is pending.
3. Delete the user-level endpoint, reading and confirming the dialog.
4. Wait past the retry window.
5. Simulate a reply.
6. Open the activity trail and Monitoring.

**Assertions**
- [ ] The confirmation names the endpoint and its URL host.
- [ ] The row disappears immediately with an undo notice.
- [ ] The pending retry never reaches the receiver after deletion.
- [ ] After step 5 the campaign-level endpoint receives the reply, and its row no longer shows as overridden.
- [ ] The activity trail shows the deletion with the actor and host and no secret.
- [ ] Monitoring's webhook success rate still includes the deleted endpoint's past attempts.

**Teardown:** Delete the remaining endpoint, the campaign and its messages; clear delivery rows and trail entries from the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Notifications | A per-row menu with Pause, Edit and Delete | Low | One menu on a row the create story already adds; Pause is the prominent option |
| Settings → Notifications | A delete confirmation with an undo window | Low | Standard destructive-action pattern, no new concepts |
| Activity trail | A deletion entry | Low | Same row format as every other entry |

**Verdict:** Fits an existing surface

Deletion adds a menu and a confirmation to a row that already exists, which is the smallest possible footprint for an irreversible action. The judgement worth defending is putting Pause first: most people reaching for Delete actually want the events to stop for a while, and offering the reversible answer first prevents the mistake rather than apologising for it.
