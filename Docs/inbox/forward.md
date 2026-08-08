# Forward Email

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/forward-email` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/forward |
| **Auth** | API key (query param `api_key`) |

Sends a copy of one message from a lead's thread on to other people, with an optional note of your own above the forwarded chain.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member working a reply, **I want** to forward the thread to a colleague or an expert with a line of my own on top, **so that** a question I cannot answer reaches the person who can without me copying and pasting an email chain.

**Acceptance criteria**
- [ ] Given a message in a thread (`message_id` plus its `stats_id`) and one or more recipients in `to_emails` (comma-separated), when I forward it, then the mailbox that owns the thread sends the forward and the response confirms with the generated `messageId` and `status: "success"`.
- [ ] Given I omit `forward_email_body` and `forward_email_subject`, when I forward, then only the auto-generated forwarded chain is sent and the original campaign subject is reused, matching the documented backwards-compatible behaviour.
- [ ] Given I supply `forward_email_body` and `forward_email_subject`, when I forward, then my text is placed above the forwarded chain and my subject replaces the original.
- [ ] Given `cc_emails` or `bcc_emails`, when I forward, then those recipients receive the copy and BCC addresses are never visible to the other recipients.
- [ ] Given a forward is composed, when I press Forward, then a confirmation naming every To, CC and BCC recipient is shown before anything leaves — the standing rule that nothing sends without an explicit OK applies to forwards exactly as it does to campaign emails.
- [ ] Given a malformed address anywhere in `to_emails`, `cc_emails` or `bcc_emails`, when I submit, then the request is rejected with a field-level message naming the bad address and nothing is sent.
- [ ] Given the mailbox that owns the thread has been disconnected, when I forward, then the send fails with a clear "Email account not found" style message and the composed forward is preserved for retry.
- [ ] Given a forward is sent, when it completes, then it is recorded in the thread as a forward (not a reply to the prospect), does not advance the playbook, and is written to the activity trail with the actor and recipients.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, defaults only | POST `{"message_id": "msg-abc-123", "stats_id": "stats-abc-123", "to_emails": "manager@company.com"}` to the campaign's forward route | 200, `{"ok": true, "messageId": "...", "status": "success"}`; recipient receives the forwarded chain under the original subject |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the composed forward is preserved |
| TC-3 | Not found / wrong workspace | POST to a campaign id from another workspace | 404; UI shows "That campaign is not available"; nothing sent |
| TC-4 | Validation failure — wrong type | POST `forward_email_body: 12345` | 400, `{"message": "\"forward_email_body\" must be a string"}`; the field is flagged in the composer |
| TC-5 | Rate limited | Forward the same thread repeatedly in a burst | 429 on the excess; the client backs off and shows one "Retrying…" state; no duplicate forwards are sent |
| TC-6 | Empty result set | Open the forward dialog on a thread with no messages yet | The dialog is not offered; the thread's empty state explains there is nothing to forward |
| TC-7 | Custom subject and body with CC and BCC | POST with `forward_email_subject: "FYI – please review"`, `forward_email_body: "<p>Sharing this thread.</p>"`, `cc_emails`, `bcc_emails` | 200; recipient sees the custom subject, the note above the chain, the CC address in headers and no trace of the BCC address |
| TC-8 | Disconnected mailbox | Revoke the owning mailbox's token, then forward | 500-class response `{"ok": false, "error": "Email account not found!"}`; UI shows "Reconnect this mailbox" with a link to Mailboxes and keeps the draft |
| TC-9 | Malformed recipient | POST `to_emails: "manager@company.com,not-an-email"` | 400 naming the bad address; nothing is sent to either recipient |
| TC-10 | Playbook untouched | Forward a message on a lead sitting at a branch point, then let the engine tick | The lead stays at the same node; no edge is followed and no campaign email is composed as a result |
| TC-11 | Forwarding does not leak notes | Forward a thread that has internal notes attached | The forwarded body contains the email chain only; no internal note text appears |

## 4. Frontend user story

**As a** team member, **I want** a Forward action on any message in the Inbox thread view with a confirmation of exactly who receives it, **so that** sharing a conversation is one step and never a surprise.

**Scope**
- Inbox → Replies thread view: a "Forward" action on each message, opening the existing manual-reply composer in forward mode with a To field (plus expandable CC and BCC), a subject prefilled from the original, and a note box above a read-only preview of the forwarded chain.
- The send button reads "Forward" and opens the same confirmation pattern used by Needs your OK, listing every recipient and the sending mailbox.
- Loading: the send button shows a pending state and disables. Empty: recipients required before Forward enables. Error: inline banner keeping the typed note and recipients; a disconnected mailbox links to Mailboxes.
- Forwarded messages appear in the thread timeline with a distinct "Forwarded to …" label so the thread never reads as if the prospect received it.
- Accessibility: recipient fields are labelled inputs with chips that are removable by keyboard; the confirmation is a labelled modal with focus trap; the forwarded-message label is text, not an icon alone. Responsive: CC and BCC collapse behind a "Add CC/BCC" toggle under 640px.

**Definition of done**
- [ ] Forward is reachable from any message in a thread and reuses the existing composer rather than a new one.
- [ ] The confirmation lists every To, CC and BCC recipient and the sending mailbox before anything is sent.
- [ ] Sent forwards render in the timeline labelled as forwards, visually distinct from replies.
- [ ] Loading, validation-error, disconnected-mailbox and rate-limited states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that forwards a stored message through the thread's own mailbox, **so that** sharing a conversation uses the same send path, quotas and logging as everything else.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/messages/:messageId/forward` taking `{ to, cc, bcc, subject, note }`, workspace-scoped and 404 on any id outside the caller's workspace.
- Data model: no new table; a `messages` row is written with a `kind` of `forward`, the recipient list, and the actor, so the thread timeline and the activity trail both read from existing storage.
- Sending goes through `server/mailer.js` and Gmail as usual. Forwards count against the mailbox's daily limit — they are real sends — but they bypass `server/pacing.js` gaps because a human is waiting, and the reason is recorded.
- The forwarded chain is built server-side from stored messages so the client cannot inject arbitrary content into it; the user's `note` is sanitised before being placed above it.
- Retry: a 429 or transient Gmail failure is retried with backoff and jitter; a permanent failure (revoked token) returns the "Email account not found" style error unretried.
- Logged: an `events` row per forward with actor, message, campaign and recipient count; `telemetry` records forward sends per mailbox so Monitoring's delivery view stays accurate.

**Definition of done**
- [ ] Route exists, is workspace-scoped, and is covered by tests including cross-workspace 404 and malformed-recipient rejection.
- [ ] A forward never advances the playbook — asserted by an engine test.
- [ ] Forwards are counted in the mailbox's daily allowance and appear in Monitoring telemetry.
- [ ] Internal notes and tracking pixels are excluded from the forwarded body, asserted by a test.

## 6. End-to-end test ticket

**Title:** E2E — Forward a prospect's reply to a colleague without touching the playbook

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, one lead that has replied with a technical question so a thread exists in Inbox → Replies, and a second sandbox mailbox standing in for the colleague's address.

**Flow**
1. Open Inbox → Replies and select the lead's thread.
2. Choose Forward on the prospect's reply.
3. Enter the colleague's address in To, add a CC, type "Can you take this one?" as the note, and leave the subject as prefilled.
4. Press Forward and confirm in the dialog.
5. Let the engine tick twice.
6. Open Dashboard → activity trail.

**Assertions**
- [ ] The confirmation listed both recipients and the sending mailbox before the send.
- [ ] The colleague's sandbox mailbox received one message containing the note above the original chain.
- [ ] The thread timeline shows the forward labelled "Forwarded to …", clearly not a reply to the prospect.
- [ ] After the ticks the lead is still at the same playbook node and no campaign email was composed.
- [ ] The activity trail contains one forward entry naming the actor and recipient count.

**Teardown:** Delete the campaign and lead; clear the sandbox mailboxes' recorded sends and counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | Forward action per message plus forward mode in the composer | Medium | Reuses the manual-reply composer with a mode switch instead of a second composer; the action lives in the per-message overflow menu |
| Inbox thread timeline | Forwarded messages rendered with a label | Low | Same message card, one extra line of text |
| Mailboxes | Daily allowance now includes forwards | Low | Same counter, no new control; the tooltip explains what counts |
| Dashboard activity trail | Forward entries appear | Low | One more event type in a mixed feed |

**Verdict:** Fits an existing surface

Harry's Inbox already has a manual reply composer and a thread view, so forwarding is a mode of something that exists rather than a new place. The genuinely new part is that a send now goes to someone other than the lead, which is why the confirmation reuses the Needs your OK pattern — the standing rule should not have an exception just because the recipient is a colleague.
