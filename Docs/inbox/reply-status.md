# Get Reply Status

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/master-inbox/reply-status` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/reply-status |
| **Auth** | API key (query param `api_key`) |

Tells you what happened to one reply you sent — whether it went, when, and if it is still waiting for a scheduled slot.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member who has just sent a reply, **I want** to see whether it actually left, **so that** I am not left wondering after a slow send or a mailbox problem.

**Acceptance criteria**
- [ ] Given the RFC 5322 `message_id` of a reply (angle-bracket form, e.g. `<uuid@domain.com>`), when I query its status, then I get `ok: true` with `data.status`, a human-readable `data.status_message`, the `data.event_time`, the `data.scheduled_time` (null when it was sent immediately) and the `data.email_stats_id` for correlating with analytics.
- [ ] Given a status of `COMPLETED`, when it renders, then the thread shows "Sent" with the event time; the `status_message` ("Email sent successfully!") is used verbatim only when it is genuinely readable, otherwise Harry's own plain wording is shown.
- [ ] Given a `scheduled_time` that has not yet passed, when it renders, then the message shows as queued with that time in the browser's timezone, matching the scheduled queue.
- [ ] Given a `message_id` with no matching reply, when I query it, then I get 404 with `ok: false` and the UI states the message could not be tracked rather than implying failure to deliver.
- [ ] Given a missing or malformed `message_id`, when I query, then I get 422 naming the parameter.
- [ ] Given a send failed, when the status is read, then the failure reason is shown in words with the next step ("Reconnect this mailbox", "Daily limit reached — queued for tomorrow"), never a raw provider error string.
- [ ] Given a status is polled after a send, when the status settles, then polling stops — the client does not poll indefinitely for a message that has reached a terminal state.
- [ ] Given "sent" means accepted by Gmail, when the UI says Sent, then it says exactly that and does not claim the recipient received or read it, since only the open pixel could suggest that and it is not proof.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET …/reply-status?message_id=<4d9ff292-…@dealversego.co>` for a delivered reply | 200, `ok: true`, `data.status: "COMPLETED"`, `status_message`, `event_time`, `scheduled_time: null`, `email_stats_id` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401, `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again" |
| TC-3 | Not found | Query a `message_id` that was never sent from this workspace | 404, `{"ok": false, "error": "No reply found for the given message_id"}`; UI says the message cannot be tracked, not that it failed |
| TC-4 | Validation failure | Query with no `message_id` | 422 naming the parameter |
| TC-5 | Rate limited | Poll status every 500ms after a send | 429 on the excess; the client backs off with jitter and lengthens its interval rather than hammering |
| TC-6 | Empty result set | Open a thread whose messages predate status tracking | The status column shows "Not tracked" for those messages, with no error and no spinner |
| TC-7 | Scheduled reply | Query a reply scheduled for tomorrow 9am | `scheduled_time` is populated, `status` is not terminal, and the thread shows "Queued for tomorrow 9:00am" in the browser's timezone |
| TC-8 | URL encoding | Query with the angle brackets and `@` percent-encoded | 200, identical to TC-1; the client always encodes the id rather than relying on the caller |
| TC-9 | Failure with a reason | Query a reply whose mailbox token was revoked mid-send | The status reports the failure and the UI shows "Reconnect this mailbox" with a link, not a raw provider error |
| TC-10 | Polling stops | Send a reply and let it reach `COMPLETED` | The client stops polling within one interval of the terminal status |
| TC-11 | Honest wording | Inspect the UI for a `COMPLETED` reply that was never opened | The UI says "Sent", not "Delivered to inbox" or "Read" |

## 4. Frontend user story

**As a** team member, **I want** each outbound message in a thread to show its own send state, **so that** "did that go?" is answered on the screen I am already looking at.

**Scope**
- Inbox → Replies thread view: every outbound message carries a small state line — Queued (with the time), Sending, Sent (with the time), or Failed (with the reason and the next step).
- After sending, the composer's message enters the timeline immediately in the Queued or Sending state and updates in place; polling backs off and stops at a terminal state.
- Failed messages offer Retry, which reuses the original body rather than asking the user to retype.
- Loading: the state line reads Sending with no separate spinner. Empty: older messages with no tracking data read "Not tracked". Error: the state line itself is the error surface; no toast is used, so the information stays with the message.
- Accessibility: state is text with an absolute timestamp in the accessible name; changes are announced politely, not assertively, so a screen reader user is not interrupted while reading. Responsive: the state line sits under the message meta on narrow screens.

**Definition of done**
- [ ] Every outbound message shows an accurate state that updates in place.
- [ ] Failures state the cause and the next step, with a Retry that keeps the original text.
- [ ] Wording never overstates delivery — "Sent" means accepted by Gmail.
- [ ] Queued, sending, sent, failed and not-tracked states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** per-message send state stored and queryable by message id, **so that** the UI and support can both answer what happened to a specific email.

**Scope**
- Route in `server/routes.js`: `GET /api/messages/:messageId/status` accepting either Harry's internal id or the RFC 5322 Message-ID, returning `{ status, statusMessage, eventTime, scheduledAt }`. Workspace-scoped, 404 for anything outside the workspace with the same body as a genuine miss.
- Data model: `send_status`, `status_reason`, `status_at`, `scheduled_at` and `provider_message_id` on the `messages` row in `server/db.js`, indexed on `provider_message_id` for lookup. Statuses are a small, closed set — queued, sending, sent, failed — mapped from the Gmail response by `server/mailer.js`.
- Failure reasons are normalised into Harry's own wording with a next step attached, so no raw provider string reaches the UI; the raw string is kept in `telemetry` for support.
- Retry: transient Gmail failures are retried by the mailer with backoff and jitter before the message is marked failed, so a user-visible failure means retrying was already attempted. A retried send reuses the same idempotency key.
- Logged: status transitions are written to `telemetry` (not `events`, to avoid flooding the activity trail), with a per-mailbox failure rate that Monitoring already displays alongside delivery telemetry.

**Definition of done**
- [ ] Status columns, index and route exist, covered by tests including cross-workspace 404.
- [ ] A test asserts every provider failure maps to one of Harry's normalised reasons with a next step.
- [ ] A test asserts a terminal status is stable and stops further polling.
- [ ] Failure rate per mailbox appears in Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Know whether a reply actually left

**Preconditions:** A workspace with two sandbox mailboxes — one healthy, one whose token will be revoked mid-test — a running campaign, one lead who has replied, approvals on.

**Flow**
1. Open Inbox → Replies, open the thread, write a reply and send it.
2. Watch the message's state line without refreshing.
3. Send a second reply scheduled for tomorrow 9am.
4. Revoke the second mailbox's token, then send a reply on a thread it owns.
5. Use Retry on the failed message after reconnecting.
6. Open Monitoring.

**Assertions**
- [ ] The first message moved from Sending to Sent in place, with an absolute time, and polling stopped once it settled.
- [ ] The scheduled message shows Queued with tomorrow 9am in the browser's timezone and appears in the Scheduled view.
- [ ] The failed message states "Reconnect this mailbox" with a link, not a raw provider error, and its text was preserved.
- [ ] Retry sent the original text once, with no duplicate reaching the recipient.
- [ ] Monitoring shows the failure against the right mailbox and the activity trail is not flooded with status transitions.

**Teardown:** Cancel the scheduled reply, delete the campaign and lead, restore and reset both sandbox mailboxes.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | Per-message state line on outbound messages | Low | One short line under a message card that already shows a timestamp; absent on inbound messages |
| Inbox composer | Sent message appears immediately in a queued state | Low | Replaces the current gap between pressing Send and the message appearing |
| Monitoring | Per-mailbox send failure rate | Low | Extends the delivery telemetry already displayed |
| Dashboard activity trail | Unchanged — status transitions go to telemetry | Low | Deliberate, so the trail stays a record of decisions rather than machine noise |

**Verdict:** Fits an existing surface

Harry sends through Gmail and records telemetry, but a person looking at a thread has no way to tell whether the message they just sent actually left, which is exactly when they most want to know. One line of text per outbound message closes that gap with no new page, and keeping status out of the activity trail preserves the trail's value as a record of human decisions.
