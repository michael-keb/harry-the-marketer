# Create Subsequence Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/create-subsequence` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/create-subsequence |
| **Auth** | API key (query param `api_key`) |

Creates a child campaign that leads move into automatically when something happens to them in the parent campaign.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to hand a lead off from one campaign to another when a specific thing happens, **so that** a person who goes quiet or gets interested continues in a playbook written for that situation instead of one written for a cold open.

**Acceptance criteria**
- [ ] Given a parent campaign, when I create a child campaign linked to it (the source API's `parent_campaign_id` and `subsequence_name`), then the child is created in draft, its id is returned, and the link between the two is visible from both campaigns.
- [ ] Given a set of trigger events on the parent (the `condition_events` array), when a lead matches one, then that lead exits the parent playbook at its current node and enters the child playbook at its Start node, and the handoff is recorded in the activity trail with the triggering event named.
- [ ] Given a lead that has moved to a child campaign, when the parent's engine ticks, then no further parent emails are composed for that lead — one person is only ever live in one playbook at a time.
- [ ] Given the child campaign is not ready (invalid playbook, no mailbox), when a lead would be handed off, then the lead is parked in the Action Center for a human decision rather than silently dropped or left in the parent.
- [ ] Given approvals are on, when a lead lands in the child campaign, then its first email in that campaign still parks in Needs your OK — a handoff is never an implicit approval to send.
- [ ] Given a lead has unsubscribed, when a trigger would move it, then no handoff happens; unsubscribe outranks every routing rule.
- [ ] Given a child campaign linked to a parent, when I try to make the parent a child of that same campaign, then it is refused — the link is a tree, not a cycle.
- [ ] Given no trigger events are defined, when the child is created, then it exists as an ordinary campaign that leads only enter manually, and the UI says so.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ parent_campaign_id: 123, subsequence_name: "Follow-up Sequence", condition_events: [] }` | 200 with `success: true` and a `subsequence_id`; both campaigns show the link |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; nothing created, the typed name preserved in the dialog |
| TC-3 | Parent not found / wrong workspace | POST with a parent id from another workspace | 404; no child created and no dangling link |
| TC-4 | Validation failure | POST with no `parent_campaign_id` | 422 with a field-level message naming the missing parent |
| TC-5 | Rate limited | Create children in a tight loop | 429 on the excess; client backs off, no duplicate children |
| TC-6 | Empty result set | Open a parent that has no children | 200 with an empty list; the campaign page shows "No follow-on campaigns" |
| TC-7 | Trigger fires | Define "reply: not now" as a trigger, then simulate that reply on a sandbox lead | Lead leaves the parent, appears in the child at Start, activity trail names the trigger |
| TC-8 | Child not ready | Fire a trigger while the child has an invalid playbook | Lead is parked in the Action Center with the reason; parent composes nothing further for that lead |
| TC-9 | Cycle attempt | Set the child as the parent's parent | Rejected with "that would create a loop"; no change stored |
| TC-10 | Unsubscribed lead | Fire a trigger on a lead that unsubscribed a minute earlier | No handoff; lead stays finished as unsubscribed everywhere |
| TC-11 | Deleting a parent | Delete a campaign that has children | Blocked or confirmed explicitly, stating how many children lose their trigger source |

## 4. Frontend user story

**As a** campaign owner, **I want** to see and set up follow-on campaigns from the campaign I am already looking at, **so that** the chain of playbooks is obvious rather than something I have to hold in my head.

**Scope**
- Campaigns → campaign detail: a "Follow-on campaigns" section listing children with their trigger conditions in plain English ("When a lead replies 'not now' → Nurture Q2"), and an action to create one.
- The create dialog asks for a name and one or more triggers chosen from the parent playbook's own edge labels (`reply: interested`, `no reply 3d`, and the built-in intents), so triggers cannot reference something the playbook does not produce.
- The child campaign's detail page shows "Leads arrive from: <parent>" so the relationship reads from both ends.
- Loading, empty ("No follow-on campaigns") and error states designed; a child that is not launch-ready is flagged in the list with the specific reason.
- Accessibility: the trigger picker is a labelled multi-select of real checkboxes; the relationship is described in text, not by a line drawing alone. Responsive: the section becomes a stacked list under 640px.

**Definition of done**
- [ ] Follow-on campaigns are visible and creatable from campaign detail.
- [ ] Triggers are chosen from the parent playbook's real edge labels, never free text.
- [ ] Both parent and child state the relationship.
- [ ] A not-ready child is flagged before any lead can be handed to it.

## 5. Backend user story

**As a** Harry API and engine, **I want** parent-child campaign links with declared triggers, **so that** the engine can move a lead between playbooks deterministically and explain why it did.

**Scope**
- Routes in `server/routes.js`: `POST /api/campaigns/:id/children` taking `{ name, triggers: [] }`, `GET /api/campaigns/:id/children`, and `DELETE /api/campaigns/:id/children/:childId` to unlink without deleting.
- Data model: `parent_campaign_id` on `campaigns` plus a `campaign_triggers` table (`parent_campaign_id`, `child_campaign_id`, `event`) in `server/db.js`. Cycle detection on write.
- `server/engine.js` checks triggers at the same point it classifies a reply or times out a `no reply` edge; a match closes the lead's `campaign_leads` row on the parent and opens one on the child at Start. Terminal outcomes and unsubscribes take precedence and short-circuit the check.
- No pagination needed. Handoffs respect the sending rhythm and approval rule exactly as a fresh lead does.
- Logged: an `events` row per handoff (lead, from campaign, to campaign, triggering event, node it left from); `telemetry` counts handoffs and blocked handoffs by reason so Monitoring shows when children are misconfigured.

**Definition of done**
- [ ] Handoff is atomic — a lead is never live in two campaigns, and never in none.
- [ ] Cycle detection covered by a test.
- [ ] Blocked handoffs land in the Action Center with a reason, verified by an engine test.
- [ ] Every handoff is explainable from the activity trail alone.

## 6. End-to-end test ticket

**Title:** E2E — Hand a lead from one playbook to a follow-on campaign

**Preconditions:** A workspace with a sandbox mailbox, a parent campaign whose playbook has a `reply: not now` edge, a valid child campaign, one lead attached to the parent, approvals on.

**Flow**
1. On the parent's campaign detail, create a follow-on campaign triggered by `reply: not now`.
2. Launch the parent, approve its first draft in Inbox → Needs your OK.
3. Simulate a "not right now, try me in Q3" reply on the sandbox mailbox.
4. Let the engine tick.
5. Open the child campaign and the lead's page.

**Assertions**
- [ ] The lead now shows the child campaign as its live campaign, and the parent as finished for that lead.
- [ ] The activity trail names the trigger and the node the lead left.
- [ ] The child's first email is waiting in Needs your OK — it has not sent.
- [ ] The parent composes nothing further for that lead on subsequent ticks.
- [ ] Unlinking the child leaves both campaigns intact with the lead where it is.

**Teardown:** Delete both campaigns and the lead; clear sandbox messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | "Follow-on campaigns" section and a create dialog | Medium | Hidden entirely when there are none and none have been created; triggers drawn from the playbook the user already wrote |
| Campaigns list | Children shown nested under their parent | Low | Indentation only, no new filter or tab |
| Dashboard Action Center | Blocked handoffs appear as decisions | Low | Reuses the existing parked-lead pattern |

**Verdict:** Fits an existing surface

Harry's differentiator is that branching lives inside one Mermaid diagram, so most of what this endpoint offers is already expressible as an edge. The genuinely new part is chaining *whole* playbooks, which belongs on campaign detail next to the diagram rather than on a page of its own.

**Note on source coverage:** the upstream documentation for this endpoint is thin — `condition_events` is documented only as an array, with no event schema and no example payload. The trigger vocabulary above is therefore derived from Harry's own playbook edge labels rather than mirrored from the source API, and should be confirmed against a live response before build.
