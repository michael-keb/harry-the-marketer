# Add OAuth Email Account

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/save-oauth` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/add-oauth |
| **Auth** | API key (query param `api_key`) |

Registers a Gmail or Outlook mailbox using OAuth tokens, so the platform can send from it and keep the access token refreshed on its own.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner, **I want** to connect a sending mailbox through the provider's own OAuth consent screen and have Harry keep it authorised without me, **so that** campaigns keep sending without me re-authenticating every hour.

**Acceptance criteria**
- [ ] Given I complete Google consent, when the callback returns, then Harry stores the equivalent of SmartLead's `token` object — `access_token`, `refresh_token`, `expiry_date`, `scope`, `token_type: Bearer` — against a new mailbox and shows it as connected.
- [ ] Given the consent screen returns without a `refresh_token` (the user had already granted consent once), when Harry saves the mailbox, then it forces re-consent rather than storing an account that will die at the next expiry.
- [ ] Given the granted `scope` is missing send or read access, when Harry validates the connection, then the mailbox is rejected with a plain message naming the missing permission, mirroring SmartLead's 400 "Invalid or expired OAuth token".
- [ ] Given a successful connect, when the mailbox is created, then `from_name`, `from_email` and `username` are captured, `from_email` must equal the address that actually consented, and a per-mailbox daily limit defaults to 50 as it does today.
- [ ] Given a new mailbox, when it is created, then the warm-up ramp is switched on by default (the equivalent of `warmup_enabled: true` with `daily_rampup`), starting at 10 a day and climbing to the limit over a fortnight.
- [ ] Given the same `from_email` is already connected in this workspace, when I connect it again, then Harry updates the existing mailbox's tokens instead of creating a duplicate — SmartLead does this via the optional `id` field on the same body.
- [ ] Given a stored `refresh_token` is later revoked by the user in their Google account, when the engine next tries to send, then the mailbox is marked "Reconnect needed" and the campaign holds rather than erroring on every lead.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, Gmail | Complete Google consent for a fresh address with send + read scopes | 200 equivalent; response carries `id`, `from_email`, `type: GMAIL` and the connection-check flags (`is_smtp_success`, `is_imap_success`) both true; mailbox appears on Mailboxes as Connected |
| TC-2 | Missing/invalid API key | Call the save route with no session cookie (SmartLead: no `api_key`) | 401, `{"message": "Invalid API Key"}`; user is bounced to sign-in, no mailbox row written |
| TC-3 | Wrong workspace | Post a save body carrying an `id` belonging to another workspace's mailbox | 404, nothing updated, UI shows "That mailbox is not available" |
| TC-4 | Validation failure — bad provider type | Send `type: "YAHOO"` | 422, `{"error": "type must be one of [GMAIL, OUTLOOK]"}`; field-level message under the provider control |
| TC-5 | Rate limited | Run twenty connect attempts in a burst | 429 on the excess; client backs off with jitter and shows one "Retrying…" state, not twenty errors |
| TC-6 | Empty result set | Open Mailboxes on a workspace that has never connected anything | 200 with an empty list and the "Connect your first mailbox" empty state, not a spinner |
| TC-7 | Expired token in the body | Save with `expiry_date` in the past and no `refresh_token` | 400, `{"ok": false, "message": "Invalid or expired OAuth token"}`; mailbox not created, consent restarted |
| TC-8 | Reconnect an existing address | Connect an address already present, consenting again | Existing mailbox's tokens are replaced; still one row for that `from_email`; daily limit and warm-up progress are preserved |
| TC-9 | Consent cancelled | Start consent, press Cancel on Google's screen | Return to Mailboxes with "Connection cancelled — nothing was changed"; no partial mailbox row |
| TC-10 | Scope downgrade on reconnect | Reconnect an address but untick the read permission | Rejected with "Harry needs permission to read replies"; the previous working tokens are left intact |

## 4. Frontend user story

**As a** workspace owner, **I want** the Mailboxes page to walk me through connecting a mailbox and tell me exactly what went wrong when it fails, **so that** I never have to guess whether my campaign can send.

**Scope**
- Mailboxes page: the existing "Connect Gmail" button, plus a status row per mailbox showing address, display name, provider, daily limit, warm-up stage and health.
- New: a provider choice appears only once a second provider exists — until then the button stays "Connect Gmail" and no menu is introduced.
- States: connecting (button disabled with progress text), connected, "Reconnect needed" with a one-click reconnect, and cancelled (a dismissible line, not an error banner).
- Error copy is written from the failure, not the status code: missing permission, expired token, address mismatch between the consent account and the one expected.
- Accessibility: the connect flow is keyboard-reachable end to end; health is stated in words next to any colour dot; the return-from-consent state is announced to screen readers. Responsive: mailbox rows collapse to a stacked card under 640px.

**Definition of done**
- [ ] Connect, cancel, reconnect and permission-denied all have designed appearances, verified in light and dark.
- [ ] A mailbox missing a refresh token can never render as Connected.
- [ ] Display name (`from_name`) is editable inline after connection without a second consent round trip.
- [ ] The page reflects a newly connected mailbox without a manual refresh.

## 5. Backend user story

**As a** Harry API, **I want** to persist OAuth mailbox credentials and refresh them silently, **so that** the engine can send at any hour without a human in the loop.

**Scope**
- Routes in `server/routes.js` following the existing pattern: the Google consent start and `/api/google/callback` already exist in `server/google.js`; add the save path that upserts on `from_email` within the workspace, mirroring SmartLead's optional `id` on the same body.
- Data model: extend the `mailboxes` table in `server/db.js` with `from_name`, `provider` (`gmail` | `outlook` | `sandbox`), `scope`, `token_expires_at`, and keep `refresh_token` encrypted at rest. No new table.
- Token refresh: a helper in `server/google.js` refreshes ahead of `expiry_date` and retries once on a 401 from Gmail; a revoked refresh token flips the mailbox to `needs_reconnect` rather than retrying in a loop.
- Rate limiting and retry: connection validation is attempted once with a short timeout; 429 from the provider is backed off with jitter, never surfaced as a failed connect.
- Logged: an `events` row for connect / reconnect / revoke with actor and address; `telemetry` records token-refresh latency and failures so Monitoring's Gmail component check has something real behind it.

**Definition of done**
- [ ] Refresh tokens are never returned by any API response or written to logs.
- [ ] Upsert on `from_email` is covered by a test that connects the same address twice and asserts one row.
- [ ] A revoked-token simulation puts the mailbox into `needs_reconnect` and holds the campaign with a stated reason.
- [ ] Connect and revoke both appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Connect a mailbox and send from it

**Preconditions:** A workspace with no mailboxes, a stubbed OAuth provider that returns a token set with `refresh_token` and an `expiry_date` sixty seconds out, one campaign with a valid playbook and two leads.

**Flow**
1. Open Mailboxes and start the connect flow.
2. Complete the stubbed consent screen.
3. Return to Mailboxes and confirm the mailbox reads Connected with a 50/day limit and a warm-up ramp starting at 10.
4. Attach the mailbox to the campaign and launch it.
5. Wait past the stubbed token expiry, then let the engine tick.
6. Approve the waiting drafts in Inbox → Needs your OK.

**Assertions**
- [ ] The mailbox appears as Connected without a page reload.
- [ ] The send after the expiry succeeds, proving a silent refresh happened, and Monitoring shows a token-refresh event rather than a failure.
- [ ] Revoking the stubbed refresh token flips the mailbox to "Reconnect needed" in the UI and the campaign page states why it is holding.
- [ ] The activity trail names who connected the mailbox and when.

**Teardown:** Delete the mailbox and its tokens, delete the campaign, reset lead states.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Richer status row: provider, display name, warm-up stage, "Reconnect needed" | Low | Harry already shows connection and health here; this adds text to an existing row, not new controls |
| Mailboxes | Provider choice on connect | Medium | Hidden entirely until a second provider is actually supported — one button stays one button |
| Monitoring | Gmail component check gains token-refresh detail | Low | Existing component check, one more line of evidence |
| Settings | None | — | Nothing moves to Settings; mailboxes stay on the Mailboxes page |

**Verdict:** Fits an existing surface

Harry already connects Gmail via OAuth from the Mailboxes page, so nothing here needs a new place to go. What is genuinely new is the explicit token lifecycle in the UI — a mailbox that says "Reconnect needed" before a campaign fails, rather than after. No navigation item is added.
