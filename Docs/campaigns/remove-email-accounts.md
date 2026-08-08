# Remove Email Accounts from Campaign

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/email-accounts` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/remove-email-accounts |
| **Auth** | API key (query param `api_key`) |

Takes one or more mailboxes out of a campaign's sending pool without deleting the mailboxes themselves, and refuses to leave a running campaign with nothing to send from.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to pull a mailbox out of a campaign's sending pool, **so that** a Gmail account whose reputation has slipped or whose connection has failed stops sending, while it stays connected for my other campaigns.

**Acceptance criteria**
- [ ] Given a campaign with more than one mailbox, when I remove one by passing `email_account_ids`, then I get `{ ok: true }` and the removed mailbox sends nothing further for that campaign.
- [ ] Given the campaign is running, when I try to remove every remaining mailbox, then the request is refused with an explanation that at least one must remain, and nothing is removed.
- [ ] Given the campaign is paused or draft, when I remove the last mailbox, then it succeeds, and the campaign is blocked from launching until a mailbox is attached.
- [ ] Given the mailbox is removed, when I look at Mailboxes, then the account is still connected and still usable by other campaigns.
- [ ] Given an email is already queued from the removed mailbox, when the engine next ticks, then that email is re-homed to a remaining mailbox or held, and never sent from the removed account.
- [ ] Given an id in `email_account_ids` is not attached to the campaign, when I remove, then I get a 404 with `{ "error": "Resource not found" }` and no partial removal occurs.
- [ ] Given `email_account_ids` is empty or not an array, when I remove, then I get a 422 with `{ "error": "Invalid parameters provided" }`.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Campaign with mailboxes 456, 457, 458 running. DELETE with `email_account_ids: [456, 457]` | 200 `{ ok: true }`; only 458 remains in the pool |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }`; pool unchanged |
| TC-3 | Not found / wrong workspace | Remove a mailbox id belonging to another workspace | 404 `{ "error": "Resource not found" }`; nothing removed |
| TC-4 | Validation failure | Send `email_account_ids: "456"` (string, not array) | 422 `{ "error": "Invalid parameters provided" }` |
| TC-5 | Rate limited | Fire the removal repeatedly | 429; the client retries after the reset and the final pool is correct |
| TC-6 | Empty result set | Remove the only mailbox from a paused campaign, then list the pool | 200 with an empty pool; the campaign shows "No mailbox attached — cannot launch" |
| TC-7 | Last mailbox on a running campaign | Campaign is active with one mailbox. Attempt to remove it | Refused with a message telling the user to pause first or add a replacement; pool unchanged |
| TC-8 | Partial-failure atomicity | Send `[456, 999999]` where 999999 does not exist | Nothing is removed; 456 stays in the pool |
| TC-9 | Queued email re-homed | Queue a send from 456, then remove 456 | The email goes from a remaining mailbox or is held; no send from 456 |
| TC-10 | Mailbox survives | After TC-1, open Mailboxes | 456 and 457 are still connected with their daily limits intact |
| TC-11 | Reply reading | Remove a mailbox that has live threads | Existing replies in those threads are still pulled and shown in Inbox |

## 4. Frontend user story

**As a** campaign owner, **I want** to manage a campaign's mailbox pool from the campaign itself, **so that** dropping a bad sender is one click and I am told immediately if that would stop the campaign.

**Scope**
- Campaign detail: the existing mailbox picker becomes a small pool list with a remove control per row and a live count.
- Mailboxes page: each account shows which campaigns use it, so a user removing a bad sender knows what they are about to affect.
- The remove control on the last mailbox of a running campaign is disabled with an inline reason, not enabled-then-rejected — the user should not have to fail to learn the rule.
- Loading disables the row; failure restores it with an adjacent message. A removal that leaves a paused campaign empty shows a persistent "cannot launch" notice on the campaign.
- Accessibility: remove is a button with an accessible name including the mailbox address; the disabled state carries its reason via `aria-describedby`. The pool list stacks on narrow screens.

**Definition of done**
- [ ] The last-mailbox rule is enforced in the UI before the request, and by the server regardless.
- [ ] Removing a mailbox never implies the account was disconnected.
- [ ] The Mailboxes page shows campaign usage per account.
- [ ] Empty-pool campaigns are visibly blocked from launching.

## 5. Backend user story

**As a** Harry server, **I want** to detach mailboxes from a campaign atomically with a guard on the last one, **so that** a running campaign can never be left with no way to send.

**Scope**
- Add `DELETE /api/campaigns/:id/mailboxes` to `server/routes.js` taking `{ mailbox_ids: [] }`, workspace-scoped.
- Data model: delete rows from the existing campaign-to-mailbox association; do not touch the `mailboxes` table itself.
- Validate the whole id list before removing anything, so a bad id causes zero changes.
- Refuse the request when the campaign status is running and the removal would empty the pool; return a message that names the two ways out (pause, or add a replacement).
- `server/mailer.js` and `server/pacing.js` must re-derive the pool per tick so a removal takes effect on the next tick without a restart; a queued send from a removed mailbox is re-homed or held.
- Write an `events` row per removal naming the actor and mailbox, and a `telemetry` row for the call.

**Definition of done**
- [ ] All-or-nothing removal proven by a test with one bad id.
- [ ] An engine test proves no send from a removed mailbox after removal.
- [ ] The last-mailbox guard is tested for running, paused and draft campaigns.
- [ ] Removed mailboxes remain connected and usable elsewhere.

## 6. End-to-end test ticket

**Title:** E2E — remove a mailbox from a running campaign's pool

**Preconditions:** A workspace with two sandbox mailboxes, one running campaign using both, several leads mid-playbook with at least one send queued.

**Flow**
1. Sign in and open the campaign detail page.
2. Remove the first mailbox from the pool.
3. Run the engine and inspect the sent messages.
4. Attempt to remove the remaining mailbox.
5. Pause the campaign and attempt the removal again.
6. Open Mailboxes.

**Assertions**
- [ ] After step 2 the pool shows one mailbox and the count updates without a reload.
- [ ] No message after step 2 was sent from the removed mailbox.
- [ ] Step 4 is refused with a message naming the two ways out.
- [ ] Step 5 succeeds and the campaign shows a "cannot launch" notice.
- [ ] Both mailboxes are still listed as connected on the Mailboxes page.

**Teardown:** Reattach both mailboxes, resume or delete the campaign, clear the events and telemetry created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | Mailbox picker becomes a small removable pool list | Medium | Same control the user already uses to attach; remove is a row action, not a new panel |
| Mailboxes | Each account gains a "used by" line | Low | One line of text, no new column or filter |
| Campaign detail | "Cannot launch" notice when the pool is empty | Low | Reuses the existing launch-blocked messaging for invalid playbooks |

**Verdict:** Fits an existing surface

Harry already blocks launch until a mailbox is picked, so the concepts and the messaging exist; this makes the picker two-way. The important design decision is disabling the last removal with a visible reason rather than letting the user click and be rejected.
