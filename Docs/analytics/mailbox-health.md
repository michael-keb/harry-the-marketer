# Mailbox Overall Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/mailbox/overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/mailbox-health |
| **Auth** | API key (query param `api_key`) |

Counts your sending accounts by state right now — how many are connected, how many are actually in use, how many have dropped their connection, and how many are sending without warmup.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** a one-line count of my mailboxes by state, **so that** a Gmail account that quietly lost its connection is visible before a campaign stalls behind it.

**Acceptance criteria**
- [ ] Given mailboxes exist, when I request the stats, then `data.overall_mailbox_stats` returns `total_connected`, `in_use`, `disconnected` and `enabled_without_warmup`.
- [ ] Given `disconnected` is above zero, when the summary renders, then the count is shown as a warning with a direct link to the Mailboxes page filtered to those accounts.
- [ ] Given Harry ramps new Gmail mailboxes from 10 a day over a fortnight, when `enabled_without_warmup` is reported, then it counts mailboxes sending at full limit without having completed the ramp, and the wording explains the risk in one sentence.
- [ ] Given `in_use` counts mailboxes attached to a running campaign, when a mailbox is connected but attached to nothing, then it is in `total_connected` but not in `in_use`, and the difference is visible rather than implied.
- [ ] Given no mailboxes are connected, when I request the stats, then all counts are zero and the existing "Connect Gmail" empty state is shown instead of a summary of zeros.
- [ ] Given sandbox mailboxes exist, when the counts are computed, then they are reported separately so a test account never disguises a missing real one.
- [ ] Given the API key is invalid, when the stats are requested, then a 401 is surfaced as one banner and the rest of the page still renders.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 25 connected mailboxes, 20 in use, 3 disconnected, 2 without warmup. Call with a valid key | 200 with exactly those four fields and values |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the summary shows a reconnect message |
| TC-3 | Not found / wrong workspace | Pass `client_ids` for another workspace | 200 with zeros or 404 `{"error": "Resource not found"}`; no counts leak |
| TC-4 | Validation failure | Pass `client_ids=abc` | 422 `{"error": "Invalid parameters provided"}` naming `client_ids` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last known counts marked stale |
| TC-6 | Empty result set | Call on a workspace with no mailboxes | 200 with zeros; the Connect Gmail empty state shows instead of the summary |
| TC-7 | Connected but idle | Connect a mailbox and attach it to nothing | `total_connected` rises, `in_use` does not; the difference is shown as "connected, not in use" |
| TC-8 | Revoked token | Revoke a Gmail token so a mailbox loses its connection | `disconnected` rises within one refresh and the warning links to that mailbox |
| TC-9 | Warmup state | Seed a mailbox on ramp day 3 and another at full limit from day 1 | Only the second is in `enabled_without_warmup` |
| TC-10 | Sandbox separated | Add a sandbox mailbox to a workspace with two real ones | The sandbox is reported in its own count and excluded from the warnings |
| TC-11 | Live update | Disconnect a mailbox with the Dashboard open | The count moves on the next poll without a full page reload |

## 4. Frontend user story

**As a** marketer, **I want** the mailbox state summary where I already look for trouble, **so that** a disconnected account is a warning rather than a discovery.

**Scope**
- Monitoring: the existing component checks for mailboxes gain these four counts, with disconnected mailboxes graded as a failing check rather than a note.
- Mailboxes page: one summary line above the list — "25 connected, 20 in use, 3 disconnected" — where each part filters the list below.
- Dashboard: no new tile; the existing engine heartbeat area shows a single warning only when `disconnected` is above zero.
- Loading shows a skeleton line. Empty falls through to "Connect Gmail". Error hides the summary and leaves the list working.
- Accessibility: the summary is a list of links with text labels including counts, readable without colour, wrapping on narrow screens.

**Definition of done**
- [ ] Disconnected mailboxes produce a visible warning on both Monitoring and Mailboxes.
- [ ] Each summary part filters the mailbox list.
- [ ] Sandbox mailboxes are labelled and excluded from warnings.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** one grouped count of mailbox states, **so that** Monitoring and Mailboxes report the same numbers from the same query.

**Scope**
- Add `GET /api/analytics/mailboxes/summary` to `server/routes.js`, workspace-scoped, returning `{ total_connected, in_use, disconnected, enabled_without_warmup, sandbox }`.
- Data model: none. Derive `disconnected` from the stored refresh-token state that `server/google.js` already tracks, `in_use` from mailboxes attached to a running campaign, and the warmup state from the existing ramp logic in `server/pacing.js`.
- No pagination. The existing API limiter applies; cached in-process for 15 seconds per workspace, matching the Monitoring poll.
- Log a `telemetry` row when `disconnected` rises, so the incident feed carries the transition rather than the steady state.

**Definition of done**
- [ ] The four counts are derived, never stored, so they cannot drift from the mailbox records.
- [ ] Sandbox mailboxes are counted separately and excluded from `enabled_without_warmup`.
- [ ] A newly revoked token moves a mailbox to `disconnected` on the next call.
- [ ] Cross-workspace mailboxes are never counted.

## 6. End-to-end test ticket

**Title:** E2E — mailbox state summary and disconnection warning

**Preconditions:** A workspace with three sandbox mailboxes and one simulated Gmail mailbox attached to a running campaign; one further mailbox connected but attached to nothing.

**Flow**
1. Sign in and open Mailboxes.
2. Read the summary line.
3. Simulate a lost connection on the attached mailbox.
4. Refresh Mailboxes, then open Monitoring.
5. Click the disconnected count.

**Assertions**
- [ ] The summary distinguishes connected from in use, with the idle mailbox counted only in connected.
- [ ] After the simulated loss, `disconnected` is 1 on both pages.
- [ ] Monitoring grades the mailbox check as failing and the incident feed carries one entry.
- [ ] Clicking the count filters the mailbox list to that account.
- [ ] Sandbox mailboxes are labelled and produce no warning.

**Teardown:** Delete the seeded mailboxes and campaign; clear the telemetry rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Adds one summary line above the existing list | Low | Text only, each part a filter link |
| Monitoring | The existing mailbox component check gains these counts | Low | Fills out a check that already exists |
| Dashboard | A warning appears only when a mailbox is disconnected | Low | Nothing is shown in the healthy case, so the page does not grow |

**Verdict:** Fits an existing surface

Harry's Monitoring page already checks mailboxes as a component and shows delivery telemetry per mailbox, so the states are known but never counted in one place. The honest change is a summary line and a warning that appears only when something is wrong, which is the opposite of adding a panel.
