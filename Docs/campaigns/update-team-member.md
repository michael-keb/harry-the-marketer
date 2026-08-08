# Update Campaign Team Member

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/team-member` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-team-member |
| **Auth** | API key (query param `api_key`) |

Assigns a campaign to a member of the workspace, or clears the assignment, so it is clear who is responsible for it.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** workspace owner with a coach and two colleagues in the workspace, **I want** to say who owns each campaign, **so that** the approvals waiting in Needs your OK have a name against them instead of sitting until someone happens to look.

**Acceptance criteria**
- [ ] Given a workspace member, when I assign them with `teamMemberId`, then I get `{ success: true, message: "Team member updated" }` and the campaign shows them as its owner.
- [ ] Given `teamMemberId` is `null`, when I send it, then the assignment is cleared and the campaign shows as unassigned rather than falling back silently to the workspace owner.
- [ ] Given the id is not a member of this workspace, when I assign it, then I get a not-found response and the assignment is unchanged.
- [ ] Given a campaign is assigned, when its drafts appear in Needs your OK, then they carry the owner's name, and the Inbox can be filtered to "assigned to me".
- [ ] Given assignment does not change permissions, when a different member opens the campaign, then they can still approve and act — Harry's team model shares the workspace, and this is accountability, not access control.
- [ ] Given a member is removed from the workspace, when they owned campaigns, then those campaigns become unassigned and the change is recorded rather than pointing at a missing user.
- [ ] Given an assignment changes, when I check the activity trail, then it names who assigned whom and when.
- [ ] Given Slack or Teams alerts are configured, when a campaign has an owner, then the alert names the owner so the right person is prompted.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ "teamMemberId": 456 }` for a member of the workspace | 200 `{ success: true, message: "Team member updated" }`; the campaign lists that member as owner |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the assignment is unchanged |
| TC-3 | Not found / wrong workspace | Assign a user id from another workspace | 404; unchanged |
| TC-4 | Validation failure | POST `{ "teamMemberId": "bob" }` | 422 naming the field and its expected type |
| TC-5 | Rate limited | Reassign many campaigns in a loop | 429 on some; retries settle and every campaign ends with its intended owner |
| TC-6 | Empty result set | Filter Campaigns by "assigned to me" as a member owning none | 200 with an empty list and an empty state offering to clear the filter |
| TC-7 | Unassign | POST `{ "teamMemberId": null }` | The campaign reads as unassigned, not as owned by the workspace owner |
| TC-8 | Member removed | Assign a member, then remove them from the workspace in Settings → Team | The campaign becomes unassigned; the activity trail records why |
| TC-9 | Permissions unchanged | Assign to one member, sign in as another, approve a draft | Approval succeeds; assignment did not restrict anyone |
| TC-10 | Approval attribution | Assign, then have a different member approve a draft | The trail records the approver, not the owner, as the person who approved |
| TC-11 | Alert naming | Configure a Slack webhook, assign an owner, trigger an approval alert | The alert names the owner |
| TC-12 | Idempotency | Assign the same member twice | Success both times; one assignment event |

## 4. Frontend user story

**As a** workspace owner, **I want** an owner shown on every campaign and a way to filter by it, **so that** a team of three does not leave approvals to whoever notices first.

**Scope**
- Campaigns list: an "Owner" column showing an avatar and name, or "Unassigned", with a picker inline on the row.
- Campaign detail header: the same picker, listing members from Settings → Team plus an "Unassign" option.
- Inbox → Needs your OK and the Dashboard Action Center: an "Assigned to me" filter, and the owner's name on each queued item.
- Loading disables the picker; failure restores the previous owner with a message. Unassigned is a real, visible state.
- Accessibility: the picker is a labelled listbox reading member names, not initials; the owner is text plus avatar, never avatar alone; the filter is a toggle with its state announced. On mobile the owner appears as a line under the campaign name rather than a column.

**Definition of done**
- [ ] Owner is visible on the list, the detail page and the approval queue.
- [ ] "Unassigned" is shown explicitly and is always selectable.
- [ ] The "Assigned to me" filter works in the Inbox and the Action Center.
- [ ] Assignment never hides or blocks anything for other members.

## 5. Backend user story

**As a** Harry server, **I want** an optional owner on each campaign, **so that** queues and alerts can be attributed without changing the shared-workspace permission model.

**Scope**
- Add `PUT /api/campaigns/:id/owner` to `server/routes.js` accepting `{ user_id }` where null clears it, workspace-scoped.
- Data model: a nullable owner column on `campaigns` referencing the workspace's users, with the reference cleared when a member is removed.
- Validate that the user is a current member of the workspace; do not accept an invited-but-not-joined address as an owner until they sign in.
- Include the owner in the payloads that feed Needs your OK, the Action Center and the Slack/Teams alert builder, so those surfaces do not need a second lookup.
- Assignment must not gate any action: authorization stays workspace-level as it is today.
- Write an `events` row naming the actor and the assignment change, and a `telemetry` row for the call.

**Definition of done**
- [ ] Owner is nullable and clearing it is tested.
- [ ] Removing a member unassigns their campaigns, proven by a test.
- [ ] No route's authorization decision reads the owner field.
- [ ] Alerts include the owner when one is set.

## 6. End-to-end test ticket

**Title:** E2E — assign campaign ownership across a team

**Preconditions:** A workspace with an owner and two invited members who have signed in, three campaigns, a configured Slack webhook pointing at a local stub, and at least one draft awaiting approval per campaign.

**Flow**
1. Sign in as the workspace owner and open Campaigns.
2. Assign campaign A to the first member and campaign B to the second; leave C unassigned.
3. Open Inbox → Needs your OK and enable "Assigned to me".
4. Sign in as the first member and repeat step 3.
5. As the first member, approve a draft on campaign B.
6. As the owner, remove the second member in Settings → Team.

**Assertions**
- [ ] Campaign C reads as "Unassigned", not as owned by the workspace owner.
- [ ] The first member's "Assigned to me" filter shows only campaign A's drafts.
- [ ] Approving campaign B's draft as a non-owner succeeds and the trail records the approver.
- [ ] The Slack stub receives an alert naming the campaign's owner.
- [ ] After step 6, campaign B reads as unassigned and the trail explains why.

**Teardown:** Remove the webhook, delete the campaigns and drafts, restore team membership, clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns list | Owner column with an inline picker | Medium | Hidden entirely for single-member workspaces; collapses to a line under the name on mobile |
| Campaign detail | Owner picker in the header | Low | One control beside the existing status control |
| Inbox / Action Center | Owner name and an "Assigned to me" filter | Low | One toggle; owner shown on items that have one |

**Verdict:** Fits an existing surface

Harry already has a team model in Settings, so this attaches a name to work that already exists rather than introducing a role system. Hiding the column entirely when the workspace has one member is what keeps the solo user's Campaigns page exactly as simple as it is today.
