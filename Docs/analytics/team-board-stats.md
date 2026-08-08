# Team Board Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/team-board/overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/team-board-stats |
| **Auth** | API key (query param `api_key`) |

Shows one row per team member — leads, campaigns, replies, positive replies, rates and average reply time — for a chosen date range.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** workspace owner with a small team, **I want** each member's campaigns, replies and response time for a date range, **so that** I can see who is keeping up with their inbox rather than guessing.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the stats, then `data.team_board_stats` returns per member `id`, `name`, `profile_pic_url`, `lead_count`, `campaign_count`, `reply_count`, `positive_reply_count`, `reply_rate`, `positive_reply_rate`, `average_reply_time` and `unique_open_count`.
- [ ] Given Harry's team members share one workspace, when a metric is attributed, then it is attributed by who created the campaign or who approved and sent the email, and the panel states which rule applies to which column.
- [ ] Given the standing rule that nothing sends without a human's OK, when the board renders, then approvals given and emails edited before sending are included per member, because that is the work Harry's team actually does.
- [ ] Given `average_reply_time` arrives as a string like `"2h 15m"`, when it is rendered, then it is displayed as given and sorted on a numeric field returned alongside it, never by parsing the label.
- [ ] Given a member joined mid-range or did nothing, when the board renders, then they appear with zeros and a "no activity in this range" note rather than being omitted.
- [ ] Given a solo workspace, when the board is requested, then it returns a single row and the UI hides the panel, since a leaderboard of one is not information.
- [ ] Given `profile_pic_url` may be missing or point off-site, when an avatar renders, then a local initials fallback is used and no third-party image is loaded that the content security policy would block.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a member with 250 leads, 5 campaigns, 30 replies and 15 positive in January. Request that range | 200 with one row carrying those values and rate strings like `"12%"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the board shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty list; no member names leak |
| TC-4 | Validation failure | Omit `start_date` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous board marked stale |
| TC-6 | Empty result set | Request a range before the team existed | 200 with an empty list; empty state names the range |
| TC-7 | Inactive member | Invite a member who does nothing in the range | The row appears with zeros and the "no activity in this range" note |
| TC-8 | Solo workspace | Request on a workspace with one member | One row returned; the UI hides the panel entirely |
| TC-9 | Reply time sorting | Seed members with `"45m"`, `"2h 15m"` and `"1d 3h"` | Sorting is correct and driven by the numeric field, not the label text |
| TC-10 | Missing avatar | Omit `profile_pic_url` for a member | Initials fallback renders; no external request is attempted |
| TC-11 | Approvals counted | Have one member approve five drafts that another member composed | Approvals are attributed to the approver and composition to the campaign owner, per the stated rules |

## 4. Frontend user story

**As a** workspace owner, **I want** a small team activity panel in Settings, **so that** it informs a conversation rather than becoming a leaderboard on the Dashboard.

**Scope**
- Settings → Team: below the existing member list, a table with campaigns, leads, approvals, replies handled, positive replies and average reply time for the shared date range.
- The panel is visible to the owner and members alike, with the same numbers for everyone, since a hidden scoreboard is worse than an open one.
- Avatars use a local initials fallback. Loading shows skeleton rows. Empty shows a message naming the range. Error hides the table and leaves membership management working.
- Accessibility: a real table with a caption naming the range, sortable headers exposed with `aria-sort`, and its own horizontal scroll container on narrow screens.

**Definition of done**
- [ ] The panel does not appear on the Dashboard or Reports.
- [ ] It is hidden entirely for solo workspaces.
- [ ] Each column carries a one-line definition of how it is attributed.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** per-member activity aggregated over a window, **so that** the team panel reads one query rather than scanning the activity trail in the browser.

**Scope**
- Add `GET /api/analytics/team?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped and restricted to workspace members.
- Data model: none if the `events` trail already records who approved, edited and created; otherwise ensure the actor id is written on those event rows, which the activity trail already needs.
- Attribute campaigns and leads by creator, approvals and edits by actor, and reply handling by whoever sent the manual reply. Return `average_reply_time` as both a display string and a numeric seconds field.
- Validate the date pair, cap the window, return zeros for inactive members. The existing API limiter applies with brief caching.
- Log a `telemetry` row per call; do not log per-member figures, which would duplicate personal activity data.

**Definition of done**
- [ ] Attribution rules are implemented in one module and unit tested per column.
- [ ] Inactive members are returned with zeros, not omitted.
- [ ] Rates return `null` on a zero denominator.
- [ ] A non-member request returns 404, never a partial board.

## 6. End-to-end test ticket

**Title:** E2E — team activity for a date range

**Preconditions:** A workspace with an owner and two invited members. Member A created two campaigns and approved four drafts; member B approved one draft and sent two manual replies; the owner did nothing in the test range.

**Flow**
1. Sign in as the owner and open Settings → Team.
2. Set the range to the test week.
3. Read the table.
4. Sort by average reply time.
5. Sign in as member B and open the same panel.

**Assertions**
- [ ] Member A's campaign count is 2 and approval count is 4.
- [ ] Member B's manual replies are attributed to them, not to the campaign owner.
- [ ] The owner appears with zeros and the "no activity in this range" note.
- [ ] Sorting by reply time orders correctly across minutes, hours and days.
- [ ] Member B sees the same numbers the owner sees.

**Teardown:** Remove the invited members and delete the seeded campaigns, leads, messages and events.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Team | Adds an activity table under the existing member list | Low | Hidden for solo workspaces; placed where team membership is already managed |
| Dashboard | None | Low | Deliberately not a KPI tile — per-person numbers on the front page read as a scoreboard |
| Reports | None | Low | Reports is about the outreach, not about the people |

**Verdict:** Fits an existing surface

Harry already records who approved what and whether they edited it in the activity trail, so the raw material exists; nothing here is a new measurement. The judgement call is placement — this belongs beside the team list in Settings, not on the Dashboard, because per-person figures on a shared front page change how people behave more than they inform.
