# Forward Campaign Email

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/forward-email` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/forward-email |
| **Auth** | API key (query param `api_key`) |

Sends a copy of an existing campaign email on to someone else, keeping the original thread's context.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** person working the Inbox, **I want** to forward a reply to a colleague, **so that** the right person can pick up a thread that is not mine to answer — without copying and pasting the conversation into another tool.

**Acceptance criteria**
- [ ] Given a thread in the Inbox, when I forward one of its messages to one or more addresses, then the forward is sent from the same mailbox that owns the thread and the response confirms success (the source API returns `{"success": true}`).
- [ ] Given the forward is sent, when the recipient opens it, then it contains the original message's subject prefixed as a forward, the original sender, date and recipients, and the message body in full.
- [ ] Given a forward is a real send, when I request it, then it obeys the standing rule: I compose or confirm the text myself and press send — the agent never forwards anything on its own.
- [ ] Given a forward goes to a colleague, when it is sent, then it does not carry the outreach footer, the tracking pixel, the click-wrapped links or the unsubscribe header, because it is not marketing to the recipient.
- [ ] Given the forward is sent, when the engine next ticks, then the lead's position in the playbook is unchanged — forwarding is a side conversation, not a playbook step.
- [ ] Given the forward is sent, when I look at the thread, then it shows as a distinct entry ("Forwarded to sam@ourcompany.com by Alex, 2:31pm") and the same entry appears in the activity trail.
- [ ] Given an invalid or empty recipient list, when I submit, then I get a field-level validation error and nothing is sent.
- [ ] Given the mailbox is at its daily limit, when I forward, then the forward is still allowed but counted, and the campaign's own sends absorb the cost — the user is told what the forward used.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST the forward for a known campaign and message with one recipient and a short note | 200, `{"success": true}`; the recipient receives the forwarded message with the original body intact |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; nothing sent, the composed note preserved in the UI |
| TC-3 | Not found / wrong workspace | Forward a message id from another workspace's campaign | 404; nothing sent |
| TC-4 | Validation failure | POST with an empty recipient list, and separately with `sam@@example` | 422 with a field-level message on the recipient field in both cases |
| TC-5 | Rate limited | Forward the same thread repeatedly in a burst | 429 on the excess; the UI disables the send button and explains, rather than sending twice |
| TC-6 | Empty result set | Open the forward action on a thread with no messages yet | The action is unavailable with "Nothing to forward yet" |
| TC-7 | No tracking on forwards | Forward a message and inspect the delivered content | No open pixel, no click-wrapped links, no unsubscribe footer or header |
| TC-8 | Playbook unaffected | Forward a message on a live lead, then let the engine tick twice | The lead is on the same node with the same next-send time as before the forward |
| TC-9 | Multiple recipients | Forward to three addresses | One send per the mailer's rules, all three receive it, and the thread records all three |
| TC-10 | Forwarding to the lead themself | Enter the lead's own address as a recipient | Blocked with a clear message, since that would be a reply, not a forward |
| TC-11 | Unsubscribed lead's thread | Forward a message from a thread whose lead has unsubscribed | Allowed to a colleague, because the recipient is not the lead; refused if the recipient is the lead |
| TC-12 | Mailbox disconnected | Forward from a thread whose mailbox has lost its token | Refused with "Reconnect this mailbox" and a link to Mailboxes; nothing queued |

## 4. Frontend user story

**As a** person working the Inbox, **I want** a Forward action in the thread view, **so that** handing a conversation to a colleague takes the same effort as replying.

**Scope**
- Inbox → thread view: a "Forward" action beside the existing manual reply, opening a compose panel prefilled with the quoted original and an empty note field, plus a recipient field with type-ahead over workspace team members.
- The panel states which mailbox the forward will be sent from and that it will not carry tracking or an unsubscribe footer, in one short line.
- Sending shows the same confirmation pattern as a manual reply; the forward then appears inline in the thread as its own entry.
- Loading: send button shows progress and disables. Empty: forward is unavailable on an empty thread. Error: message shown in the panel with the composed text preserved.
- Accessibility: the compose panel is a labelled region with focus moved to the recipient field on open, Escape to close with a discard confirmation if text was typed; recipients are shown as removable chips with accessible names. Responsive: the panel is full-screen under 640px.

**Definition of done**
- [ ] Forward is available on any thread with at least one message.
- [ ] Recipients support team-member type-ahead and free-typed addresses with validation.
- [ ] The forward appears in the thread and in the activity trail.
- [ ] The lead's own address is refused as a forward recipient.

## 5. Backend user story

**As a** Harry API, **I want** a forward route that sends through the existing mailer without touching playbook state, **so that** a human hand-off never disturbs the agent's run.

**Scope**
- Route in `server/routes.js`: `POST /api/threads/:messageId/forward` taking `{ to: [], note? }`, workspace-scoped, alongside the existing manual reply handler.
- Data model: a `messages` row of kind `forward` linked to the original message and the campaign, with the recipient list stored. No change to `campaign_leads`, so the lead's node and next-send time are untouched.
- Sending goes through `server/mailer.js` using the thread's own mailbox, with tracking, click wrapping and the unsubscribe footer explicitly disabled for this kind. The daily quota is decremented as for any send. Sandbox mailboxes record forwards locally like other sends.
- No pagination. Standard rate limiting; the route is not retried automatically, because a duplicate forward is worse than a missing one.
- Logged: an `events` row with actor, original message, campaign, and recipients; `telemetry` records forward sends and failures per mailbox.

**Definition of done**
- [ ] Forwards never carry tracking, click wrapping or unsubscribe headers, covered by a test on the composed payload.
- [ ] An engine test asserts the lead's playbook position and next-send time are unchanged by a forward.
- [ ] Forwarding to the lead's own address is refused server-side, not just in the UI.
- [ ] Forwards count against the mailbox's daily limit.

## 6. End-to-end test ticket

**Title:** E2E — Hand a reply to a colleague without disturbing the playbook

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, one lead who has replied, a second team member invited in Settings → Team, and approvals on.

**Flow**
1. Open Inbox and select the thread with the reply.
2. Note the lead's current playbook node and next-send time on the campaign page.
3. Press Forward, type the colleague's address, add a one-line note and send.
4. Reopen the thread.
5. Let the engine tick twice and recheck the campaign page.
6. Try forwarding the same message to the lead's own address.

**Assertions**
- [ ] The forward appears in the thread as its own entry naming who forwarded it and to whom.
- [ ] The sandbox record of the forward contains the quoted original and no tracking pixel or unsubscribe footer.
- [ ] The lead's node and next-send time are identical before and after.
- [ ] The activity trail shows the forward with the actor.
- [ ] Forwarding to the lead's own address is refused with a clear message.

**Teardown:** Delete the campaign and the forwarded sandbox message; leave the team member in place.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → thread view | Forward action and compose panel | Medium | Sits beside the existing manual reply and reuses its compose component and send confirmation |
| Inbox thread timeline | Forward entries appear inline | Low | Same row shape as a sent message, with a different label |
| Mailboxes | Forwards count toward the daily limit | Low | Existing counter, no new element |

**Verdict:** Fits an existing surface

The Inbox thread view already has manual reply and "Add agreement link", so Forward joins an established row of thread actions rather than creating anywhere new to go. The important design decision is invisible: forwards are excluded from tracking and unsubscribe machinery, because a colleague is not a prospect.

**Note on source coverage:** the upstream documentation for this endpoint is explicitly incomplete — it names no request fields at all, says the body is "likely similar to reply-email-thread", ships a cURL example with an empty body, and carries a warning that the schema needs verification against the controller. The recipient, note and message-reference fields described above are therefore Harry's own design, not a mirror of a documented payload, and must be confirmed against a live response before build.
