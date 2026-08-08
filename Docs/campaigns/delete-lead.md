# Delete Lead from Campaign

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/delete-lead |
| **Auth** | API key (query param `api_key`) |

Takes one person out of one campaign without deleting them from the workspace.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to pull a specific person out of a campaign, **so that** someone I should not be emailing stops receiving that playbook immediately, while their record and history stay intact.

**Acceptance criteria**
- [ ] Given a lead attached to a campaign, when I remove them, then the campaign link is deleted and I get a clear success response (the source API returns `{"success": true, "message": "Lead deleted from campaign successfully"}`).
- [ ] Given the removal succeeds, when I look at the Leads page, then the person is still there with their details, research profile and score — only the campaign association is gone.
- [ ] Given the lead has a draft waiting in Needs your OK for that campaign, when I remove them, then that draft is withdrawn from the approval queue and cannot be approved afterwards.
- [ ] Given the lead has already been emailed in that campaign, when I remove them, then the sent messages and any replies remain visible in Inbox and on the lead's timeline — removal stops future sends, it does not rewrite the past.
- [ ] Given the engine is mid-tick on that lead, when the removal lands, then no further email is composed or queued for them in that campaign.
- [ ] Given the lead is not in that campaign, when I remove them, then I get a 404 and the UI treats it as already done rather than showing an error.
- [ ] Given the removal happens, when I look at the activity trail, then it records who removed which lead from which campaign, and the playbook node they were sitting on.
- [ ] Given the person should never be contacted again, when I remove them, then the dialog offers "also unsubscribe them" as a separate, explicit choice — removal alone is not a suppression.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | DELETE campaign 123 / lead 789 where the lead is attached | 200, `{"success": true, "message": "Lead deleted from campaign successfully"}`; a follow-up campaign-leads fetch omits the lead |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; the link is untouched |
| TC-3 | Not found / wrong workspace | DELETE using a campaign or lead id from another workspace | 404; nothing removed in either workspace |
| TC-4 | Validation failure | DELETE with a non-numeric lead id | 422 with a field-level message on the lead id |
| TC-5 | Rate limited | Remove 200 leads one by one in a burst | 429 on the excess; client backs off and finishes, final count correct |
| TC-6 | Empty result set | Remove the campaign's last lead | 200; campaign detail shows "No leads attached" and Launch is blocked with that reason |
| TC-7 | Draft awaiting approval | Remove a lead with a draft in Needs your OK | Draft disappears from the queue; approving it afterwards is impossible and returns a clear "no longer available" |
| TC-8 | Already removed | DELETE the same pair twice | Second call 404; the UI says "already removed" rather than raising an error |
| TC-9 | History preserved | Remove a lead with 2 sent emails and 1 reply | Thread still visible in Inbox and on the lead's timeline; the campaign shows the historical counts unchanged |
| TC-10 | Person preserved | Remove a lead in their only campaign | Lead remains on the Leads page at stage "contacted" with no live campaign |
| TC-11 | Race with the engine | Remove a lead in the same second the engine picks it up | Exactly one outcome: either the email was already queued and is withdrawn, or it was never composed; never a send after removal |

## 4. Frontend user story

**As a** campaign owner, **I want** a one-click remove on any lead row inside a campaign, **so that** taking someone out is as quick as noticing they should not be there.

**Scope**
- Campaigns → campaign detail → leads table: a row action "Remove from campaign", plus multi-select for bulk removal with a single confirmation.
- Lead detail: the campaign chip carries the same remove action, so the fix is available wherever the problem is noticed.
- The confirmation is light — one sentence naming the person and campaign — with an optional checkbox "also unsubscribe this person" that is unticked by default and clearly labelled as workspace-wide.
- Loading: optimistic row removal with an undo affordance for a few seconds. Empty: the leads table shows "No leads attached — this campaign cannot launch". Error: the row returns with an inline message.
- Accessibility: the row action has an accessible name including the person's name, not just "Remove"; bulk selection count is announced; undo is keyboard reachable. Responsive: the leads table becomes stacked cards under 640px with the action in the card footer.

**Definition of done**
- [ ] Remove works from the campaign leads table and from lead detail.
- [ ] Bulk remove confirms once and reports the result count.
- [ ] Any pending draft for that lead visibly disappears from Needs your OK.
- [ ] Undo restores the link and the lead's position in the playbook if used within the window.

## 5. Backend user story

**As a** Harry API, **I want** a route that removes one campaign-lead link and cancels its pending work, **so that** removal is immediate and cannot leak a send.

**Scope**
- Route in `server/routes.js`: `DELETE /api/campaigns/:id/leads/:leadId`, workspace-scoped, plus a bulk variant taking an id array.
- Data model: deletes the `campaign_leads` row in `server/db.js`. It does not touch `leads`, `messages`, or the unsubscribe record. Any `drafts` row for that lead and campaign is cancelled in the same transaction.
- Engine safety: the delete takes the same per-lead lock the engine uses in `server/engine.js`, so a tick either sees the lead before removal or not at all — never sends after.
- No pagination. Bulk removal is chunked server-side and reports per-id outcomes so one bad id does not fail the batch. Standard rate limiting; the route is idempotent from the client's view (repeat call returns 404, handled as already done).
- Logged: an `events` row per removal recording actor, lead, campaign, the node the lead was on, and whether a draft was cancelled; `telemetry` counts removals and cancelled drafts.

**Definition of done**
- [ ] Removal cancels any pending draft in the same transaction.
- [ ] A test races removal against an engine tick and asserts no send occurs.
- [ ] Lead record, messages and unsubscribes are provably untouched.
- [ ] Bulk removal returns per-id results.

## 6. End-to-end test ticket

**Title:** E2E — Pull one person out of a running campaign

**Preconditions:** A workspace with a sandbox mailbox, one running campaign, five leads attached; lead A has been emailed once and has replied, lead B has a draft waiting in Needs your OK.

**Flow**
1. Open Campaigns → campaign detail → leads.
2. Remove lead B and confirm.
3. Open Inbox → Needs your OK.
4. Return and remove lead A, leaving the unsubscribe checkbox unticked.
5. Open Leads and then Inbox.
6. Let the engine tick twice.

**Assertions**
- [ ] Lead B's draft is gone from Needs your OK immediately after removal.
- [ ] Lead A's existing thread is still readable in Inbox after removal.
- [ ] Both leads still appear on the Leads page with their stages and research profiles intact.
- [ ] No new email is composed for either lead on the following ticks.
- [ ] The activity trail records both removals with the node each lead was on.
- [ ] Re-importing lead A into the same campaign is allowed, since they were never unsubscribed.

**Teardown:** Delete the campaign; leave the five leads on the Leads page.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail leads table | Row action and bulk remove | Low | One action in the existing row menu; bulk controls appear only after a selection |
| Lead detail | Remove action on the campaign chip | Low | Attached to an element already on the page |
| Inbox → Needs your OK | Withdrawn drafts vanish | Low | Same behaviour as an approved or declined draft; no new state to learn |

**Verdict:** Fits an existing surface

The campaign's leads table already exists, and this is the row action people expect to find there. The only judgement call is separating "remove from this campaign" from "never contact again"; keeping them as two distinct choices is what stops a routine tidy-up from silently suppressing someone forever.
