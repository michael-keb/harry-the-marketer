# Update Email Account

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/{id}` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/update |
| **Auth** | API key (query param `api_key`) |

Changes a mailbox's non-credential settings — daily limit, display name, signature, BCC, tracking domain, minimum gap between emails — without touching its login.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner whose mailbox reputation has improved, **I want** to raise its daily limit and tidy its display name and signature without reconnecting it, **so that** I can tune sending volume as trust builds.

**Acceptance criteria**
- [ ] Given a mailbox I own, when I send only the fields I changed, then omitted fields are left untouched — the endpoint is a partial update, and the response is `{"ok": true, "message": "Email account updated successfully"}`.
- [ ] Given I change `max_email_per_day`, when the sending rhythm next runs, then the new limit applies from that point and the gap between emails is recomputed from the day's remaining allowance, exactly as `server/pacing.js` already does.
- [ ] Given a mailbox still climbing its warm-up ramp, when I raise the daily limit, then the ramp's ceiling moves but the current day's figure does not jump — raising the limit must never turn a warm mailbox into a cold blast.
- [ ] Given I lower `max_email_per_day` below what has already gone out today, when the change saves, then no email is un-sent; the mailbox simply sends nothing more today and the row reads "0 left today".
- [ ] Given I set `time_to_wait_in_mins`, when the engine paces, then that minimum gap is honoured as a floor beneath Harry's existing randomised gap, so setting it can only slow sending, never speed it up.
- [ ] Given I set `bcc` or a `custom_tracking_url`, when the next email sends, then the BCC address is on it and tracking links use the custom domain; an unreachable tracking domain is rejected at save time with a field-level message rather than silently breaking every link.
- [ ] Given I set a `signature`, when it is stored, then the HTML is sanitised, and it is appended below the agent-composed body without displacing the opt-out line that every send must carry.
- [ ] Given an id from another workspace, when I update it, then the response is 404 `{"error": "Email account not found"}` and nothing changes.
- [ ] Given credentials need changing, when I try to do it here, then the UI directs me to reconnect instead — this endpoint deliberately does not accept credentials.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, partial update | POST `{"max_email_per_day": 60, "from_name": "John Doe - Sales"}` | 200, `{"ok": true}`; a follow-up GET shows both changed and the signature, BCC and tracking domain unchanged |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; nothing written |
| TC-3 | Not found / wrong workspace | POST to an id owned by another workspace | 404, `{"error": "Email account not found"}`; UI shows "That mailbox is not available" |
| TC-4 | Validation failure | POST `{"max_email_per_day": -5}` | 422 with a field-level message on the limit; previous value preserved |
| TC-5 | Rate limited | Save on every keystroke in the limit field | 429 on the excess; the client debounces, sends one save, and shows one "Saving…" state |
| TC-6 | Empty result set | POST `{}` | 200 with nothing changed, or 422 "Nothing to update" — never a partial wipe of unspecified fields |
| TC-7 | Lower the limit below today's count | Mailbox has sent 25; POST `{"max_email_per_day": 20}` | 200; nothing un-sends; the row reads "0 left today" and the campaign holds for that mailbox until tomorrow |
| TC-8 | Raise the limit mid-warm-up | Mailbox at day 5 of the ramp; POST `{"max_email_per_day": 200}` | 200; today's warm-up figure is unchanged, the ramp ceiling moves, and the mailbox detail sheet states the new date it reaches full volume |
| TC-9 | Minimum gap is a floor | POST `{"time_to_wait_in_mins": 10}` on a mailbox whose computed gap is 4 minutes | Actual gaps are at least 10 minutes; the deterministic randomisation still applies above the floor |
| TC-10 | Bad tracking domain | POST `{"custom_tracking_url": "not a domain"}` | 422 with a field-level message; existing tracking links keep working |
| TC-11 | Signature does not displace the opt-out | Set a signature, send an email | The email carries the signature and still carries the plain-text opt-out line and the List-Unsubscribe header |
| TC-12 | Credential attempt | Include a password field in the body | Rejected with a message pointing at reconnect; no credential is written |
| TC-13 | Suspend through update | POST `{"is_suspended": true}` | Mailbox suspends, matching the dedicated suspend route exactly — one behaviour, two doors |

## 4. Frontend user story

**As a** workspace owner, **I want** to edit a mailbox's settings in place and see what each one will do, **so that** changing a number does not feel like a gamble.

**Scope**
- Mailbox detail sheet: an editable Sending section — display name, daily limit, minimum gap, BCC, signature, custom tracking domain — each saving on blur with an inline confirmation, no separate Save page.
- Each control carries one line of consequence text: the daily limit shows the effect on the ramp and on today's remaining allowance; the minimum gap shows the resulting rough pace ("about one every 12 minutes in your working hours").
- The signature editor is a small rich-text field with a preview that shows where the opt-out line sits, so a user cannot design a signature that appears to replace it.
- States: saving per field, saved, field-level error that keeps the entered value, and conflict if a teammate changed it first.
- Accessibility: every field has a label and `aria-describedby` pointing at both the help text and any error; the preview is readable text, not an image. Responsive: the section is a single column under 768px.

**Definition of done**
- [ ] Every field saves independently; one bad field never blocks the others.
- [ ] Consequence text updates live as the value changes.
- [ ] Signature preview shows the opt-out line in place.
- [ ] Saving, saved, error and conflict states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a partial-update route for mailbox settings, **so that** volume can be tuned without any credential ever passing through it.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `PATCH /api/mailboxes/:id` accepting only the safe field set — `fromName`, `dailyLimit`, `minGapMinutes`, `bcc`, `signature`, `trackingDomain`, `isSuspended` — and explicitly rejecting anything credential-shaped.
- Data model: `mailboxes` gains `signature`, `bcc`, `tracking_domain` and `min_gap_minutes`; `daily_limit` already exists. No new table.
- `server/pacing.js` reads the limit and the gap floor; the warm-up ramp keeps its own current figure so a limit change moves the ceiling only. `server/mailer.js` applies BCC and the tracking domain at send time, and always appends the opt-out line after any signature.
- Validation: limit is a positive integer within a sane ceiling, gap is non-negative, tracking domain must resolve and be a hostname, signature HTML is sanitised against a strict allowlist.
- Standard rate limiter; the client debounces rather than the server queueing. No retry needed for a single-row write.
- Logged: an `events` row per change with actor, field, old and new value — a daily-limit change is the kind of thing a teammate needs to be able to trace; `telemetry` records limit changes so Monitoring can correlate them with bounce-rate movement.

**Definition of done**
- [ ] Credential fields are rejected at the route, covered by a test.
- [ ] Partial update leaves omitted fields untouched, covered by a test.
- [ ] A limit change never raises today's warm-up figure, covered by a pacing test.
- [ ] Signature sanitisation and the always-appended opt-out line are covered by mailer tests.

## 6. End-to-end test ticket

**Title:** E2E — Tune a mailbox's sending volume

**Preconditions:** A workspace with one sandbox mailbox on a 50/day limit, mid-warm-up at day 5, attached to one running campaign with twenty leads, approvals on.

**Flow**
1. Open the mailbox detail sheet and raise the daily limit to 100.
2. Read the consequence text under the limit.
3. Set a minimum gap of 10 minutes and a signature, then blur each field.
4. Approve several drafts and let the engine tick through the sending window.
5. Lower the limit to a number below today's already-sent count.
6. Open the activity trail.

**Assertions**
- [ ] The consequence text states the new ceiling and the date the ramp reaches it, and today's warm-up figure does not jump.
- [ ] Sent emails carry the signature, and every one still carries the plain-text opt-out line.
- [ ] Observed gaps between sends are at least 10 minutes, still randomised above that floor.
- [ ] After lowering the limit, nothing un-sends and the mailbox reports no allowance left today.
- [ ] Every field change appears in the activity trail with the old and new value.

**Teardown:** Reset the limit, gap and signature; delete the campaign; reset send counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailbox detail sheet | Sending section becomes editable, six fields | Medium | Fields live in a sheet that only opens for one mailbox; each has one line of help, and the daily limit — the one people actually change — is first |
| Mailboxes | Row reflects the changed limit and gap | Low | Numbers the row already shows |
| Campaign detail | Pace estimate reflects the new gap | Low | Existing "next email goes at" line, recalculated |
| Settings | None | — | These are per-mailbox settings and must not migrate to a global Settings page |

**Verdict:** Fits an existing surface

Harry already has per-mailbox daily limits, so most of this is making an existing number editable in the right place. Signature, BCC, tracking domain and gap floor are genuinely new fields, and the mitigation for those is that they sit in a per-mailbox sheet behind a single click rather than in the main list. No navigation item is added.
