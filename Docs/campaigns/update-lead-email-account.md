# Update Lead Email Account

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/update-lead-email-account` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-lead-email-account |
| **Auth** | API key (query param `api_key`) |

Pins one lead in one campaign to a specific mailbox, so their emails always come from that sender instead of whichever one the rotation picks.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to choose which mailbox sends to a particular lead, **so that** a prospect who already knows one of my colleagues hears from that colleague's address rather than a stranger's.

**Acceptance criteria**
- [ ] Given a lead in a campaign, when I set the mailbox with `email_account_id`, `email_campaign_id` and `email_lead_id`, then I get `{ success: true, message: "Lead email account updated" }` and every subsequent send for that lead in that campaign uses that mailbox.
- [ ] Given the lead already has a pinned mailbox, when I set a new one without `override_lead_email_account`, then the request is refused with an explanation; with the flag true, the pin is replaced.
- [ ] Given the mailbox is not in the campaign's pool, when I pin it, then either it is added to the pool with an explicit confirmation, or the request is refused — never a silent send from an unattached account.
- [ ] Given the pinned mailbox reaches its daily limit, when a send is due, then the send waits for that mailbox rather than falling back to another, and the campaign says why it is holding.
- [ ] Given the lead has an open thread from a different mailbox, when I pin a new one, then I am warned that changing sender mid-thread breaks the conversation, and the existing thread keeps its original sender unless I confirm.
- [ ] Given the pinned mailbox is later removed from the campaign, when a send is due, then the pin is cleared and the lead returns to the pool, with the change recorded.
- [ ] Given any of the three required ids is missing or unknown, when I send, then I get a validation or not-found error and nothing changes.
- [ ] Given the pin is set, when I look at the lead, then the pinned sender is visible with an option to unpin.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ email_account_id: 999, email_campaign_id: 123, email_lead_id: 789, override_lead_email_account: true }` | 200 `{ success: true, message: "Lead email account updated" }`; the next send comes from 999 |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; no pin created |
| TC-3 | Not found / wrong workspace | Use a mailbox id from another workspace | 404; no pin created |
| TC-4 | Validation failure | Omit `email_lead_id` | 422 naming the missing field |
| TC-5 | Rate limited | Pin 200 leads in a loop | 429 on some; retries settle and every lead ends with the intended pin |
| TC-6 | Empty result set | List pinned leads on a campaign with none | 200 with an empty list; the panel shows "No leads pinned to a sender" |
| TC-7 | Existing pin without override | Pin twice, second time with `override_lead_email_account` absent or false | Second request refused with a message naming the existing pin |
| TC-8 | Mailbox outside the pool | Pin a connected mailbox not attached to the campaign | Either refused, or attached with explicit confirmation; never sends from an unattached account |
| TC-9 | Daily limit reached | Pin a mailbox at its daily cap, trigger a send | The send waits; the campaign page states which mailbox it is waiting on and when |
| TC-10 | Mid-thread change | Pin a new mailbox on a lead with an open thread | A warning appears; the existing thread keeps its original sender unless confirmed |
| TC-11 | Pinned mailbox removed | Remove the pinned mailbox from the campaign's pool | The pin is cleared, the lead returns to the pool, and the change is in the activity trail |
| TC-12 | Pacing respected | Pin several leads to one mailbox | Sends still obey the one-at-a-time gap and working hours for that mailbox |

## 4. Frontend user story

**As a** campaign owner, **I want** to set the sender for an individual lead from the lead's row, **so that** a warm introduction goes from the right person without me building a separate campaign.

**Scope**
- Campaign detail, leads list: a "Send from" control per row showing the current sender — "Rotation" by default, or the pinned address — with a picker limited to mailboxes in the campaign's pool plus an explicit "add another mailbox" path.
- Leads page and Inbox thread view: the same control, since the reason to pin usually surfaces while reading a thread.
- Pinned rows show the sender address inline with an unpin action; the campaign header shows a count of pinned leads so the setting is discoverable rather than hidden per row.
- Warnings: changing sender mid-thread, and pinning to a mailbox at its daily cap, are both explained before the user commits.
- Accessibility: the picker is a labelled listbox whose options read as email addresses with their health state; warnings are text in the dialog, not colour alone. On mobile the control lives in the row overflow menu.

**Definition of done**
- [ ] Default state reads as "Rotation", never as a blank.
- [ ] Only pool mailboxes are offered without an extra confirmation.
- [ ] Mid-thread sender changes always warn first.
- [ ] Pinned leads are countable from the campaign header.

## 5. Backend user story

**As a** Harry server, **I want** a per-lead sender override that the mailer honours, **so that** sender choice is data on the lead rather than a special case in the engine.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/mailbox` to `server/routes.js` accepting `{ mailbox_id, override }`, workspace-scoped. Keep the flat form of the upstream endpoint out of Harry's API — the ids belong in the path.
- Data model: add a nullable pinned mailbox column to `campaign_leads`.
- `server/mailer.js` resolves the sender as pinned-mailbox-if-set, else rotation; `server/pacing.js` applies that mailbox's quota and gap either way, so a pinned lead can wait rather than fall back.
- Clear the pin automatically when the mailbox leaves the campaign pool or is disconnected, and record it.
- Validate that the mailbox belongs to the workspace and, unless explicitly confirmed, to the campaign pool.
- Write an `events` row naming the actor, lead and mailbox, and a `telemetry` row for the call.

**Definition of done**
- [ ] The pin is honoured by an engine test across multiple ticks.
- [ ] A pinned lead never falls back to another mailbox when the pinned one is capped.
- [ ] Removing the mailbox from the pool clears the pin.
- [ ] Override semantics are tested with and without the flag.

## 6. End-to-end test ticket

**Title:** E2E — pin a lead to a specific sender

**Preconditions:** A workspace with two sandbox mailboxes both in one running campaign's pool, four leads, one with an open thread already sent from the first mailbox.

**Flow**
1. Sign in and open the campaign detail page.
2. Set "Send from" on a fresh lead to the second mailbox.
3. Run the engine and inspect the sent message.
4. Attempt to change the sender on the lead with the open thread and read the warning.
5. Set the second mailbox's daily limit to zero and run the engine again.
6. Remove the second mailbox from the campaign pool.

**Assertions**
- [ ] The message in step 3 comes from the second mailbox.
- [ ] The warning in step 4 explains the thread consequence before any change.
- [ ] In step 5 the pinned lead waits and the campaign page names the mailbox it is waiting on.
- [ ] After step 6 the lead shows "Rotation" again and the change is in the activity trail.
- [ ] Other leads continue to rotate normally throughout.

**Teardown:** Restore the mailbox limit, delete the campaign and leads, clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | "Send from" control per lead row | Medium | Reads "Rotation" by default and lives in the row overflow menu; only pinned rows show an address |
| Leads / Inbox | Same control | Low | Reuses the campaign detail component |
| Campaign header | Count of pinned leads | Low | One short line, shown only when the count is above zero |

**Verdict:** Fits an existing surface

Harry already picks a mailbox per campaign, so per-lead is a refinement of a concept the user has, not a new one. The risk is a setting that hides in a row menu and later surprises someone, which is why the campaign header carries a count and why a mid-thread change always warns.
