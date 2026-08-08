# Reply to Campaign Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/reply-email-thread` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/reply-email-thread |
| **Auth** | API key (query param `api_key`) |

Sends a human-written reply into an existing conversation with a lead, keeping it in the same thread and counting it in the campaign's numbers.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner reading a reply, **I want** to answer in my own words in the same thread, **so that** I can take over a conversation the agent should not handle without leaving Harry or breaking the thread.

**Acceptance criteria**
- [ ] Given a thread with a prior message, when I send a reply with `email_body` and the id of the message I am answering, then it goes out in the same thread and appears in the Inbox thread view immediately.
- [ ] Given the reply is sent, when the campaign's numbers are recalculated, then the reply is counted as an outbound message on that campaign and attributed to the playbook step it answers.
- [ ] Given optional recipients are supplied (`cc`, `bcc` as comma-separated lists, or an override `to_email`), when the reply is sent, then those recipients are honoured and recorded in the thread view.
- [ ] Given `add_signature` is true, when the reply is composed, then the workspace signature is appended once, never twice.
- [ ] Given `scheduled_time` is supplied in ISO 8601, when the time arrives, then the reply is sent by the same engine path as any other send, respecting the sending rhythm and working hours.
- [ ] Given `email_body` is empty or the target message id is unknown, when I send, then the request is rejected with a field-level message and nothing is sent.
- [ ] Given attachments are supplied, when the reply is sent, then each attachment's name, type and size is recorded and oversized or disallowed types are rejected before sending.
- [ ] Given the lead is unsubscribed, when I attempt a reply, then it is refused, because unsubscribe is always honoured.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Open a thread with a reply from the lead, send "Happy to help! Let me know your questions." with `add_signature: true` | 200 `{ success: true, message: "Reply sent successfully" }`; the message appears in the thread with the signature once |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the composer keeps the drafted text so nothing is lost |
| TC-3 | Not found / wrong workspace | Reply referencing a message id from another workspace's thread | 404; nothing sent |
| TC-4 | Validation failure | Send with `email_body: ""` | 422 with a message naming `email_body`; the send button stays disabled until text is entered |
| TC-5 | Rate limited | Send several replies in quick succession | 429 on the excess; the client queues and retries, and no duplicate reply is sent |
| TC-6 | Empty result set | Open a lead with no messages yet and look for the reply control | The control is absent or disabled with "No conversation yet"; there is nothing to reply to |
| TC-7 | Scheduled reply | Send with `scheduled_time` two hours out | Reply is queued, shown as scheduled in the thread with its time, and sent at the right moment inside working hours |
| TC-8 | Signature duplication | Type a signature manually and set `add_signature: true` | Harry detects the duplicate block and warns before sending |
| TC-9 | CC and BCC | Send with `cc: "a@x.com,b@x.com"` and one BCC | Both CCs are visible in the thread view; the BCC is recorded but not shown to the recipient |
| TC-10 | Attachment rejected | Attach a file above the size limit | Rejected before sending with a clear limit stated; the drafted text is preserved |
| TC-11 | Unsubscribed lead | Attempt a reply to an unsubscribed lead | Refused with an explanation; no message is created |
| TC-12 | Thread integrity | Send the reply, then check the recipient's mailbox | The reply is threaded under the original, not a new conversation |

## 4. Frontend user story

**As a** campaign owner, **I want** a proper reply composer in the Inbox thread, **so that** taking over from the agent feels like using an email client, not filing a form.

**Scope**
- Inbox thread view: the existing manual reply control becomes a full composer with body, optional CC/BCC (hidden behind a link), signature toggle, attachments, and a "Send later" option that takes a date and time.
- Dashboard Action Center: the same composer opens in place for a lead parked for a decision.
- The "Add agreement link" action that already exists in the thread inserts into this composer.
- Loading disables send and shows progress inline; failure keeps the body text and shows the reason next to the button. Scheduled replies appear in the thread as pending with a cancel action.
- Accessibility: the composer is a labelled form, the signature toggle is a real checkbox, attachments announce name and size, and the scheduled state is described in text. On mobile the composer expands to full height with the send action pinned.

**Definition of done**
- [ ] A reply never opens a new thread.
- [ ] Draft text survives every failure path.
- [ ] Scheduled replies are visible and cancellable before they go.
- [ ] Replying to an unsubscribed lead is impossible from the UI.

## 5. Backend user story

**As a** Harry server, **I want** one route that sends a human reply into an existing thread, **so that** manual and agent sends share the same delivery, pacing and tracking path.

**Scope**
- Add `POST /api/campaigns/:id/threads/:messageId/reply` to `server/routes.js`, workspace-scoped, accepting body, `cc`, `bcc`, `add_signature`, `scheduled_time` and attachments.
- Route through `server/mailer.js` exactly as an agent send does, so threading headers, the opt-out line, the List-Unsubscribe header, tracking pixel and signed click links are all applied identically.
- Data model: reuse `messages`; store the scheduled time and the actor. No new table.
- Enforce the unsubscribe check, attachment size and type limits, and the daily mailbox quota; a scheduled reply respects working hours and the pacing gap.
- Write an `events` row naming the actor and whether the text was edited from an agent draft, and a `telemetry` row for send latency and failures.

**Definition of done**
- [ ] Manual replies carry the same footers and headers as agent sends.
- [ ] Scheduled replies obey pacing and can be cancelled.
- [ ] Unsubscribed leads cannot be replied to, proven by a test.
- [ ] Reply counts appear in Reports attributed to the correct playbook step.

## 6. End-to-end test ticket

**Title:** E2E — take over a conversation with a manual reply

**Preconditions:** A workspace with a sandbox mailbox, one running campaign, one lead who has replied, a workspace signature configured, and a second lead who is unsubscribed.

**Flow**
1. Sign in, open Inbox, and open the replying lead's thread.
2. Compose a reply, enable the signature, add one CC, and send.
3. Reload the thread.
4. Compose a second reply and schedule it two hours out, then cancel it.
5. Open the unsubscribed lead's thread and attempt a reply.
6. Open Reports.

**Assertions**
- [ ] The sent reply appears in the same thread with the signature once and the CC visible.
- [ ] The opt-out line and unsubscribe header are present on the sent message.
- [ ] The scheduled reply shows as pending and disappears on cancel with nothing sent.
- [ ] The unsubscribed lead's composer is unavailable with a stated reason.
- [ ] Reports counts the manual reply against the campaign and the correct step.

**Teardown:** Delete the campaign, leads and messages; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox thread | Manual reply grows into a full composer | High | CC/BCC, attachments and scheduling all start hidden; the default view is a body box and a send button |
| Action Center | Same composer inline | Low | Reuses the Inbox component, no separate implementation |
| Reports | Manual replies attributed to steps | Low | Existing Learning section absorbs them with no new chart |

**Verdict:** Fits an existing surface

The Inbox already has manual reply and the agreement-link insert, so this deepens a control rather than adding one. The bloat risk is real and the mitigation is discipline: everything beyond the body box and send stays behind a link until asked for, so the common case still looks like one text area.
