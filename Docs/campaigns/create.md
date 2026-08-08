# Create Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/create` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/create |
| **Auth** | API key (query param `api_key`) |

Creates an empty campaign in draft state and hands back its id so everything else can be attached to it.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to create a campaign in one step and get its id straight back, **so that** I can start drawing its playbook immediately instead of filling in a form first.

**Acceptance criteria**
- [ ] Given I create a campaign with a name, when it succeeds, then I get back its id, the name and a creation timestamp — the source API's `ok`, `id`, `name`, `created_at` — and the campaign is in draft state.
- [ ] Given I create a campaign without a name, when it succeeds, then it is named with a sensible default (the source API uses "Untitled Campaign") and is immediately renameable from the campaign detail page.
- [ ] Given a new campaign, when I look at it, then it has no playbook, no mailbox, no leads and no schedule — creation deliberately accepts only the name, and everything else is a separate, later step.
- [ ] Given a new campaign, when I try to launch it, then launch is blocked by the existing rule: the playbook must be valid, a mailbox must be attached, and leads must be attached.
- [ ] Given I create a campaign from a Goal, when it is created, then it is linked to that goal so the goal's ICP and target flow into playbook generation and lead scoring.
- [ ] Given a name that is empty, whitespace only, or longer than the allowed length, when I submit it, then I get a field-level validation message and no campaign is created.
- [ ] Given creation succeeds, when I look at the activity trail, then it records who created the campaign and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"name": "Q1 2024 Cold Outreach"}` | 200 with `ok: true`, a numeric `id`, the echoed `name`, and an ISO 8601 `created_at`; status is draft |
| TC-2 | Missing/invalid API key | POST unauthenticated | 401, `{"message": "Invalid API Key"}`; UI sends the user to sign-in and keeps the typed name |
| TC-3 | Not found / wrong workspace | Create with a goal id belonging to another workspace | 404; no campaign created, no orphan link |
| TC-4 | Validation failure | POST `{"name": ""}` | 422, `{"error": "Invalid campaign name format"}` surfaced against the name field |
| TC-5 | Rate limited | Create 50 campaigns in a burst | 429 on the excess; the client retries once with backoff and never creates a duplicate |
| TC-6 | Empty body | POST `{}` | 200 with the default name applied; the campaign appears on Campaigns as "Untitled campaign" with an inline rename affordance |
| TC-7 | Server error | Force a database failure during creation | 500 with a plain-English message; UI says "Could not create the campaign — try again", nothing half-written |
| TC-8 | Duplicate names | Create two campaigns with the same name | Both succeed with different ids; the list disambiguates by creation date, since names are not unique |
| TC-9 | Launch a bare campaign | Create, then immediately press Launch | Blocked with the three specific reasons listed (no playbook, no mailbox, no leads) rather than a generic error |
| TC-10 | Created from a goal | Create from Goals with Autopilot off | Campaign is linked to the goal, still in draft, no email composed |

## 4. Frontend user story

**As a** campaign owner, **I want** creating a campaign to drop me straight into the playbook editor, **so that** the first thing I do is draw the campaign rather than answer questions about it.

**Scope**
- Campaigns: a "New campaign" action that asks only for a name (optional) and then navigates to campaign detail with the Mermaid editor open and a starter diagram in place.
- Campaign detail shows a readiness strip listing what is still missing — playbook, mailbox, leads — each item linking to the step that fixes it; the Launch button stays disabled until all three are done.
- Goals: "Create campaign" on a goal pre-links the new campaign and pre-fills the playbook brief from the goal's ICP.
- Loading: the create action is optimistic with a disabled button; empty: a brand-new campaign shows the starter diagram, not a blank canvas; error: the dialog stays open with the name preserved and the message inline.
- Accessibility: the name field has a real label and describes that it is optional; the readiness strip is a list, and disabled Launch carries an accessible explanation of why. Responsive: the readiness strip wraps to stacked rows under 640px.

**Definition of done**
- [ ] Creating a campaign takes one action and lands in the editor.
- [ ] The readiness strip reflects live state and its three items each link to the fix.
- [ ] Renaming works inline on campaign detail without a separate settings screen.
- [ ] Create from a Goal links the two and shows the link on both pages.

## 5. Backend user story

**As a** Harry API, **I want** a create route that returns the new campaign id immediately, **so that** the client can navigate to the editor before anything else is configured.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns` taking `{ name?, goalId? }` and returning `{ id, name, status, createdAt }`, workspace-scoped like its neighbours.
- Data model: uses the existing `campaigns` table in `server/db.js`. Name defaults server-side when absent or blank; status defaults to `draft`; `goal_id` is validated against the caller's workspace before it is stored.
- Validation: name trimmed, length-capped, rejected when it is only whitespace. Creation is a single insert, so there is no partial state to roll back.
- No pagination concerns. Standard app rate limiting applies; a repeated submit within a short window with the same name returns the existing campaign rather than a second one, so a double-click cannot create twins.
- Logged: an `events` row for campaign creation with actor, id and source (manual, goal, duplicate); `telemetry` counts creations per day for Monitoring.

**Definition of done**
- [ ] Route returns the id in a single round trip with no side configuration.
- [ ] Default naming, trimming and length caps are covered by tests.
- [ ] Cross-workspace `goalId` returns 404 and creates nothing.
- [ ] Double-submit protection is tested.

## 6. End-to-end test ticket

**Title:** E2E — Create a campaign and take it from draft to ready

**Preconditions:** A signed-in workspace with one sandbox mailbox connected and at least three leads on the Leads page.

**Flow**
1. Open Campaigns and choose New campaign.
2. Leave the name blank and confirm.
3. Rename it inline to "Q1 Cold Outreach".
4. Edit the starter Mermaid playbook so it validates.
5. Attach the sandbox mailbox and three leads from the readiness strip.
6. Press Launch.

**Assertions**
- [ ] The campaign appears immediately with the default name and the editor open.
- [ ] The readiness strip starts with all three items outstanding and clears one by one.
- [ ] Launch is disabled with an explanation until the last item clears.
- [ ] After launch, drafts appear in Inbox → Needs your OK and nothing has been sent.
- [ ] The activity trail shows the creation, the rename and the launch, each with an actor.

**Teardown:** Delete the campaign and detach the leads; leave the sandbox mailbox connected.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns | "New campaign" action and a one-field dialog | Low | One field, and it is optional; no wizard |
| Campaign detail | Readiness strip showing what is still missing | Medium | Replaces guesswork before Launch; disappears entirely once the campaign is running |
| Goals | "Create campaign" links a new campaign to the goal | Low | Uses the existing goal action row |

**Verdict:** Fits an existing surface

Campaigns already exist as a page with a create action; this endpoint's real contribution is the idea that creation is minimal and everything else follows. The readiness strip is the only visible addition, and it removes a question users otherwise have to answer by trial and error.
