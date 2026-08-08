# Add SMTP Email Account

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/save` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/add-smtp |
| **Auth** | API key (query param `api_key`) |

Adds a sending mailbox using a plain username and password over SMTP and IMAP, checking that both connections actually work before the mailbox is used.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner whose sending address lives on a company mail server rather than Gmail, **I want** to connect it with SMTP and IMAP credentials, **so that** I can run campaigns from my own domain without moving my email to Google.

**Acceptance criteria**
- [ ] Given valid credentials, when I add a mailbox with `from_name`, `from_email`, `user_name`, `password`, `smtp_host`, `smtp_port`, `imap_host` and `imap_port`, then both connections are tested and the result reports each separately (SmartLead's `is_smtp_success` and `is_imap_success`).
- [ ] Given SMTP succeeds but IMAP fails, when the mailbox is saved, then it is created but marked with the connection error and cannot be attached to a campaign until IMAP works — Harry needs to read replies, not just send.
- [ ] Given wrong credentials, when the connection test runs, then the failure is surfaced as SmartLead's 400 shape (`{"ok": false, "message": "SMTP connection failed", "error": "Invalid credentials"}`) translated into plain English naming which leg failed.
- [ ] Given IMAP credentials that differ from SMTP, when I supply `imap_user_name` and `imap_password`, then they are used for the read connection and stored separately.
- [ ] Given a reply should go somewhere other than the sending address, when I set `different_reply_to_address`, then outgoing emails carry that Reply-To and the engine still matches the thread when the reply lands.
- [ ] Given a new mailbox, when it is created, then `max_email_per_day` defaults to Harry's existing 50 and the warm-up ramp is on by default (`warmup_enabled`, `total_warmup_per_day`, `daily_rampup`).
- [ ] Given a stored password, when any API response or log line is produced, then the password and `imap_password` never appear in it.
- [ ] Given `is_suspended: true` at creation, when the mailbox is saved, then it exists but sends nothing until it is unsuspended.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Save with host `smtp.yourdomain.com:587` and `imap.yourdomain.com:993`, `type: "SMTP"`, valid credentials | 200, `{"ok": true, ... "data": {"id": …, "is_smtp_success": true, "is_imap_success": true, "warmup_details": {"status": "ACTIVE"}}}`; mailbox listed as Connected |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; nothing written, user sent to sign-in |
| TC-3 | Wrong workspace | Save with an `id` referencing another workspace's mailbox | 404; no update; UI shows "That mailbox is not available" |
| TC-4 | Validation failure | Omit `from_name` | 422, `{"error": "from_name is required"}` rendered under the display-name field |
| TC-5 | Rate limited | Submit ten saves in quick succession | 429 on the excess; backs off with jitter and retries once, one visible "Retrying…" state |
| TC-6 | Empty result set | Open Mailboxes with no mailboxes connected | Empty state offering both "Connect Gmail" and "Add SMTP mailbox", no spinner |
| TC-7 | SMTP works, IMAP fails | Correct SMTP details, wrong `imap_port` | Mailbox created with `is_imap_success: false`; row reads "Cannot read replies — check IMAP"; mailbox is not selectable on a campaign |
| TC-8 | Gmail without an app password | Use a normal Gmail password against `smtp.gmail.com:587` | 400 connection failure; error copy points at app passwords and 2FA rather than repeating the server's text |
| TC-9 | Bad port type | Send `smtp_port: "587"` as a string | 422 with a field-level message on the port |
| TC-10 | Secrets in transport | Inspect the response body, server log and activity trail after TC-1 | `password` and `imap_password` appear in none of them |
| TC-11 | Created suspended | Save with `is_suspended: true` | Mailbox exists, shows Suspended, sends zero emails, and campaign attach is blocked with a stated reason |

## 4. Frontend user story

**As a** workspace owner, **I want** a short form for server details that tells me which half of the connection is broken, **so that** I can fix one setting instead of guessing at eight.

**Scope**
- Mailboxes page: an "Add mailbox" action that now offers two paths — "Connect Gmail" (the existing OAuth flow) and "Use SMTP details" (new). The second opens a form with display name, address, username, password, SMTP host and port, IMAP host and port, and an "Advanced" disclosure holding reply-to, separate IMAP credentials, and BCC.
- Known-provider presets fill the hosts and ports for Gmail and Outlook so most users type two fields, not eight.
- States: testing (both legs shown with individual spinners), success (two ticks), partial (send works, read does not, with the specific fix), failure (which leg, which setting).
- Password fields are type `password` with a show toggle, never pre-filled on edit, and never echoed back from the server.
- Accessibility: every field has a real label and inline error text tied by `aria-describedby`; the two connection results are announced, not colour-only. Responsive: the form is a single column under 640px.

**Definition of done**
- [ ] The connection test result is shown per leg, never as one combined "failed".
- [ ] Presets exist for Gmail and Outlook and can be overridden.
- [ ] A mailbox whose IMAP leg fails is visibly unusable for campaigns, with the reason on the row.
- [ ] Loading, partial-success and failure states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an SMTP/IMAP provider beside the existing Gmail and sandbox providers, **so that** the mailer can send from any mail server without changing the engine.

**Scope**
- Routes in `server/routes.js` mirroring the existing mailbox routes: `POST /api/mailboxes` accepting a `provider: "smtp"` body, plus a `POST /api/mailboxes/:id/test` that re-runs the connection check on demand.
- Data model: `mailboxes` gains `smtp_host`, `smtp_port`, `imap_host`, `imap_port`, `imap_user_name`, `reply_to`, `bcc`, and encrypted `password` / `imap_password` columns; `provider` widens to `gmail | outlook | smtp | sandbox`. Migration leaves existing Gmail rows untouched.
- `server/mailer.js` gains an `smtp` dispatch arm alongside `gmail` and `sandbox`, reusing the same quota, pacing and thread-sync path so the engine is unchanged. Reply pulling moves from the Gmail REST call to an IMAP fetch for these mailboxes.
- Connection test runs with a short timeout and is retried once; provider 429 or greylisting backs off with jitter rather than failing the save.
- Logged: `events` row on create / test / credential change with actor and address but never the secret; `telemetry` records SMTP and IMAP handshake latency and failure reasons so Monitoring's mailbox check covers non-Gmail mailboxes too.

**Definition of done**
- [ ] Secrets encrypted at rest and excluded from every serialiser and log.
- [ ] Sending and reply-pull both work end to end against a local test mail server in the test suite.
- [ ] A mailbox with a failing IMAP leg cannot be attached to a campaign, enforced server-side and not only in the UI.
- [ ] Monitoring shows per-mailbox delivery telemetry for SMTP mailboxes identically to Gmail ones.

## 6. End-to-end test ticket

**Title:** E2E — Run a campaign from an SMTP mailbox

**Preconditions:** A local test mail server accepting SMTP on 587 and IMAP on 993, a workspace with no mailboxes, a campaign with a valid playbook and two leads, approvals on (the default).

**Flow**
1. Open Mailboxes, choose "Use SMTP details", and enter the test server's host, port and credentials.
2. Save and watch both connection legs report success.
3. Attach the mailbox to the campaign and launch.
4. Approve the two drafts in Inbox → Needs your OK.
5. Have the test server deliver a reply to one lead.
6. Let the engine tick and open Inbox.

**Assertions**
- [ ] Both legs show green and the mailbox row reads Connected with a 50/day limit.
- [ ] Two emails leave the test server with the correct From display name and Reply-To.
- [ ] The reply appears in Inbox with an intent chip and the lead moves along the playbook edge.
- [ ] Changing the password to a wrong value and re-testing flips the mailbox to a connection error and holds the campaign with a stated reason.

**Teardown:** Delete the mailbox and its stored secrets, delete the campaign, clear the test mail server's queues.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | A second way to add a mailbox, with an eight-field form | Medium | Gmail stays the primary button; SMTP sits behind a secondary link, and presets reduce the visible fields to two for known providers |
| Mailboxes | Rows must distinguish provider and per-leg health | Low | One extra word on an existing row |
| Campaign detail | Mailbox picker must exclude read-broken mailboxes | Low | Existing picker, one more disabled reason string |
| Monitoring | Mailbox checks extend to SMTP | Low | Existing component check, wider coverage |

**Verdict:** Fits an existing surface

Harry's Mailboxes page already owns connecting, limits and health, so SMTP belongs there rather than anywhere new. What is genuinely new is a credential form and a two-legged connection test — Gmail OAuth never needed either — so the mitigation is keeping it behind a secondary action and hiding host and port behind presets. No navigation item is added.
