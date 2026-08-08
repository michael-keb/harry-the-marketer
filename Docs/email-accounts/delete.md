# Delete Email Account

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/email-accounts/{id}` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/delete |
| **Auth** | API key (query param `api_key`) |

Removes a mailbox from the workspace, detaching it from every campaign and switching its warm-up off.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner, **I want** to remove a mailbox I no longer use and be told exactly what that breaks first, **so that** I never silently stop a live campaign.

**Acceptance criteria**
- [ ] Given a mailbox I own, when I delete it, then the response confirms with the deleted id (SmartLead: `{"ok": true, "message": "Email account deleted successfully!", "emailAccountId": 123}`) and the mailbox disappears from the Mailboxes list.
- [ ] Given the mailbox is attached to campaigns, when I delete it, then it is detached from all of them as part of the same operation, and any campaign left with no mailbox moves to holding with a stated reason rather than failing per lead.
- [ ] Given the mailbox has a warm-up ramp running, when it is deleted, then warm-up is switched off with the recorded reason "deleted by user action", mirroring SmartLead's `INACTIVE` warm-up state.
- [ ] Given the mailbox has sent emails and holds reply threads, when it is deleted, then those messages and threads are preserved — the mailbox is soft-deleted, exactly as SmartLead does, so Inbox and Reports history stays intact.
- [ ] Given a mailbox id from another workspace, when I delete it, then the response is 404 (`errorCode: "ACCOUNT_NOT_FOUND"`) and nothing changes.
- [ ] Given drafts are waiting for approval on that mailbox, when I delete it, then I am told how many and asked to confirm; the drafts are not sent and not silently discarded.
- [ ] Given a deletion, when it completes, then the activity trail records who deleted which address and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Delete a mailbox attached to nothing | 200, `{"ok": true, "emailAccountId": 123}`; row gone from Mailboxes without a page reload |
| TC-2 | Missing/invalid API key | Delete with no session cookie | 401, `{"message": "Invalid API Key"}`; mailbox untouched |
| TC-3 | Not found / wrong workspace | Delete an id owned by another workspace | 404, `{"ok": false, "errorCode": "ACCOUNT_NOT_FOUND"}`; UI shows "That mailbox is not available" and refreshes the list |
| TC-4 | Validation failure | Delete with a non-numeric id | 422 with a field-level message; no lookup performed |
| TC-5 | Rate limited | Fire fifty deletes in a burst | 429 on the excess; client backs off with jitter, one visible retry state |
| TC-6 | Empty result set | Delete the only mailbox in the workspace | 200; Mailboxes shows the "Connect your first mailbox" empty state, and Dashboard's engine panel states that nothing can send |
| TC-7 | Sole mailbox on a live campaign | Delete the only mailbox attached to a running campaign | Confirmation names the campaign; on confirm the campaign moves to holding with reason "no mailbox attached", no sends attempted |
| TC-8 | Drafts awaiting approval | Delete a mailbox with three drafts in Needs your OK | Confirmation states "3 emails are waiting for your OK"; on confirm those drafts are cancelled, not sent, and each lead shows the reason |
| TC-9 | History preserved | After TC-1, open Inbox and Reports | Past sends and reply threads from that address still render, labelled with the removed mailbox |
| TC-10 | Delete twice | Repeat TC-1 on the same id | Second call 404 with `ACCOUNT_NOT_FOUND`; UI treats it as already gone rather than an error |
| TC-11 | Reconnect the same address later | Delete, then connect the same address again | A fresh mailbox is created; warm-up starts from the beginning rather than resuming the deleted one's ramp |

## 4. Frontend user story

**As a** workspace owner, **I want** a delete action that tells me the consequences before I confirm, **so that** I do not discover the damage in the Dashboard afterwards.

**Scope**
- Mailboxes page: a "Remove" action in each mailbox row's menu, opening a confirmation that lists the campaigns using it, the count of drafts awaiting approval, and whether any campaign would be left with no mailbox.
- Confirmation requires typing or clicking a distinct confirm control — never a bare "Are you sure?".
- States: loading (row disabled with progress text), success (row removed with an undo-less confirmation line, since this is not reversible from the UI), failure (inline error, row restored), already-deleted (silently reconciled).
- Campaigns left without a mailbox get a visible holding banner on their campaign detail page pointing at Mailboxes.
- Accessibility: the confirmation is a labelled modal with focus trap and Escape; the consequence list is real text, readable by a screen reader in order. Responsive: the consequence list stacks under 640px.

**Definition of done**
- [ ] The confirmation names every campaign affected and the exact number of waiting drafts.
- [ ] Deleting never leaves a campaign running with nothing to send from.
- [ ] History in Inbox and Reports still renders after deletion.
- [ ] Loading, error and already-deleted states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** to soft-delete a mailbox and clean up its live obligations atomically, **so that** history survives and nothing keeps trying to send from a mailbox that is gone.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `DELETE /api/mailboxes/:id`, returning the deleted id.
- Data model: add `deleted_at` to `mailboxes` in `server/db.js`; every read path filters it out while `messages` and `events` keep their foreign key. Detach rows from the campaign-mailbox link, cancel queued drafts for that mailbox, and stop the warm-up ramp — all in one transaction.
- Revoke the provider credential on the way out (Google token revoke for OAuth mailboxes) and zero the stored secret columns, so a soft-deleted row holds no usable credential.
- No pagination. Deletion is not batched; the standard app rate limiter applies and a repeat delete is answered 404 rather than retried.
- Logged: an `events` row naming actor, address, campaigns detached and drafts cancelled; `telemetry` records deletions so Monitoring can explain a sudden drop in mailbox capacity.

**Definition of done**
- [ ] Soft delete, detach, draft cancellation and warm-up stop happen in one transaction, covered by a test that asserts partial failure rolls everything back.
- [ ] No API response or serialiser ever returns a deleted mailbox.
- [ ] Provider credentials are revoked and cleared, verified by a test.
- [ ] Cross-workspace delete returns 404 and is covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Remove a mailbox without losing history

**Preconditions:** A workspace with two sandbox mailboxes, one campaign attached to both with four leads, two emails already sent and one reply received, two drafts waiting in Needs your OK.

**Flow**
1. Open Mailboxes and choose Remove on the mailbox that sent the two emails.
2. Read the confirmation: it should name the campaign and the waiting drafts.
3. Confirm.
4. Open the campaign detail page.
5. Open Inbox, then Reports.
6. Remove the remaining mailbox and open the campaign again.

**Assertions**
- [ ] The confirmation names the campaign and says two emails are waiting for approval.
- [ ] After removal the campaign still runs on the second mailbox and the cancelled drafts show a reason on their leads.
- [ ] The sent emails and the received reply still appear in Inbox and in the Reports funnel.
- [ ] After removing the second mailbox the campaign holds and its page states "no mailbox attached".
- [ ] The activity trail shows both removals with the actor and address.

**Teardown:** Restore the two sandbox mailboxes, delete the campaign, reset lead states.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Remove action plus a consequence-listing confirmation | Low | Lives in the existing row menu; the confirmation is only as long as the consequences actually are |
| Campaign detail | Holding banner when the last mailbox goes | Low | Reuses the existing holding-reason banner from the sending rhythm |
| Inbox / Reports | Historical rows label a removed mailbox | Low | One label suffix on rows that already exist |
| Dashboard | Action Center entry for leads whose drafts were cancelled | Low | Existing Action Center pattern, no new component |

**Verdict:** Fits an existing surface

Removing a mailbox is a row action on a page that already lists mailboxes, so nothing new is needed to hold it. The genuinely new part is the consequence list before confirming, which is text inside a modal rather than a surface. No navigation item is added.
