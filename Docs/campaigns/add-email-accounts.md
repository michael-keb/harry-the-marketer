# Add Email Accounts to Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/email-accounts` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/add-email-accounts |
| **Auth** | API key (query param `api_key`) |

Attaches one or more sending mailboxes to a campaign so the campaign can rotate its emails across them.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to attach several connected mailboxes to a campaign in one action, **so that** the campaign's sending is spread across them instead of hammering one Gmail account.

**Acceptance criteria**
- [ ] Given a campaign I own and a list of mailbox ids I own, when I attach them, then all of them are linked to the campaign in a single request and the response confirms success (`{"ok": true}`).
- [ ] Given a mailbox that is not fully connected — the SmartLead equivalent is `is_smtp_success` / `is_imap_success` being false, in Harry a mailbox whose Google refresh token is missing or revoked — when I try to attach it, then it is rejected with a field-level message naming that mailbox and no mailbox in the batch is attached.
- [ ] Given a mailbox that belongs to another workspace, when I attach it, then the request returns 404 (not found / no access) and nothing changes.
- [ ] Given a mailbox already attached to the campaign, when I attach it again, then the operation is idempotent — no duplicate link row, still a success response.
- [ ] Given zero mailboxes attached, when the campaign is launched, then launch is blocked with the existing "pick a mailbox" validation rather than silently doing nothing.
- [ ] Given mailboxes are attached, when the sending rhythm runs, then each mailbox's own daily limit and warmup ramp still applies per mailbox — attaching more mailboxes raises total volume, never per-mailbox volume.
- [ ] Given any attach or detach, when it completes, then an entry is written to the activity trail naming who attached which mailbox and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, multiple mailboxes | POST the campaign's email-accounts route with `email_account_ids: [456, 457, 458]`, all three connected and owned | 200, body `{"ok": true}`; a follow-up GET of campaign email accounts returns all three |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401, `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again", no partial write |
| TC-3 | Campaign not found / wrong workspace | POST to a campaign id belonging to another workspace | 404, `{"error": "Resource not found"}`; UI shows "That campaign is not available" and returns to Campaigns |
| TC-4 | Validation failure — wrong type | POST `email_account_ids: "456"` (string, not array) | 422, `{"error": "Invalid parameters provided"}` with a field-level message on `email_account_ids` |
| TC-5 | Rate limited | Fire 100 attach requests in a burst | 429 on the excess; client backs off and retries with jitter, user sees a single "Retrying…" state, not 100 errors |
| TC-6 | Empty list | POST `email_account_ids: []` | 400 with "Pick at least one mailbox"; the picker stays open with the empty state shown |
| TC-7 | Disconnected mailbox in the batch | Include one mailbox whose token was revoked | 422 naming that mailbox; the whole batch is rejected atomically and the picker marks that row "Reconnect needed" |
| TC-8 | Duplicate attach | Run TC-1 twice | Second call 200, still exactly three linked mailboxes |
| TC-9 | Suspended / over-limit mailbox | Attach a mailbox already at its daily cap | 200 (attach allowed) but the campaign page shows "0 left today" for that mailbox rather than failing the attach |
| TC-10 | Detach the last mailbox on a running campaign | Remove all mailboxes while the campaign is live | Campaign moves to holding with the reason "no mailbox attached"; no sends attempted |

## 4. Frontend user story

**As a** campaign owner, **I want** a mailbox picker on the campaign detail page, **so that** I can see which mailboxes send for this campaign and change the set without leaving the page.

**Scope**
- Campaigns → campaign detail: a "Sending from" panel listing attached mailboxes with address, health, daily limit and remaining allowance; an "Add mailboxes" dialog listing every connected mailbox in the workspace with multi-select.
- Mailboxes page gains a read-only "Used by" column so a user can see the reverse relationship before disconnecting anything.
- Loading: skeleton rows in the panel. Empty: "No mailbox attached yet — this campaign cannot launch" with a direct action. Error: inline banner in the dialog, selection preserved so nothing is retyped.
- Disconnected mailboxes appear in the dialog but are disabled with a "Reconnect" link, so the reason a mailbox cannot be used is visible rather than hidden.
- Accessibility: the dialog is a labelled modal with focus trap and Escape to close; checkboxes are real inputs with visible labels; the health state is text, never colour alone. Responsive: the panel stacks to one column under 640px.

**Definition of done**
- [ ] Attached mailboxes render on campaign detail with health and remaining daily allowance.
- [ ] Multi-select add and single remove both work and reflect immediately without a page reload.
- [ ] Launch validation on the campaign page reads the same attached set, so "pick a mailbox" can never disagree with the panel.
- [ ] Every state — loading, empty, partial failure, disconnected mailbox — has a designed appearance, verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** routes to attach and list a campaign's mailboxes, **so that** the engine knows which mailboxes to rotate through when it sends.

**Scope**
- Routes in `server/routes.js`, following the existing workspace-scoped pattern: `POST /api/campaigns/:id/mailboxes` taking `{ mailboxIds: [] }`, `GET /api/campaigns/:id/mailboxes`, `DELETE /api/campaigns/:id/mailboxes/:mailboxId`.
- Data model: a `campaign_mailboxes` join table in `server/db.js` (`campaign_id`, `mailbox_id`, `created_at`) with a unique constraint on the pair so repeat attaches are idempotent. Existing single-mailbox campaigns are migrated into one row each.
- Validation before write: every id must belong to the caller's workspace (else 404) and be connected (else 422 naming the mailbox). Writes happen in one transaction so a bad id in the batch leaves nothing attached.
- No pagination needed — a workspace has tens of mailboxes, not thousands. Attaching is not rate-limited beyond the app's standard limiter.
- `server/mailer.js` and `server/pacing.js` read the join table and rotate mailboxes least-recently-used first, honouring each mailbox's own daily limit and warmup ramp.
- Logged: an `events` row per attach/detach with actor, campaign, mailbox; `telemetry` records rejected attaches by reason so Monitoring can show "mailboxes rejected because disconnected".

**Definition of done**
- [ ] Join table created with the unique constraint and a migration for existing campaigns.
- [ ] All three routes are workspace-scoped and covered by tests, including cross-workspace 404.
- [ ] Rotation across attached mailboxes is exercised by an engine test that asserts sends alternate.
- [ ] Attach and detach both appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Rotate a campaign's sending across several mailboxes

**Preconditions:** A workspace with three sandbox mailboxes connected, one campaign with a valid playbook, six leads attached, approvals left on (the default).

**Flow**
1. Open Campaigns and choose the campaign.
2. In "Sending from", open "Add mailboxes" and select all three sandbox mailboxes.
3. Save, then launch the campaign.
4. Let the engine tick until six drafts are waiting.
5. Approve all six in Inbox → Needs your OK.
6. Open Reports → mailbox load.

**Assertions**
- [ ] The campaign detail panel lists all three mailboxes with their daily allowance.
- [ ] After approvals, the six sends are spread across the three mailboxes rather than concentrated on one, visible on the Reports mailbox-load chart.
- [ ] Removing one mailbox mid-run leaves the campaign running on the remaining two, with an activity-trail entry recording the removal.
- [ ] Removing all three puts the campaign into holding and the campaign page states the reason.

**Teardown:** Delete the campaign and its leads; reset the sandbox mailboxes' send counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | New "Sending from" panel plus an add-mailboxes dialog | Medium | Replaces the existing single-mailbox selector rather than sitting beside it; the panel is collapsed to one summary line when a single mailbox is attached |
| Mailboxes | A "Used by" column | Low | One extra column of plain text, no new controls |
| Reports | Mailbox-load chart becomes per-campaign meaningful | Low | Chart already exists; only the grouping changes |
| Campaign launch validation | "Pick a mailbox" now reads the attached set | Low | Same message, same place |

**Verdict:** Fits an existing surface

The campaign detail page already has a mailbox selector; this widens it from one to many, which is a change of shape rather than a new place to go. No navigation item is added, and a user who only ever wants one mailbox sees a single line that looks much like today's control.
