# Send Single Email

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/send-email/initiate` |
| **Category** | utilities |
| **Source** | https://api.smartlead.ai/api-reference/utilities/send-single-email |
| **Auth** | API key (query param `api_key`) |

Sends one email to one person from one of your mailboxes, outside any campaign, with an optional attachment.

## 1. Epic

**Sending controls outside the playbook**

The epic covers the two things a Harry workspace needs that no Mermaid diagram describes: a list of addresses and domains that must never be emailed no matter which campaign picks them up, and a way to send a single email outside any playbook. It matters because both are safety questions — one stops Harry contacting someone it should not, and the other is an escape hatch that must never become a way around the standing rule that nothing sends without the user's OK.

## 2. User story

**As a** Harry engineer, **I want** one internal path that sends a single email from a connected mailbox, **so that** team invites, agreement notices and manual replies all go out through the same quota, block list and telemetry as campaign mail.

**Acceptance criteria**
- [ ] Given `to`, `subject` and `body`, plus either `fromEmail` or `fromEmailId`, when the send is requested, then a `{"success": true, "data": {"message": "...", "message_id": "..."}}` shape is returned and the `message_id` is stored so the thread can be followed.
- [ ] Given neither `fromEmail` nor `fromEmailId` is supplied, when the send is requested, then a 422 `{"error": "Invalid parameters provided"}` names the missing sender and nothing is sent.
- [ ] Given `fromEmailId` names a mailbox that is not connected or belongs to another workspace, when the send is requested, then a 404 `{"error": "Resource not found"}` is returned and nothing is sent.
- [ ] Given the recipient is on the block list, when the send is requested, then it is refused with a plain reason and one `events` row — the suppression list must apply to one-off sends exactly as it applies to campaign sends.
- [ ] Given the mailbox has reached its daily limit, when the send is requested, then a one-off send is refused with the reason and the time it becomes possible, rather than quietly exceeding the limit that protects the domain.
- [ ] Given this endpoint is exposed to a user-facing surface, when a send is initiated from the UI, then the standing rule still applies: the email is composed into `drafts` and needs an explicit OK. Only Harry's own system mail — team invites, the agreement notice, tracking-related notifications — sends without an approval step.
- [ ] Given `attachments` is supplied as objects with `filename`, `content` (base64) and `mimeType`, when the send succeeds, then the attachment arrives intact; given the total size exceeds the limit or the MIME type is not allowed, then a 422 names `attachments` and nothing is sent.
- [ ] Given `replyTo` and `fromName` are supplied, when the email is delivered, then both are honoured, and every send still carries the plain-text opt-out line and List-Unsubscribe header Harry attaches to outgoing mail.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"to": "recipient@example.test", "subject": "Welcome", "body": "<h1>Hello!</h1>", "fromEmail": "sender@example.test", "fromName": "Harry", "replyTo": "support@example.test", "attachments": []}` | 200 `{"success": true, "data": {"message_id": "..."}}`; the sandbox mailbox records one send |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; nothing sent |
| TC-3 | Not found / wrong workspace | POST with a `fromEmailId` from another workspace | 404 `{"error": "Resource not found"}`; nothing sent, no mailbox address echoed |
| TC-4 | Validation failure | POST with `to` and `subject` but no `body`, then with no sender at all | 422 `{"error": "Invalid parameters provided"}` each time, naming the missing field |
| TC-5 | Rate limited | POST 20 sends in one second | 429 with `Retry-After`; no send is duplicated by the retry |
| TC-6 | Empty result set | POST with an empty `attachments` array | 200; the email sends with no attachment and no error |
| TC-7 | Blocked recipient | Block `example.test`, then POST a send to `ana@example.test` | Refused with the block reason; one `events` row; nothing leaves the mailbox |
| TC-8 | Daily limit reached | Exhaust the sandbox mailbox's daily allowance, then POST | Refused with the reason and the time it becomes possible; the limit is not exceeded |
| TC-9 | Approval rule | Trigger a one-off send from a user-facing surface | A draft is created awaiting OK; no email leaves until it is approved |
| TC-10 | Attachment too large | POST an attachment above the size limit | 422 naming `attachments`; nothing sent, nothing partially uploaded |
| TC-11 | Bad MIME type | POST an attachment with an executable MIME type | 422 naming `attachments` and the allowed types |
| TC-12 | Unsubscribe furniture | Inspect a successfully sent one-off email | The plain-text opt-out line and the List-Unsubscribe header are present |

## 4. Frontend user story

**As a** marketer, **I want** nothing new on screen for this, **so that** Harry does not grow a second way to send email alongside the playbooks that are the point of the product.

**Scope**
- No new page, no new navigation item, no compose button. The two places a person can already cause a single email are unchanged: the Inbox's manual reply in a thread, and Settings → Team's invite by email. Both route through this path instead of their own code.
- The only visible consequence is consistency: a manual reply now respects the block list and the mailbox's daily limit and appears in the same telemetry as campaign mail, and a refusal is explained in the same words.
- Loading, empty and error states are those of the surfaces that already exist; nothing new is introduced.
- Accessibility: unchanged, because no new control is added.

**Definition of done**
- [ ] No new user-facing surface ships with this story.
- [ ] Manual reply and team invite both call the shared path.
- [ ] A refusal (blocked recipient, limit reached) is shown in the surface that initiated it, in plain language.
- [ ] No compose-from-scratch entry point is added anywhere.

## 5. Backend user story

**As a** Harry engineer, **I want** a single internal send function used by every non-campaign email, **so that** quotas, suppression, tracking furniture and telemetry can never be bypassed by a new feature.

**Scope**
- Route: an internal `POST /api/send/one-off` in `server/routes.js`, session-scoped and not part of any public integration surface. Body: `to`, `subject`, `body`, `fromEmail` or `fromMailboxId`, `fromName`, `replyTo`, `attachments`.
- Data model: none new. The send is recorded in `messages` exactly as a campaign send is, with a null campaign, so the Inbox thread view and Reports keep working without special cases.
- Implementation sits in `server/mailer.js` beside the existing provider dispatch (gmail | sandbox) so it inherits the daily limit, the sending rhythm's daily allowance, the block-list check, the open pixel, signed click links, the opt-out footer and the List-Unsubscribe header. A one-off send skips the pacing gap — it is a person acting now, not a queue — but never the daily limit.
- Attachments are validated for size and MIME type before any provider call; base64 is decoded once and streamed, never held twice.
- Rate limited per mailbox. Logged: send, refusal and reason to `events`; latency and provider outcome to `telemetry`, so Monitoring's delivery telemetry covers one-off mail too.

**Definition of done**
- [ ] Every non-campaign email in the codebase goes through this one function, verified by a test that asserts no other module calls the provider directly.
- [ ] The block list and the daily limit both apply, each covered by a test.
- [ ] The opt-out line and List-Unsubscribe header are present on a one-off send.
- [ ] Sandbox mailboxes record the send locally and are usable in E2E without credentials.

## 6. End-to-end test ticket

**Title:** E2E — One-off send through the shared path

**Preconditions:** A workspace with a sandbox mailbox at a low daily limit, one lead with an existing reply thread in the Inbox, one blocked domain, and a teammate email address for an invite.

**Flow**
1. Sign in and open the Inbox thread.
2. Write a manual reply and send it.
3. Invite a teammate from Settings → Team.
4. Attempt a manual reply to a lead at the blocked domain.
5. Exhaust the mailbox's daily limit, then attempt another manual reply.
6. Open Monitoring.

**Assertions**
- [ ] The manual reply appears in the thread and in the sandbox mailbox's recorded sends.
- [ ] The invite is delivered through the same path and appears in delivery telemetry.
- [ ] Step 4 is refused with the block reason shown in the thread, and nothing is sent.
- [ ] Step 5 is refused with the daily-limit reason and the time it becomes possible.
- [ ] Monitoring's delivery telemetry includes both the reply and the invite.
- [ ] No new page, button or navigation item exists anywhere in the app after the change.

**Teardown:** Delete the sent messages, revoke the invite, clear the block-list entry and the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox manual reply | Same control, now refusing blocked recipients and respecting the daily limit | Low | Behaviour change only; the refusal reuses the wording campaigns already use |
| Settings → Team invite | Same control, routed through the shared path | Low | No visible change |
| Everywhere else | Nothing | Low | No compose screen, no send button, no navigation item |

**Verdict:** Invisible — no UI

This is plumbing, and it should stay plumbing. Harry's whole proposition is that outreach is a diagram executed by an agent with a human approving each email; a general "send an email" screen would quietly compete with that and would be the obvious place for someone to route around the standing rule. The right shape is one shared internal function behind the two surfaces that already exist.
