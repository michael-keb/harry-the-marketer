# Get Campaign Email Accounts

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/email-accounts` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-email-accounts |
| **Auth** | API key (query param `api_key`) |

Lists the mailboxes a campaign sends from, with each one's sender identity, type, connection state and warmup health.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner troubleshooting slow or failing delivery, **I want** to see exactly which mailboxes this campaign uses and how healthy each one is, **so that** I can tell the difference between a bad playbook and a broken mailbox.

**Acceptance criteria**
- [ ] Given a campaign with mailboxes attached, when I list them, then each entry carries its id, sender address and sender name, its type, and its warmup state — mirroring the source API's `id`, `from_email`, `from_name`, `type`, `warmup_enabled`, `warmup_reputation`.
- [ ] Given Harry connects Gmail via OAuth and also offers sandbox mailboxes, when the type is shown, then it reads as Gmail or Sandbox in plain words rather than as a protocol name.
- [ ] Given connection health matters, when a mailbox has lost its authorisation, then the row shows it as needing reconnection — the equivalent of the source API's `is_smtp_success` and `is_imap_success` checks — with a direct link to fix it.
- [ ] Given each mailbox has a daily limit and a warmup ramp, when I view the list, then I see today's cap, how much of it is used, and where the mailbox is in its fortnight-long ramp from 10 a day.
- [ ] Given a mailbox is shared across campaigns, when I view it here, then I see how many campaigns use it, so I understand why its allowance is being consumed elsewhere.
- [ ] Given a campaign with no mailboxes, when I list them, then I get an empty list and the page states that the campaign cannot launch until one is attached.
- [ ] Given a campaign in another workspace, when I list its mailboxes, then I get a 404 and no sender addresses are disclosed.
- [ ] Given the list is used for troubleshooting, when a mailbox has recent send failures, then its row shows the failure count and the last error in plain English.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the campaign's email accounts with two mailboxes attached | 200 with `ok: true` and a `data` array of two entries, each carrying `id`, `from_email`, `from_name`, `type`, `warmup_enabled`, `warmup_reputation` |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401, `{"message": "Invalid API Key"}`; no sender addresses returned |
| TC-3 | Not found / wrong workspace | GET for another workspace's campaign | 404, `{"error": "Resource not found"}`; nothing disclosed |
| TC-4 | Validation failure | GET with a non-numeric campaign id | 422, `{"error": "Invalid parameters provided"}` |
| TC-5 | Rate limited | Poll the list every second while troubleshooting | 429 on the excess; UI keeps the last list with a "last updated" note |
| TC-6 | Empty result set | GET for a campaign with no mailboxes attached | 200 with an empty `data` array; the panel says the campaign cannot launch until a mailbox is attached |
| TC-7 | Disconnected mailbox | Revoke a mailbox's Google authorisation and list again | That row shows "Reconnect needed" with a link to Mailboxes; the campaign page warns that capacity is reduced |
| TC-8 | Warmup ramp | List a mailbox connected two days ago | Its row shows a ramped cap well below the mailbox's configured limit, with the ramp explained |
| TC-9 | Shared mailbox | List a mailbox attached to three campaigns | The row states it is used by three campaigns and shows the allowance remaining across all of them |
| TC-10 | Allowance exhausted | List during a day when a mailbox has hit its cap | The row reads "0 left today" and the campaign page's holding reason matches |
| TC-11 | Sandbox mailbox | List a campaign using a sandbox mailbox | Type reads Sandbox; the row notes it skips the clock and the gap but still respects the daily limit |
| TC-12 | Recent failures | List after three send failures on one mailbox | The row shows the failure count and the last error in plain English, matching Monitoring's delivery telemetry |

## 4. Frontend user story

**As a** campaign owner, **I want** the campaign's "Sending from" panel to double as a health readout, **so that** when a campaign is not sending, the reason is on the same screen as the campaign.

**Scope**
- Campaigns → campaign detail: the "Sending from" panel lists each attached mailbox with sender name and address, type, today's used and remaining allowance, warmup state, connection state, and recent failures.
- Rows link to Mailboxes for the fix (reconnect, change limit) rather than duplicating those controls here.
- The panel's summary line answers the common question directly: "3 mailboxes, 42 of 90 sends left today".
- Loading: skeleton rows; empty: "No mailbox attached — this campaign cannot launch" with an attach action; error: the panel keeps its last content, greyed, with a retry.
- Accessibility: health is text plus icon, never colour alone; allowance is expressed as "42 of 90 left today" rather than only a bar; each row's action names the mailbox. Responsive: rows stack to cards under 640px with address and health first.

**Definition of done**
- [ ] Every attached mailbox shows connection state, warmup state and remaining allowance.
- [ ] A disconnected or exhausted mailbox is visibly the cause of a holding campaign, on the same page.
- [ ] The panel links out to Mailboxes rather than duplicating its controls.
- [ ] Sandbox mailboxes are labelled as such so test runs are never mistaken for real sends.

## 5. Backend user story

**As a** Harry API, **I want** a route returning a campaign's mailboxes with their live health, **so that** the campaign page can explain a stalled campaign without the user visiting another screen.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/mailboxes`, workspace-scoped, returning for each mailbox its id, sender name and address, provider type, connection state, warmup day and ramped cap, used and remaining allowance for today, campaigns-using count, and recent failure summary.
- Data model: reads `campaign_mailboxes` joined to `mailboxes` in `server/db.js`, with today's usage counted from `messages` and failures read from `telemetry`. Connection state is derived from the stored refresh token's last known validity, not by calling Google on every request.
- Ramped caps come from the same code path the mailer uses (`server/mailer.js` and `server/pacing.js`), so the number displayed is the number enforced.
- No pagination — a campaign has a handful of mailboxes. Standard rate limiting; short cache keyed on the campaign and the day's send count.
- Logged: nothing to `events`. `telemetry` already carries delivery data; this route only reads it.

**Definition of done**
- [ ] Displayed remaining allowance provably equals what the mailer will permit, covered by a test.
- [ ] Connection state is read from stored state, with no per-request call to Google.
- [ ] Sandbox mailboxes report the same daily-limit semantics as real ones.
- [ ] Cross-workspace access returns 404 and discloses no addresses.

## 6. End-to-end test ticket

**Title:** E2E — Diagnose a stalled campaign from its sending panel

**Preconditions:** A workspace with three sandbox mailboxes attached to one running campaign: mailbox A healthy, mailbox B with its authorisation revoked, mailbox C at its daily cap. Leads attached and approvals given so the campaign wants to send.

**Flow**
1. Open Campaigns → campaign detail.
2. Read the "Sending from" panel summary line.
3. Read each mailbox row.
4. Follow mailbox B's link to Mailboxes and reconnect it.
5. Return to the campaign page and refresh.
6. Compare the panel with Monitoring's delivery telemetry.

**Assertions**
- [ ] The summary line states the total remaining allowance across the three mailboxes.
- [ ] Mailbox B shows "Reconnect needed" and mailbox C shows "0 left today".
- [ ] The campaign header's holding reason matches what the panel shows.
- [ ] After reconnecting B, its row becomes healthy and the summary allowance increases.
- [ ] Monitoring's per-mailbox delivery figures agree with the panel.
- [ ] Detaching all three mailboxes leaves the panel in its empty state with the launch warning.

**Teardown:** Detach the mailboxes and delete the campaign; leave the sandbox mailboxes connected.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | "Sending from" panel gains health, allowance and failure detail | Medium | One line per mailbox with four values; the panel collapses to a summary line when everything is healthy |
| Mailboxes | Receives deep links from the panel | Low | No new controls; the fixes already live there |
| Monitoring | Same telemetry, now also surfaced in context | Low | Reuses existing data, no new panel |

**Verdict:** Fits an existing surface

This is the read side of the mailbox attachment panel, so it belongs in that panel rather than anywhere new. Its value is putting the cause next to the symptom: when a campaign is holding, the mailbox that is out of allowance or needs reconnecting is on the same screen, one line away from the reason.
