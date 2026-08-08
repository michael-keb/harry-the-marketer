# Reply to Email

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/reply-email-thread` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/reply |
| **Auth** | API key (query param `api_key`) |

Sends a human-written reply into an existing email thread with a lead, now or at a chosen time, optionally with a signature, copies and attachments.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member reading a reply, **I want** to answer in my own words from the thread, **so that** a question the playbook does not cover gets a proper human answer without leaving the app.

**Acceptance criteria**
- [ ] Given the message being replied to (`email_stats_id`, with `reply_message_id`, `reply_email_body` and `reply_email_time` for quoting) and an `email_body`, when I send, then the reply goes out from the mailbox that owns the thread and stays in the same email thread rather than starting a new one.
- [ ] Given `to_email` is omitted, when I send, then it defaults to the lead's email; supplying it, along with `to_first_name` and `to_last_name`, replies to a specific person on the thread instead.
- [ ] Given `scheduled_time` in ISO 8601, when I set it, then the reply is queued for that moment and appears in the scheduled queue until it goes; omitting it sends at the next available slot.
- [ ] Given `add_signature: true`, when the reply is composed, then the workspace signature is appended once, and the plain-text opt-out line every Harry send carries is still present.
- [ ] Given `cc` or `bcc` (comma-separated), when I send, then those recipients receive the reply and BCC addresses are never exposed to the others.
- [ ] Given `attachments` with `file_url` required plus `file_name`, `file_type` and `file_size`, when I attach, then only files uploaded through the app are accepted — an arbitrary external URL is refused — and the total size is capped with the limit stated before sending.
- [ ] Given the standing rule, when I press Send, then a confirmation names the recipient, the sending mailbox and the send time, and nothing leaves until I confirm.
- [ ] Given the reply is sent, when it completes, then it appears in the thread as an outbound human message, counts against the mailbox's daily limit, does not advance the playbook by itself, and is written to the activity trail with the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_stats_id": "abc-123", "email_body": "Thanks for your interest! …", "add_signature": true}` to the campaign's reply route | 200; the lead receives the reply in the existing thread with the signature and opt-out line, and it appears in the thread timeline |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the typed reply is preserved |
| TC-3 | Not found / wrong workspace | POST to a campaign id from another workspace | 404; nothing is sent; UI shows "That campaign is not available" |
| TC-4 | Validation failure — empty body | POST with `email_body: ""` | 422 with a field-level message; Send stays disabled in the UI |
| TC-5 | Rate limited | Send several replies in a burst | 429 on the excess; the client backs off with jitter; no duplicate reply is sent for a retried request |
| TC-6 | Empty result set | Open the composer on a thread with no messages yet | Reply is not offered; the thread's empty state explains there is nothing to reply to |
| TC-7 | Scheduled reply | POST with `scheduled_time` set to tomorrow 9am | The reply appears in the scheduled queue, does not send before then, and can be cancelled up to its slot |
| TC-8 | Thread continuity | Send a reply, then have the lead reply again | Both messages sit in one thread in Gmail and in Harry; no new subject thread is created |
| TC-9 | Disconnected mailbox | Revoke the owning mailbox's token, then send | The send fails with "Reconnect this mailbox", linking to Mailboxes; the draft is preserved |
| TC-10 | Attachment from outside the app | POST an attachment whose `file_url` points at an arbitrary external host | Refused with a stated reason; only files uploaded through the app can be attached |
| TC-11 | Playbook untouched | Send a manual reply to a lead sitting at a branch point, then tick the engine | The lead does not advance solely because of the manual reply; any advance comes from the lead's own next reply being classified |
| TC-12 | Daily limit reached | Send when the mailbox has no allowance left | The reply is queued for the next allowed slot with the reason stated, rather than failing or breaching the limit |
| TC-13 | Agreement link | Use "Add agreement link" in the composer | The signed-agreement URL is inserted into the body and the sent message contains exactly that link |

## 4. Frontend user story

**As a** team member, **I want** the thread composer to handle signatures, copies, attachments and scheduling, **so that** replying by hand is a complete tool rather than a plain text box.

**Scope**
- Inbox → Replies thread view: the existing manual reply composer gains an optional CC/BCC row, an attachment picker limited to app-uploaded files with the size limit stated, a signature toggle, and a "Send later" option with a date and time.
- The existing "Add agreement link" action stays where it is in the composer; nothing about it changes.
- Send opens the same confirmation pattern used by Needs your OK, stating recipient, mailbox and time ("Sends from sales@… to John around 2:40pm").
- Loading: the send button shows a pending state and disables; the draft is retained locally until the send confirms. Empty: Send disabled until there is a body. Error: inline banner keeping every field, with a specific action for a disconnected mailbox.
- Accessibility: the body is a labelled textarea; CC/BCC are chip inputs removable by keyboard; the schedule control resolves to a stated absolute time in the browser's timezone; attachment names and sizes are text. Responsive: CC/BCC and attachments collapse behind toggles under 640px.

**Definition of done**
- [ ] Reply, scheduled reply, signature, CC/BCC and attachments all work from the existing composer.
- [ ] Every send passes through a confirmation naming recipient, mailbox and time.
- [ ] A failed send never loses the typed reply.
- [ ] Loading, disabled, error, disconnected-mailbox and scheduled states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** manual replies to go through the same send path as agent emails, **so that** quotas, tracking, logging and the standing rule apply identically.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/threads/:threadId/reply` taking `{ body, cc, bcc, addSignature, sendAt, attachments }`. Workspace-scoped, 404 outside the workspace.
- Data model: a `messages` row with a `kind` of `manual_reply` and the actor recorded, so Reports can separate agent-written from human-written outbound mail. Attachments reference app-uploaded file records; no external URL is ever fetched server-side.
- Sending goes through `server/mailer.js` and Gmail with the correct `In-Reply-To` and `References` headers so thread continuity is preserved on the recipient's side. Manual replies count against the mailbox's daily limit and are placed by `server/pacing.js` like any other send; a `sendAt` in the future is queued and cancellable.
- Every outgoing message keeps the standard tracking pixel, signed click links, the plain-text opt-out line and the `List-Unsubscribe` header, so a manual reply is not a hole in the compliance story.
- Idempotency: the client sends a request key so a retried 429 or timeout cannot produce two replies.
- Logged: an `events` row per manual reply with actor, recipient count and whether it was scheduled; `telemetry` records manual-reply volume per mailbox so Monitoring's delivery view stays complete.

**Definition of done**
- [ ] Route exists with full validation and idempotency, covered by tests including cross-workspace 404.
- [ ] A test asserts thread headers are set so the reply lands in the same Gmail thread.
- [ ] A test asserts the opt-out line and unsubscribe header are present on a manual reply.
- [ ] An engine test asserts a manual reply does not by itself advance the playbook.

## 6. End-to-end test ticket

**Title:** E2E — Answer a question by hand and keep the thread intact

**Preconditions:** A workspace with a sandbox mailbox with allowance remaining, a running campaign, one lead who has replied with a question the playbook has no edge for, approvals on, a workspace signature set in Settings.

**Flow**
1. Open Inbox → Replies and open the lead's thread.
2. Type an answer, leave the signature toggle on, add a CC, and press Send.
3. Read the confirmation and confirm.
4. Check the thread timeline and the Mailboxes page.
5. Return to the thread, type a second reply, choose "Send later" for tomorrow 9am, and confirm.
6. Open the Scheduled view, then cancel the queued reply.

**Assertions**
- [ ] The confirmation named the recipient, the sending mailbox and the send time before anything left.
- [ ] The sent reply appears in the thread as a human message with the actor named, includes the signature once and the plain-text opt-out line, and sits in the same thread as the earlier messages.
- [ ] The mailbox's remaining daily allowance decreased by one.
- [ ] The scheduled reply appears in the Scheduled view with tomorrow 9am in the browser's timezone and does not send.
- [ ] Cancelling removes it with nothing sent, and the activity trail records the sent reply and the cancellation with the actor.

**Teardown:** Delete the campaign and lead; reset the sandbox mailbox counters and recorded sends.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies composer | CC/BCC, attachments, signature toggle and Send later added | High | Everything beyond the body is collapsed behind toggles; the default composer looks exactly like today's |
| Inbox thread timeline | Manual replies labelled with the actor | Low | One line of text on the existing message card |
| Mailboxes | Manual replies count against the daily allowance | Low | Same counter; the tooltip explains what counts |
| Reports | Agent-written and human-written outbound can be separated | Low | Reuses the existing per-campaign rates; no new chart |

**Verdict:** Fits an existing surface

Harry's Inbox already has a manual reply in the thread view, so the core capability exists — what is missing is scheduling, copies, attachments and a signature, which is why replies today are limited to plain answers. The real risk is turning a one-box composer into a mail client, so every addition stays collapsed by default and the send still passes through the same confirmation the approval queue uses.
