# Suspend Email Account

| | |
|---|---|
| **Endpoint** | `PUT https://server.smartlead.ai/api/v1/email-accounts/suspend/{id}` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/suspend |
| **Auth** | API key (query param `api_key`) |

Pauses a mailbox so it sends nothing at all — campaigns or warm-up — while leaving its settings and campaign links exactly as they are.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner who suspects a deliverability problem, **I want** to stop one mailbox sending without unpicking it from my campaigns, **so that** I can investigate for a day and switch it back on with one click.

**Acceptance criteria**
- [ ] Given a mailbox I own, when I suspend it, then the response confirms with the id and the flag (SmartLead: `{"success": true, "data": {"accountId": 123, "isSuspended": true}}`) and the mailbox stops sending immediately.
- [ ] Given the mailbox is suspended, when the engine ticks, then it sends neither campaign email nor warm-up email from that mailbox, matching the documented behaviour that both stop.
- [ ] Given the mailbox is suspended, when I look at any campaign using it, then the mailbox is still attached — suspension must not detach it — and the campaign shows why that mailbox is not contributing.
- [ ] Given a campaign whose only mailbox is suspended, when the engine ticks, then the campaign holds with a stated reason rather than failing per lead.
- [ ] Given drafts already approved and waiting to go from that mailbox, when I suspend it, then they stay queued and unsent; they are not cancelled and not rerouted to another mailbox without the user saying so.
- [ ] Given an id from another workspace or a non-numeric id, when I suspend, then the request fails with the documented 400 shapes ("Email account not found or does not belong to you" and "Valid account ID is required") and nothing changes.
- [ ] Given a suspension, when it completes, then the activity trail records who suspended which mailbox and when, so a teammate is not left guessing why sending stopped.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Suspend a healthy mailbox attached to one running campaign | 200, `{"success": true, "data": {"accountId": 123, "isSuspended": true}}`; row on Mailboxes reads Suspended |
| TC-2 | Missing/invalid API key | Suspend with no session cookie | 401, `{"message": "Invalid API Key"}`; mailbox unchanged |
| TC-3 | Not found / wrong workspace | Suspend an id from another workspace | 400, `{"success": false, "message": "Email account not found or does not belong to you"}`; nothing changes |
| TC-4 | Validation failure | Suspend with a non-numeric id | 400, `{"success": false, "message": "Valid account ID is required"}`, surfaced as a field-level message |
| TC-5 | Rate limited | Toggle suspend rapidly twenty times | 429 on the excess; client backs off with jitter, the toggle settles on the true server state rather than flickering |
| TC-6 | Empty result set | Suspend every mailbox in the workspace, then open Mailboxes | 200 each; list renders all rows as Suspended with a banner saying nothing can send, not the first-run empty state |
| TC-7 | Sending stops mid-flight | Suspend while the engine is between sends for that mailbox | The next tick sends nothing from it; a send already in flight completes and is recorded, never duplicated |
| TC-8 | Warm-up pauses too | Suspend a mailbox mid-ramp, wait a day, unsuspend | No warm-up emails during suspension; the ramp resumes at the stage it paused on, not at the start |
| TC-9 | Sole mailbox on a campaign | Suspend the only mailbox on a running campaign | Campaign moves to holding with the reason naming the suspended mailbox; leads are not marked lost |
| TC-10 | Approved drafts queued | Suspend with three approved emails queued from that mailbox | Drafts stay queued and unsent; each shows "waiting — mailbox suspended" and goes on unsuspend |
| TC-11 | Suspend twice | Suspend an already-suspended mailbox | 200 and idempotent — still `isSuspended: true`, no second activity-trail entry claiming a change |

## 4. Frontend user story

**As a** workspace owner, **I want** a clearly labelled pause switch on a mailbox, **so that** stopping it feels reversible and I can see everywhere it takes effect.

**Scope**
- Mailboxes page: a Suspend / Resume control in the mailbox row menu and in the mailbox detail sheet, with the row rendering a plain "Suspended" state, not a greyed-out row a user could mistake for broken.
- Campaign detail: a mailbox listed in "Sending from" that is suspended shows "Suspended — not sending" beside it, so the campaign page never disagrees with Mailboxes.
- Dashboard: if every mailbox is suspended, the engine panel says so in one line with a link, since it is the fastest way to explain "why is nothing going out".
- States: pending (control disabled with progress text), success (state flips without reload), error (control reverts and shows the server message), conflict (state reconciled from the server, no flicker).
- Accessibility: the control is a labelled switch with an accessible name including the address; the suspended state is announced and is text, not colour alone. Responsive: the control stays in the row menu at all widths so nothing overflows.

**Definition of done**
- [ ] Suspended state is identical on Mailboxes, mailbox detail, and campaign detail.
- [ ] Suspension is never presented as an error state.
- [ ] Queued approved drafts show the reason they are waiting.
- [ ] Pending, success, error and conflict states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a suspension flag the mailer and pacing code both respect, **so that** one switch reliably stops every path that could send from a mailbox.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `PUT /api/mailboxes/:id/suspend`, returning the id and the new flag.
- Data model: add `is_suspended` and `suspended_at` to `mailboxes` in `server/db.js`. No new table, no migration risk — existing rows default to false.
- `server/mailer.js` refuses to dispatch from a suspended mailbox and `server/pacing.js` excludes it from rotation and from the warm-up ramp, so the check exists in one place per path rather than at the call sites. The engine treats a campaign with no eligible mailbox as holding, reusing the existing holding-reason mechanism.
- Idempotent: suspending an already-suspended mailbox returns success without a second event. Standard app rate limiter; no retry logic needed since the operation is a single flag write.
- Logged: an `events` row with actor, address and the count of campaigns affected; `telemetry` records suspension so Monitoring can explain a drop in send volume rather than reporting it as a failure.

**Definition of done**
- [ ] A suspended mailbox cannot send by any path, proven by tests against both the campaign and warm-up paths.
- [ ] Warm-up ramp position is preserved across a suspension, covered by a test.
- [ ] Cross-workspace and non-numeric ids return the documented 400 shapes.
- [ ] Suspension appears in the activity trail and in Monitoring's incident feed.

## 6. End-to-end test ticket

**Title:** E2E — Pause a mailbox and put it back

**Preconditions:** A workspace with two sandbox mailboxes attached to one running campaign with six leads, approvals on, three emails already approved and queued from mailbox A, mailbox A mid-warm-up.

**Flow**
1. Open Mailboxes and suspend mailbox A.
2. Let the engine tick several times.
3. Open the campaign detail page and Inbox → Needs your OK.
4. Suspend mailbox B as well and open the campaign again.
5. Resume mailbox A.
6. Let the engine tick and check Reports → mailbox load.

**Assertions**
- [ ] After suspension, no email leaves mailbox A while mailbox B keeps sending.
- [ ] Campaign detail marks mailbox A "Suspended — not sending" and the three queued approvals show they are waiting on the mailbox.
- [ ] With both suspended, the campaign holds with a reason naming the mailboxes, and the Dashboard engine panel says nothing can send.
- [ ] On resume, the three queued approvals go out unchanged — the same emails that were approved, not new ones.
- [ ] Mailbox A's warm-up resumes at its paused stage, visible in the mailbox detail sheet.

**Teardown:** Resume both mailboxes, delete the campaign, reset send counters and warm-up state.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Suspend / Resume control and a Suspended row state | Low | One item in an existing row menu and one state word on a row that already shows health |
| Mailbox detail sheet | Same control, plus who suspended it and when | Low | Reuses the sheet added for mailbox detail |
| Campaign detail | Suspended note beside the mailbox in "Sending from" | Low | Text on a panel that already lists mailboxes |
| Dashboard | One line when every mailbox is suspended | Low | Reuses the engine panel's existing status line |

**Verdict:** Fits an existing surface

Suspension is a reversible switch on an object Harry already lists, so it belongs in the row menu rather than anywhere new. It is genuinely new capability — today a user can only disconnect a mailbox entirely, which loses the campaign links — but the surface cost is one menu item and one state word. No navigation item is added.
