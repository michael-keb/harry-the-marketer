# Delete Campaign

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/campaigns/{id}` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/delete |
| **Auth** | API key (query param `api_key`) |

Permanently removes a campaign along with everything attached to it — its sequence, its lead links, its statistics and its email history.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to retire a campaign I no longer need, **so that** my Campaigns list reflects what I am actually running — without losing the history of who I already emailed.

**Acceptance criteria**
- [ ] Given a campaign that is not running, when I delete it, then it is removed and I get a clear success response (the source API's `{"success": true, "message": "Campaign deleted successfully"}`).
- [ ] Given a campaign that is currently running, when I try to delete it, then it is refused with the reason "stop it first" — mirroring the source API's `CAMPAIGN_ACTIVE` error — and nothing is removed.
- [ ] Given deletion is irreversible, when I ask for it, then I must confirm by typing the campaign's name, and the dialog states exactly what will be lost: playbook, lead links, statistics, and thread history.
- [ ] Given I only want it out of my way, when I open the delete dialog, then Archive is offered first as the reversible option that keeps every record and hides the campaign from the active list.
- [ ] Given a campaign is deleted, when I look at the Leads page, then the people are still there — deleting a campaign deletes the campaign link, never the person.
- [ ] Given a lead unsubscribed inside the deleted campaign, when the campaign is gone, then the unsubscribe still holds workspace-wide and that address can still not be imported anywhere.
- [ ] Given a campaign has follow-on campaigns or a linked goal, when I delete it, then the dialog names each dependency and what happens to it.
- [ ] Given deletion succeeds, when I look at the activity trail, then it records who deleted which campaign and when, and that record survives the deletion.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Stop a campaign, then DELETE it | 200, `{"success": true, "message": "Campaign deleted successfully"}`; it is gone from Campaigns |
| TC-2 | Missing/invalid API key | DELETE unauthenticated | 401, `{"message": "Invalid API Key"}`; campaign untouched |
| TC-3 | Not found / wrong workspace | DELETE a campaign id from another workspace | 404, `{"error": "Resource not found"}`; that campaign still exists for its owner |
| TC-4 | Validation failure | DELETE with a non-numeric id | 422, `{"error": "Invalid parameters provided"}` |
| TC-5 | Rate limited | Issue many deletes in a burst | 429 on the excess; client backs off, no half-deleted campaign |
| TC-6 | Empty result set | Delete the workspace's only campaign | 200; Campaigns shows its empty state with a "New campaign" action, not a blank page |
| TC-7 | Delete a running campaign | DELETE while status is running | Refused with code `CAMPAIGN_ACTIVE` and the message "Cannot delete active campaign. Please stop it first."; the dialog offers Stop |
| TC-8 | Pending approvals | Delete a campaign with drafts waiting in Needs your OK | Dialog states how many drafts will be discarded; after deletion those drafts are gone from the Inbox queue |
| TC-9 | Leads survive | Delete a campaign with 50 attached leads | All 50 leads still on the Leads page, now with no live campaign |
| TC-10 | Unsubscribes survive | Delete a campaign in which someone unsubscribed | That address is still suppressed on import elsewhere |
| TC-11 | Double delete | DELETE the same id twice | Second call 404, not 500; UI treats it as already gone |
| TC-12 | Archive instead | Choose Archive in the dialog | Campaign hidden from the active list, all data intact, reversible from a filter |

## 4. Frontend user story

**As a** campaign owner, **I want** deletion to make the consequences obvious and offer archiving first, **so that** I cannot destroy a quarter of outreach history by clicking through a dialog.

**Scope**
- Campaigns list and campaign detail: a single overflow menu with Archive and Delete. Archive is the primary option; Delete is styled as destructive and secondary.
- The delete dialog lists real counts pulled from the campaign — leads attached, emails sent, replies received, drafts waiting — and requires the campaign name to be typed before the button enables.
- Campaigns list gains an "Archived" filter so archived campaigns are findable without cluttering the default view.
- Loading: the button shows progress and disables the dialog. Error: the `CAMPAIGN_ACTIVE` case renders as an actionable "Stop the campaign first" with a Stop button inline, not a raw error string. Empty: after deleting the last campaign, the Campaigns empty state appears.
- Accessibility: the dialog is modal with focus trapped on the confirm field; the destructive action is announced as destructive in its accessible name; the type-to-confirm field has a visible label. Responsive: dialog is full-height on mobile with the confirm button pinned.

**Definition of done**
- [ ] Archive is offered before Delete everywhere Delete appears.
- [ ] The dialog shows live counts of what will be lost.
- [ ] Type-to-confirm is required and the button stays disabled until it matches.
- [ ] The active-campaign refusal is shown as a next step, not an error.

## 5. Backend user story

**As a** Harry API, **I want** delete and archive routes with a hard guard on running campaigns, **so that** destroying data is deliberate and the engine can never tick against a half-deleted campaign.

**Scope**
- Routes in `server/routes.js`: `DELETE /api/campaigns/:id` and `PATCH /api/campaigns/:id` accepting `{ status: 'archived' }`, both workspace-scoped.
- Data model in `server/db.js`: an `archived_at` column on `campaigns`. Deletion cascades to `campaign_leads`, campaign-scoped `messages`, drafts, node stats and webhook config, all in one transaction; it does not touch `leads` or the workspace-level unsubscribe record.
- Guard: a campaign in a running state returns 409 with code `CAMPAIGN_ACTIVE` before any write. The engine takes the same lock, so a tick in flight completes or aborts cleanly.
- No pagination. Standard rate limiting; the route is idempotent from the client's point of view — a second delete is a 404, never a 500.
- Logged: an `events` row written before the transaction commits, holding campaign id, name, and the counts destroyed, so the trail outlives the campaign; `telemetry` counts deletes and refused deletes.

**Definition of done**
- [ ] Running campaigns cannot be deleted, covered by a test that races a tick against a delete.
- [ ] Cascade covered by a test asserting leads and unsubscribes survive.
- [ ] The activity-trail entry survives deletion and carries the destroyed counts.
- [ ] Archive is fully reversible and hides the campaign from default listings only.

## 6. End-to-end test ticket

**Title:** E2E — Archive and delete a campaign without losing people

**Preconditions:** A workspace with two campaigns; campaign A running with 10 leads, 4 sent emails, 1 reply, 2 drafts awaiting approval, and 1 unsubscribed lead. Campaign B is a draft.

**Flow**
1. Open Campaigns, choose campaign A, open the overflow menu and select Delete.
2. Observe the refusal, press Stop from inside the dialog.
3. Choose Archive, then confirm.
4. Switch the Campaigns filter to Archived and confirm A is there.
5. Unarchive A, then Delete it, typing its name to confirm.
6. Open Leads and try to import the unsubscribed address into campaign B.

**Assertions**
- [ ] The first delete attempt is refused with "Cannot delete active campaign. Please stop it first."
- [ ] The delete dialog shows 10 leads, 4 sent, 1 reply, 2 waiting drafts before confirmation.
- [ ] After archiving, campaign A is absent from the default list and present under Archived, with all counts intact.
- [ ] After deletion, all 10 leads remain on Leads with no live campaign.
- [ ] The unsubscribed address is refused on import into campaign B.
- [ ] The activity trail still shows campaign A's creation, launch and deletion.

**Teardown:** Delete campaign B; leave the leads and the unsubscribe record in place for the next run's suppression check.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns list | Overflow menu with Archive and Delete, plus an Archived filter | Low | One menu, one filter chip; default view is unchanged |
| Campaign detail | Same menu in the header | Low | Shares the component with the list |
| Delete dialog | Counts of what will be lost, type-to-confirm | Medium | Only appears at the moment of destruction, where friction is the point |
| Leads | Unchanged | Low | Deleting a campaign never removes a person, so nothing to show |

**Verdict:** Fits an existing surface

Deleting belongs with the object being deleted, so it lives in the campaign's own overflow menu on the two pages that already list campaigns. The dialog is intentionally heavier than Harry's usual light touch, because this is the one action a user cannot undo, and "don't make me think" here means "show me exactly what I am about to lose".
