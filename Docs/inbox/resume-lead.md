# Resume Paused Lead

| | |
|---|---|
| **Endpoint** | `PATCH https://server.smartlead.ai/api/v1/master-inbox/resume-lead` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/resume-lead |
| **Auth** | API key (query param `api_key`) |

Restarts a lead whose sequence was paused, either straight away or after a chosen number of days.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member whose lead said "come back to me in a month", **I want** to resume them after a delay I choose, **so that** the playbook picks up on its own instead of me diarising it.

**Acceptance criteria**
- [ ] Given a paused lead-campaign pairing (`campaign_id` plus `email_lead_map_id`), when I resume it, then the response confirms the pairing, the `resume_delay_days` and the computed `will_resume_at`.
- [ ] Given `resume_delay_days` of 0 (the default), when I resume, then the lead becomes active immediately and the engine may compose its next email on the following tick.
- [ ] Given a positive `resume_delay_days`, when I resume, then nothing is composed until `will_resume_at`, and the lead's record and thread both state when it resumes.
- [ ] Given a negative `resume_delay_days`, when I submit, then I get 422 naming the field and the zero minimum.
- [ ] Given a lead that is not paused, when I resume it, then the request is refused with a clear message rather than restarting an already-running lead.
- [ ] Given a lead who unsubscribed, bounced, or reached a terminal outcome, when I resume, then the request is refused and the reason is stated — unsubscribe is honoured regardless.
- [ ] Given the lead resumes, when the playbook reaches its next `Send:` node, then the composed email still parks in Needs your OK, so resuming never sends anything by itself.
- [ ] Given the resume completes, when it is recorded, then the activity trail names the actor, the delay and the resume time, and the lead's timeline shows it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, immediate | PATCH `{"campaign_id": 12345, "email_lead_map_id": 2433664091, "resume_delay_days": 0}` on a paused lead | 200, `success: true`, `data.will_resume_at` is now; the lead is active |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the lead stays paused |
| TC-3 | Not found / wrong workspace | PATCH with a `campaign_id` from another workspace | 404; nothing changes |
| TC-4 | Validation failure — negative delay | PATCH `resume_delay_days: -1` | 422 naming the field and the zero minimum |
| TC-5 | Rate limited | Resume many leads in a burst | 429 on the excess; the client backs off with jitter and reports which leads resumed |
| TC-6 | Empty result set | Open the Action Center with no paused leads | 200 with an empty list; the section reads "Nothing waiting on you" rather than rendering an empty table |
| TC-7 | Delayed resume | PATCH `resume_delay_days: 7` | `data.will_resume_at` is seven days ahead; no email is composed before then, and the lead's record states the date |
| TC-8 | Approval still required | Let a resumed lead reach its next `Send:` node | The email appears in Needs your OK; nothing is sent without approval |
| TC-9 | Not paused | Resume a lead that is already running | Refused with "This lead is not paused"; no duplicate scheduling and no double send |
| TC-10 | Unsubscribed lead | Resume a lead who unsubscribed | Refused with "This lead has unsubscribed"; nothing changes |
| TC-11 | Reply during the delay | Resume with a 7-day delay, then simulate a prospect reply on day 2 | The reply is classified and handled immediately; a live conversation is never held back by a pending resume |
| TC-12 | Delay lands outside working hours | Resume with a delay expiring at 2am | The first email is scheduled at the next allowed slot by the sending rhythm, not at 2am |

## 4. Frontend user story

**As a** team member, **I want** Resume to offer "now" or "in N days" wherever a paused lead appears, **so that** deferring is as easy as restarting.

**Scope**
- Dashboard → Action Center: the existing Resume control on each parked lead gains a small choice — Resume now, or Resume in 7 / 30 days, or a custom date — with the resolved date stated before confirming.
- Inbox → Replies thread view and Leads → lead detail: the same Resume control, so a paused lead can be restarted from wherever the user notices it.
- Paused leads show their state and, where a delayed resume is pending, the date it resumes, in text on the row.
- Loading: the control shows a pending state. Empty: the Action Center's existing empty state is reused. Error: inline message on the row keeping the chosen delay.
- Accessibility: the control is a labelled menu button whose options state the resolved date; pending resume dates are absolute as well as relative in the accessible name. Responsive: the menu becomes a bottom sheet under 640px.

**Definition of done**
- [ ] Resume with a delay works from the Action Center, the thread and the lead record, all through one component.
- [ ] The resolved resume date is stated before confirming and shown on the row afterwards.
- [ ] Refusals (not paused, unsubscribed, terminal) are explained in place rather than as a generic error.
- [ ] Loading, empty, refused and pending-resume states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** resume to accept a delay, **so that** "later" is a state the engine holds rather than something a person has to remember.

**Scope**
- Route in `server/routes.js`: extend the existing resume route to `PATCH /api/campaign-leads/:id/resume` taking `{ delayDays }`, defaulting to 0. Workspace-scoped, 404 outside the workspace.
- Data model: a `resume_at` column on `campaign_leads` in `server/db.js` alongside the existing paused state; a null value means resume immediately. Indexed with (`workspace_id`, `resume_at`) so the engine's due-lead scan is cheap.
- `server/engine.js` treats a lead with a future `resume_at` as still paused and skips it, then clears the column once it passes. An inbound reply clears `resume_at` and un-pauses immediately, so a live conversation always beats a pending resume.
- `server/pacing.js` still decides the actual minute, so a resume that expires outside working hours does not produce an out-of-hours email.
- Validation: refuse when the lead is not paused, has unsubscribed, has bounced or is terminal, each with its own message. Standard rate limiter; 429 retried by the client with backoff and jitter.
- Logged: an `events` row per resume with actor, delay and resolved time; `telemetry` counts pending delayed resumes so Monitoring can show work scheduled into the future.

**Definition of done**
- [ ] Delay parameter, `resume_at` column and index exist, covered by tests including cross-workspace 404.
- [ ] An engine test asserts nothing is composed before `resume_at` and that the first email still requires approval.
- [ ] A test asserts an inbound reply clears a pending resume.
- [ ] Resumes appear in the activity trail with the delay recorded.

## 6. End-to-end test ticket

**Title:** E2E — Defer a lead for a month and have the playbook pick them up

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, one lead paused after replying "not now, ask me in a month", approvals on.

**Flow**
1. Open Dashboard → Action Center and find the paused lead.
2. Choose Resume, pick "in 30 days", and read the resolved date before confirming.
3. Check the lead's row and the Leads page for the pending resume date.
4. Tick the engine several times over the following days in test time.
5. Advance to day 30 and tick again.
6. Open Inbox → Needs your OK.

**Assertions**
- [ ] The resolved date was stated in the browser's timezone before confirming, and it appears on the lead's row afterwards.
- [ ] No email is composed for that lead on any tick before day 30.
- [ ] On day 30 the playbook advances and an email appears in Needs your OK, unsent.
- [ ] Simulating a prospect reply on day 5 in a repeat run clears the pending resume and handles the reply straight away.
- [ ] The activity trail records the resume with the actor and the chosen delay.

**Teardown:** Delete the campaign and lead; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Dashboard → Action Center | Existing Resume button becomes a small menu with delay options | Low | Same button in the same place; the default first option is Resume now, so a click-through behaves as today |
| Inbox → Replies thread | Resume available on a paused lead's thread | Low | One item in the thread's existing overflow menu |
| Leads → lead detail | Pending resume date shown | Low | One line of text on the existing stage information |
| Monitoring | Pending delayed resumes counted | Low | One line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry's Action Center already lists every lead parked for a human decision and already has a resume control, so the capability is largely present — the genuinely new part is the delay, which turns "resume" into "resume later" and removes the need for a separate reminder. Because the existing button keeps its position and its first option, nobody has to relearn anything.
