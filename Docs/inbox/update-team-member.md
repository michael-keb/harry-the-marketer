# Assign Team Member

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/update-team-member` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/update-team-member |
| **Auth** | API key (query param `api_key`) |

Makes one person responsible for one lead's conversation, or hands it to someone else.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** workspace owner with a colleague sharing the inbox, **I want** to assign a conversation to one of us, **so that** two people do not answer the same prospect and nobody assumes the other has it.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`) and a `team_member_id`, when I assign it, then the response confirms both ids and an `assigned_at` timestamp, and the assignee's name appears on the thread and the list row.
- [ ] Given a `team_member_id` that is not a member of my workspace, when I assign, then I get 404 with the documented "Team member not found" wording and nothing changes.
- [ ] Given a non-numeric `email_lead_map_id`, when I submit, then I get 422 naming the field and nothing changes.
- [ ] Given the lead is already assigned, when I assign it to someone else, then it is a reassignment — one assignee at a time — and the previous assignee is recorded in the change.
- [ ] Given a lead is assigned, when the assignee opens the Inbox with the "Assigned to me" filter, then it is in their list and out of everyone else's personal list.
- [ ] Given the standing rule, when a lead is assigned, then any workspace member may still approve that lead's drafts — assignment expresses responsibility, not permission, and Harry's Team feature already lets any member approve.
- [ ] Given assignment can be cleared, when I unassign, then the lead returns to the unassigned pool and the change is recorded.
- [ ] Given any assignment or reassignment, when it completes, then the activity trail names the actor, the lead, the previous assignee and the new one.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_lead_map_id": 2433664091, "team_member_id": 456}` | 200, `success: true`, `data.assigned_at` present; the thread shows the assignee's name |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" and reverts the optimistic change |
| TC-3 | Not found — member | POST with a `team_member_id` from another workspace | 404, `{"error": "Team member not found with ID 456"}`; nothing changes |
| TC-4 | Validation failure | POST `email_lead_map_id: "abc"` | 422, `{"error": "email_lead_map_id must be a valid number"}` |
| TC-5 | Rate limited | Assign many leads in a burst, for example a round-robin over a new batch | 429 on the excess; the client backs off with jitter and reports which leads were assigned |
| TC-6 | Empty result set | Open the assignee picker in a solo workspace | The picker shows only the current user with a note about inviting colleagues in Settings → Team; no failing request is sent |
| TC-7 | Reassignment | Assign to member A, then to member B | Single assignee at all times; the activity trail shows A → B with the actor |
| TC-8 | Unassign | Clear the assignee | The lead returns to the unassigned pool and appears under the Unassigned filter |
| TC-9 | Personal queues update | Assign a lead to B while A has "Assigned to me" open | The lead leaves A's list and joins B's on refresh, with counts updating in both |
| TC-10 | Approval is not restricted | As member A, approve a draft for a lead assigned to B | Approval succeeds; assignment does not gate the approval queue, and the approver is recorded as A |
| TC-11 | Member removed from the workspace | Remove a member who has leads assigned | Their leads return to the unassigned pool with a recorded reason rather than pointing at a departed user |
| TC-12 | Bulk assign | Select five threads and assign them to one member | Each is assigned, per-row failures are reported individually, and the activity trail holds one coalesced entry naming the count |

## 4. Frontend user story

**As a** team member, **I want** an assignee control on the thread and the list row, **so that** handing work over is visible to everyone instead of happening in chat.

**Scope**
- Inbox → Replies: an assignee control on the thread header and in the row overflow menu, listing workspace members from Settings → Team plus "Unassigned"; multi-select rows can be assigned in one action from the selection toolbar.
- Rows and the thread header show the assignee's name so ownership is legible without opening anything; the "Assigned to me" and "Unassigned" filters read the same value.
- A one-line note under the control states what assignment does and does not do: it marks responsibility, it does not restrict who can approve.
- Loading: optimistic update with revert on failure. Empty: solo workspace shows the invite path. Error: inline message on the row naming what failed.
- Accessibility: the control is a labelled combobox with keyboard search; assignee names are text, never avatars alone; changes are announced. Responsive: the control becomes a bottom sheet under 640px.

**Definition of done**
- [ ] Assign, reassign and unassign work from the thread, a row and a multi-selection.
- [ ] Assignee names render on rows and headers, and drive the personal-queue filters.
- [ ] The note about approval not being gated is present wherever assignment is set.
- [ ] Loading, revert, solo-workspace, bulk-partial-failure and departed-member states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an assignee on the lead-campaign pairing, **so that** shared workspaces have an answer to "whose is this" without changing who may act.

**Scope**
- Route in `server/routes.js`: `PATCH /api/campaign-leads/:id/assignee` taking `{ userId | null }`, plus a bulk form taking `{ ids: [], userId }` with per-id results. Workspace-scoped; the target user must be a member of the caller's workspace or the route returns the documented 404.
- Data model: `assigned_user_id`, `assigned_by` and `assigned_at` on `campaign_leads` in `server/db.js`, indexed with (`workspace_id`, `assigned_user_id`, `last_reply_at`) to serve the personal-queue query in one scan.
- Assignment is deliberately not an authorisation boundary: the approval route continues to accept any workspace member, matching the existing Team behaviour where an invited coach or assessor can approve. A test pins this so it cannot drift into a permission by accident.
- Membership changes: removing a member clears their assignments with a recorded reason rather than leaving dangling references.
- Standard rate limiter; bulk writes run per chunk in a transaction with per-id outcomes so a partial failure is reported honestly. 429 retried by the client with backoff and jitter.
- Logged: an `events` row per assignment with actor, previous and new assignee, coalesced for bulk actions; `telemetry` records assigned-lead counts per member so Monitoring can show an uneven load.

**Definition of done**
- [ ] Assignee columns, index and single plus bulk routes exist, covered by tests including the cross-workspace member 404.
- [ ] A test asserts assignment does not gate approval.
- [ ] A test asserts removing a member clears their assignments with a reason.
- [ ] Assignments appear in the activity trail with previous and new assignee.

## 6. End-to-end test ticket

**Title:** E2E — Split a shared reply queue between two people

**Preconditions:** A workspace with two members (A the owner, B invited in Settings → Team), a sandbox mailbox, one running campaign, five leads that have replied, nothing assigned, approvals on, one draft waiting in Needs your OK for a lead that will be assigned to B.

**Flow**
1. Member A opens Inbox → Replies and assigns two threads to B from the row menus.
2. A selects two more and bulk-assigns them to themselves.
3. A switches to "Assigned to me" and then to "Unassigned".
4. Member B signs in, opens "Assigned to me", and reads the note under the assignee control.
5. A approves the waiting draft for a lead assigned to B.
6. The owner removes B from the workspace in Settings → Team.

**Assertions**
- [ ] Each list shows the correct assignee names and the counts add up to five across assigned and unassigned.
- [ ] The bulk action reported the number assigned and produced one coalesced activity-trail entry.
- [ ] B sees exactly their two threads and the note stating assignment does not restrict approval.
- [ ] A's approval of B's lead succeeds and is recorded with A as the approver.
- [ ] After B is removed, their leads are back in the unassigned pool with the reason recorded and no reference to a departed user.

**Teardown:** Unassign everything, delete the campaign and leads, reset the sandbox mailbox, restore the team membership.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Assignee control on the thread header, row menu and selection toolbar | Medium | One control repeated in familiar places; entirely hidden in a solo workspace, which is the common case |
| Inbox rows | Assignee name shown | Low | One piece of secondary text on a row that already carries campaign and time |
| Settings → Team | Unchanged apart from assignments clearing on removal | Low | No new control; only the removal behaviour is specified |
| Monitoring | Assigned-lead counts per member | Low | One line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry's Team feature already shares leads, campaigns, mailboxes, inbox and reports across a workspace, but there is no way to say who is handling a particular conversation, which is exactly where a shared inbox goes wrong. The important constraint recorded here is that assignment must stay a marker of responsibility and never quietly become a permission — any member can still approve, as the Team feature already promises.
