# Delete Campaign Webhook

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/campaigns/{id}/webhooks/{id}` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/delete-webhook |
| **Auth** | API key (query param `api_key`) |

Removes one outbound notification hook from one campaign, so that campaign stops posting its events to that URL.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** workspace owner, **I want** to remove a campaign's notification hook, **so that** a stale Slack channel or a decommissioned endpoint stops receiving that campaign's events without me touching any other campaign.

**Acceptance criteria**
- [ ] Given a campaign with a hook attached, when I delete it by campaign id and webhook id, then it is removed and I get a clear success response (the source API returns `{"success": true, "message": "Webhook deleted successfully"}`).
- [ ] Given the hook is deleted, when the campaign next produces an event that would have been posted (a reply, an email awaiting approval, a lead needing a decision, a signed agreement), then nothing is sent to that URL.
- [ ] Given the hook is deleted, when I look at other campaigns using the same URL, then they are unaffected — deletion is scoped to the one campaign-hook pair.
- [ ] Given a webhook id that does not belong to that campaign, when I delete it, then I get a 404 and nothing is removed.
- [ ] Given deliveries were already queued or retrying when I delete the hook, when the deletion lands, then those pending deliveries are dropped rather than completing after the fact.
- [ ] Given the deletion happens, when I look at the activity trail, then it records who removed which hook from which campaign, with the destination URL masked to its host.
- [ ] Given the workspace-level Slack or Teams hook set in Settings, when I delete a campaign-level hook, then the workspace hook keeps working — the two are separate.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | DELETE campaign 123 / webhook 456 | 200, `{"success": true, "message": "Webhook deleted successfully"}`; the campaign's hook list no longer contains it |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; the hook is untouched and still delivering |
| TC-3 | Not found / wrong workspace | DELETE a webhook id belonging to another workspace's campaign | 404; that hook still exists for its owner |
| TC-4 | Validation failure | DELETE with a non-numeric webhook id | 422 with a field-level message on the webhook id |
| TC-5 | Rate limited | Delete many hooks in a burst | 429 on the excess; client backs off and completes |
| TC-6 | Empty result set | View a campaign with no hooks | 200 with an empty list; Settings shows "No notifications for this campaign" |
| TC-7 | Wrong pairing | DELETE a valid webhook id under the wrong campaign id | 404; the hook remains attached to its real campaign |
| TC-8 | Deliveries stop | Delete a hook, then trigger a reply on that campaign | No POST is attempted to that URL; telemetry shows no delivery attempt |
| TC-9 | Shared URL | Two campaigns post to the same Slack URL; delete one hook | The other campaign still delivers to that URL |
| TC-10 | In-flight retry | Delete a hook while a delivery is in its retry backoff | The retry is abandoned; no late delivery arrives |
| TC-11 | Double delete | DELETE the same pair twice | Second call 404, handled by the UI as already removed |

## 4. Frontend user story

**As a** workspace owner, **I want** a campaign's notification hooks listed where I set them up, with a remove action, **so that** turning off noisy alerts takes one click in a place I can find.

**Scope**
- Settings → Notifications: the existing single-webhook field becomes a list showing the workspace-level hook plus any campaign-level hooks, each with its destination host, which campaign it belongs to, its last delivery result, and a Remove action.
- Campaigns → campaign detail: a compact "Notifications" line showing how many hooks this campaign has, linking to the same Settings section rather than duplicating the controls.
- The remove confirmation names the destination host and the campaign, and states plainly that other campaigns using the same URL keep working.
- Loading: skeleton rows. Empty: "No notifications set up" with the existing add-webhook affordance. Error: inline message on the row, hook left in place.
- Accessibility: each row's Remove action carries an accessible name including the campaign and host; delivery status is text, not a coloured dot alone. Responsive: rows stack under 640px with the action in the footer.

**Definition of done**
- [ ] Hooks are listed with campaign, host and last delivery result.
- [ ] Remove works from the list and reflects immediately.
- [ ] The campaign detail line links to Settings rather than duplicating the UI.
- [ ] Removing a campaign hook visibly leaves the workspace hook intact.

## 5. Backend user story

**As a** Harry API, **I want** campaign-scoped webhook rows with a delete route, **so that** notification fan-out can be turned off per campaign and pending deliveries stop cleanly.

**Scope**
- Routes in `server/routes.js`: `GET /api/campaigns/:id/webhooks`, `POST /api/campaigns/:id/webhooks`, `DELETE /api/campaigns/:id/webhooks/:webhookId`, all workspace-scoped, following the pattern used by the existing Settings notification handler.
- Data model: a `campaign_webhooks` table in `server/db.js` (`campaign_id`, `url`, `events`, `created_at`, `last_status`, `last_attempt_at`). The existing workspace-level Slack/Teams URL stays in settings and is unchanged.
- Delete verifies the webhook belongs to the named campaign before removing (mismatched pairing is a 404, not a silent success), and marks any queued delivery for that hook as cancelled in the same transaction.
- No pagination — a campaign has a handful of hooks. Delivery failures remain telemetry only and never block a send, matching the existing rule for Slack and Teams alerts.
- Logged: an `events` row on create and delete with the URL reduced to its host; `telemetry` records delivery attempts, failures and cancellations per hook.

**Definition of done**
- [ ] Delete is pair-verified and idempotent from the client's view.
- [ ] Cancelled deliveries never fire after the hook is gone, covered by a test.
- [ ] URLs are never written to logs or the activity trail in full.
- [ ] Workspace-level notifications are provably unaffected.

## 6. End-to-end test ticket

**Title:** E2E — Turn off one campaign's notifications without touching the rest

**Preconditions:** A workspace with a Slack-shaped local test endpoint, two campaigns both hooked to it, plus the workspace-level hook set in Settings. One sandbox mailbox and one lead per campaign.

**Flow**
1. Open Settings → Notifications and confirm three hooks are listed.
2. Remove campaign A's hook, confirming in the dialog.
3. Trigger a reply on campaign A's sandbox lead.
4. Trigger a reply on campaign B's sandbox lead.
5. Inspect the test endpoint's received payloads.
6. Open the activity trail.

**Assertions**
- [ ] After removal the list shows two hooks, with campaign A absent.
- [ ] The campaign A reply produces no delivery from the campaign hook.
- [ ] The campaign B reply still delivers.
- [ ] The workspace-level hook still delivers for both campaigns.
- [ ] The activity trail records the removal with the host only, never the full URL.

**Teardown:** Remove the remaining hooks and both campaigns; stop the test endpoint.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Notifications | Single field becomes a list with per-row Remove | Medium | Collapses to today's single field when only the workspace hook exists |
| Campaigns → campaign detail | One line stating the hook count, linking to Settings | Low | Text only, hidden when there are no campaign hooks |
| Monitoring | Delivery failures already surface as telemetry | Low | Existing incident feed, no new panel |

**Verdict:** Fits an existing surface

Harry already has one webhook field in Settings → Notifications, and per-campaign hooks are the same idea with a scope attached, so they belong in that same list. Campaign detail gets a pointer rather than a copy of the controls, keeping one place to manage notifications.

**Note on source coverage:** the upstream documentation for this endpoint is minimal — two path parameters and a success message, with no error shapes, no event vocabulary, and no create/list counterpart documented on the page. Error codes, the events a hook can subscribe to, and the retry semantics above are inferred from the neighbouring campaign endpoints and from Harry's existing Slack and Teams behaviour.
