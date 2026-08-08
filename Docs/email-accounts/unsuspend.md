# Unsuspend Email Account

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/email-accounts/unsuspend/{id}` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/unsuspend |
| **Auth** | API key (query param `api_key`) |

Puts a paused mailbox back into service, so it rejoins its campaigns' sending rotation and its warm-up resumes.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner who has finished investigating a mailbox, **I want** to put it back to work and be told whether it is actually fit to send, **so that** resuming does not immediately re-create the problem I paused it for.

**Acceptance criteria**
- [ ] Given a suspended mailbox I own, when I resume it, then the response confirms the id and the cleared flag (SmartLead: `{"success": true, "data": {"accountId": 123, "isSuspended": false}}`) and the mailbox rejoins rotation on every campaign it is attached to.
- [ ] Given warm-up was enabled before the pause, when I resume, then it resumes at the ramp stage it paused on rather than restarting from day one.
- [ ] Given the connection has broken while the mailbox was suspended, when I resume, then Harry re-checks the connection first and shows the result — the documented advice is to verify SMTP/IMAP validity, daily limits and warm-up settings after unsuspending, and the UI should do that check rather than ask the user to.
- [ ] Given approved emails were queued from that mailbox while it was suspended, when I resume, then those exact approved emails go out under the normal sending rhythm — never a re-composed replacement, in line with Harry's standing rule.
- [ ] Given a campaign was holding solely because this was its only mailbox, when I resume, then the campaign leaves holding on the next tick and the holding reason clears.
- [ ] Given an id from another workspace or a non-numeric id, when I resume, then the documented 400 shapes are returned ("Email account not found or does not belong to you", "Valid account ID is required") and nothing changes.
- [ ] Given a resume, when it completes, then the activity trail records who resumed which mailbox and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Resume a suspended mailbox attached to one campaign | 200, `{"success": true, "data": {"accountId": 123, "isSuspended": false}}`; row reads Connected and the mailbox sends on the next tick |
| TC-2 | Missing/invalid API key | Resume with no session cookie | 401, `{"message": "Invalid API Key"}`; mailbox stays suspended |
| TC-3 | Not found / wrong workspace | Resume an id from another workspace | 400, `{"success": false, "message": "Email account not found or does not belong to you"}` |
| TC-4 | Validation failure | Resume with a non-numeric id | 400, `{"success": false, "message": "Valid account ID is required"}`, shown as a field-level message |
| TC-5 | Rate limited | Toggle resume rapidly | 429 on the excess; client backs off with jitter and settles on the server's state |
| TC-6 | Empty result set | Resume when there are no suspended mailboxes and the list is filtered to Suspended | 200 where applicable; the filtered list empties and says which filter emptied it |
| TC-7 | Connection broke during suspension | Revoke the token while suspended, then resume | Resume succeeds but the connection re-check fails; the row reads "Reconnect needed" instead of Connected and the mailbox sends nothing |
| TC-8 | Queued approvals go out unchanged | Resume with three approved emails queued | The same three emails send, byte-identical to what was approved; no second draft is composed |
| TC-9 | Warm-up resumes mid-ramp | Suspend at day 6 of the ramp, resume two days later | Warm-up continues from the paused stage, not from day one and not at the full limit |
| TC-10 | Campaign leaves holding | Resume the only mailbox on a holding campaign | Campaign resumes on the next tick and the holding reason clears from the campaign page |
| TC-11 | Resume twice | Resume an already-active mailbox | 200 and idempotent — `isSuspended: false`, no duplicate activity-trail entry |
| TC-12 | Daily limit still applies | Resume a mailbox that already hit its limit today | Mailbox is active but sends nothing more today; the row reads "0 left today" rather than failing |

## 4. Frontend user story

**As a** workspace owner, **I want** resuming a mailbox to include a health check I can see, **so that** "resumed" never quietly means "resumed and still broken".

**Scope**
- Mailboxes page and mailbox detail sheet: the Resume half of the Suspend / Resume control, with a short inline check running on resume and reporting send and read separately.
- After resume, the row shows one of three honest outcomes: active, active but at its daily limit, or reconnect needed.
- Campaign detail: a campaign that was holding because of this mailbox clears its banner without a manual refresh.
- States: pending (control disabled with progress text), checking (per-leg progress), success, failed-check (row keeps a clear reason and the Reconnect action).
- Accessibility: the control's accessible name includes the address; the check result is announced; nothing is conveyed by colour alone. Responsive: the check result wraps under the row on narrow screens rather than truncating.

**Definition of done**
- [ ] Resume always runs a connection check and reports the outcome.
- [ ] A mailbox that resumes into a broken connection never renders as healthy.
- [ ] The queued approvals that go out are visibly the ones that were approved, shown in the activity trail.
- [ ] Pending, checking, success and failed-check states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** resuming to clear the flag and re-validate in one operation, **so that** the mailer never picks up a mailbox that cannot actually send.

**Scope**
- Route in `server/routes.js` mirroring the suspend route: `DELETE /api/mailboxes/:id/suspend`, clearing `is_suspended` and `suspended_at` and returning the new state.
- Data model: none beyond the suspension flag added by the suspend story.
- On resume, `server/mailer.js` runs its provider check (token refresh for Gmail, SMTP and IMAP handshake for SMTP mailboxes); a failure leaves the mailbox active-but-unhealthy rather than silently suspended again, so the state the user sees matches what they asked for. `server/pacing.js` recomputes the warm-up stage from the mailbox's connection date minus paused days, so the ramp resumes rather than restarts.
- Idempotent; standard app rate limiter; provider 429 during the check is backed off with jitter and reported as "could not check yet", not as a failure.
- Logged: an `events` row with actor, address and check outcome; `telemetry` records the resume and the check latency so Monitoring's incident feed shows the pause and the resume as a pair.

**Definition of done**
- [ ] Resume plus connection check is a single request from the client's point of view.
- [ ] Warm-up stage after resume is covered by a test asserting it neither restarts nor jumps to the ceiling.
- [ ] Queued approved drafts are dispatched unchanged, covered by a test comparing stored and sent bodies.
- [ ] Cross-workspace and non-numeric ids return the documented 400 shapes.

## 6. End-to-end test ticket

**Title:** E2E — Bring a paused mailbox back safely

**Preconditions:** A workspace with two sandbox mailboxes, one suspended mid-warm-up with three approved emails queued, one campaign holding because its only mailbox is the suspended one, approvals on.

**Flow**
1. Open Mailboxes and resume the suspended mailbox.
2. Watch the connection check complete.
3. Open the campaign detail page.
4. Let the engine tick until the queued approvals go out.
5. Open the mailbox detail sheet and check the warm-up stage.
6. Suspend it again, break the connection, and resume once more.

**Assertions**
- [ ] The check reports send and read separately and the row reads Connected.
- [ ] The campaign leaves holding and its holding reason clears.
- [ ] The three queued emails go out unchanged, and the activity trail names them as the previously approved ones.
- [ ] Warm-up shows a stage consistent with the days it was actually active, not a restart.
- [ ] On the second resume with a broken connection, the row reads "Reconnect needed", nothing sends, and the campaign returns to holding with a stated reason.

**Teardown:** Restore the mailbox's credentials, delete the campaign, reset send counters and warm-up state.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Resume side of the existing Suspend control, plus a check result line | Low | Same control, one extra line that appears only while checking or when the check fails |
| Mailbox detail sheet | Same control and result | Low | Reuses the sheet |
| Campaign detail | Holding banner clears | Low | Existing banner, no new component |
| Monitoring | Pause and resume appear as a pair in the incident feed | Low | Existing feed, two entries instead of one |

**Verdict:** Fits an existing surface

Resume is the other half of the suspend control, so it costs nothing new to place. The only visible addition is the connection-check result, which appears exactly when it has something to say and disappears otherwise. No navigation item is added.
