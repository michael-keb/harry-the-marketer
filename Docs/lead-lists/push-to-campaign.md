# Push Leads to Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/leads/push-to-campaign` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/push-to-campaign |
| **Auth** | API key (query param `api_key`) |

Sends a whole saved group, a chosen set of people, or everyone in the account into a campaign, either keeping them in the source or taking them out of it.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to point a saved segment at a campaign in one action, **so that** the group I built once becomes the audience for a playbook without me re-selecting anyone.

**Acceptance criteria**
- [ ] Given `campaignId` and `leadList.listId: 500` with `action: "copy"`, when I push, then a 200 returns `total_leads`, `pushed` and `duplicates`, every pushed lead is attached to the campaign, and the segment still holds them all.
- [ ] Given `action: "move"`, when I push, then the leads are attached to the campaign and removed from the source segment, and the confirmation says so before I commit.
- [ ] Given `leadList.leadIds` (1-10,000 entries) instead of `listId`, when I push, then only those leads are attached; supplying `listId`, `leadIds` and `allLeads` together is rejected as ambiguous.
- [ ] Given `leadList.allLeads: true`, when I push, then every lead in the workspace is considered, and the confirmation states the full count before anything is written, because this is the one option a user can fire by accident.
- [ ] Given a lead already attached to that campaign, when I push it again, then it is counted in `duplicates` and not attached twice — the campaign's per-lead playbook state is not reset.
- [ ] Given the source API's `campaignName` behaviour of creating a campaign that does not exist, when a name is supplied in Harry, then no campaign is silently created — the user picks an existing campaign or is taken to the campaign editor, because a campaign without a valid playbook cannot launch anyway.
- [ ] Given an unsubscribed or hard-bounced lead in the selection, when I push, then it is excluded and the reason is shown; no request field can override this.
- [ ] Given leads are pushed to a running campaign, when the engine next ticks, then each enters at the playbook's Start node and its first email still parks in Inbox → Needs your OK — nothing sends without an approval.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"campaignId":12345,"action":"copy","leadList":{"listId":500}}` | 200 with `data: {total_leads: 1250, pushed: 1200, duplicates: 50}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; campaign and segment unchanged |
| TC-3 | Campaign not found / wrong workspace | Push to another workspace's `campaignId` | 404; no lead attached anywhere |
| TC-4 | Validation failure — no target | POST with neither `campaignId` nor `campaignName` | 422 stating a campaign must be chosen |
| TC-5 | Rate limited | Push 20,000 leads across chunked calls | 429 on some chunks; the client backs off and resumes, `pushed` totals are exact with no duplicate attachments |
| TC-6 | Empty result set | Push from a segment holding zero leads | 200 with `pushed: 0`; "Nothing to push" message, campaign untouched |
| TC-7 | Move semantics | POST TC-1 with `action: "move"` | 200; the leads are on the campaign and the segment count drops to 0 |
| TC-8 | Ambiguous selection | POST `leadList` with `listId`, `leadIds` and `allLeads: true` | 422 stating exactly one selection method is allowed |
| TC-9 | All leads | POST `{"campaignId":12345,"action":"copy","leadList":{"allLeads":true}}` | 200; the confirmation stated the full workspace count beforehand |
| TC-10 | Unsubscribed lead | Include a previously unsubscribed address | Excluded with the reason "unsubscribed"; no UI or request field can force it in |
| TC-11 | Re-push | Run TC-1 twice | Second run reports `pushed: 0`, `duplicates: 1250`; no lead's playbook position is reset |
| TC-12 | Campaign not launchable | Push to a campaign whose playbook fails validation | 200 for the attachment, but the campaign still refuses to launch and says why — attaching leads never bypasses playbook validation |
| TC-13 | Approval rule | Push to a running campaign, let the engine tick | Drafts appear in Needs your OK; zero emails leave the mailbox without approval |

## 4. Frontend user story

**As a** campaign owner, **I want** "Push to campaign" on a segment and "Attach a segment" in the campaign, **so that** the two ways I might think about it lead to the same place.

**Scope**
- Leads page → Segments panel overflow: "Push to campaign", opening a picker of the workspace's campaigns with a copy/move toggle and the count stated in the button ("Push 1,250 leads").
- Campaigns → campaign detail → Attach leads: a third source alongside the existing "choose from leads" and "upload CSV" — "from a segment", listing segments with their counts.
- A pre-push summary reusing the campaign import summary: how many will be attached, how many are already in this campaign, how many are excluded and why (unsubscribed, bounced, invalid).
- The "all leads in the workspace" option is available but is never the default and always shows the full count in the confirm button, because it is the one selection a user can trigger without meaning to.
- States: chunk progress for large pushes with `aria-live="polite"`; success links straight to Inbox → Needs your OK so the standing approval rule is visible immediately; failure leaves the campaign untouched.
- Accessibility: copy/move is a labelled radio group; exclusion reasons are text, not colour. Responsive: the picker is a bottom sheet under 640px.

**Definition of done**
- [ ] Both entry points reach the same summary and the same request.
- [ ] Exclusions are always shown by reason and count before confirming.
- [ ] The success state points at the approval queue, not at a "sent" message.
- [ ] Selecting all leads in the workspace always states the full count in the confirm button.

## 5. Backend user story

**As a** Harry API, **I want** a route that attaches a segment's leads to a campaign transactionally with suppression checks, **so that** a one-click push can never violate an unsubscribe or reset a lead's position in a running playbook.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/attach-segment` taking `{ action, selection: { listId | leadIds | allLeads } }`, workspace-scoped, reusing the existing campaign lead-attachment handler so dedupe and suppression logic is shared, not duplicated.
- Data model: writes `campaign_leads` with its unique `(campaign_id, lead_id)` constraint, making the push idempotent and leaving an existing lead's playbook state untouched; a move additionally deletes the `lead_list_leads` rows in the same transaction. Campaign creation by name is deliberately not implemented.
- Suppression before insert: unsubscribed and hard-bounced addresses are excluded server-side with machine-readable reasons; there is no override field, matching the campaign importer.
- Chunked at 400 per transaction with the same `provided_count` / `max_allowed` shape as the existing importer, and `leadIds` bounded at 10,000 per call. Standard rate limiting; the client retries 429 with backoff.
- Logged: one `events` row per push (actor, campaign, source segment, action, pushed, duplicates, exclusions by reason); `telemetry` records batch duration so Monitoring can show push throughput.

**Definition of done**
- [ ] Re-pushing the same segment attaches zero leads and resets nobody's playbook position.
- [ ] Unsubscribed and hard-bounced leads are refused by every path.
- [ ] Attaching leads never bypasses playbook validation or the launch preconditions.
- [ ] Tests cover copy, move, the ambiguous-selection rejection, re-push idempotency and cross-workspace 404.

## 6. End-to-end test ticket

**Title:** E2E — Push a saved segment at a campaign and approve the first email

**Preconditions:** A workspace with a sandbox mailbox, a campaign with a valid playbook and no leads, and a segment "Q1 2025 Enterprise Prospects" holding 40 leads of which 1 is unsubscribed and 2 are already in that campaign.

**Flow**
1. Open Leads → Segments → overflow → Push to campaign.
2. Pick the campaign, choose Copy, review the summary.
3. Confirm.
4. Launch the campaign and let the engine tick.
5. Open Inbox → Needs your OK and approve one draft.

**Assertions**
- [ ] The summary predicts 37 attached, 2 already present, 1 excluded as unsubscribed, before anything is written.
- [ ] After confirming, the campaign shows 39 leads and the segment still holds 40 (Copy).
- [ ] The unsubscribed lead is nowhere in the campaign.
- [ ] The two pre-existing leads keep their original playbook positions.
- [ ] Drafts appear in Needs your OK; the sandbox mailbox records zero sends before approval.
- [ ] After approving one, exactly one send is recorded and the queue names the recipient and rough time.
- [ ] Re-running the push attaches 0 and reports 39 duplicates.

**Teardown:** Detach the leads from the campaign and delete the campaign.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Segments panel | "Push to campaign" in the overflow menu | Low | One item in an existing menu |
| Campaigns → campaign detail | "From a segment" as a third source in Attach leads | Medium | It slots into the existing two-source flow and ends in the same pre-import summary |
| Pre-push summary | Attached / already present / excluded breakdown | Low | Reuses the campaign import summary component verbatim |
| Inbox → Needs your OK | More drafts after a large push | Medium | Unchanged behaviour; the success state links here so the volume is expected rather than a surprise |

**Verdict:** Fits an existing surface

This is the endpoint that makes segments worth having, and it lands on two pages that already exist — the segment's menu and the campaign's Attach leads flow — with no new navigation. The honest risk is not visual bloat but volume: pushing a thousand-lead segment fills the approval queue, so the success state has to send the user straight there rather than congratulating them.
