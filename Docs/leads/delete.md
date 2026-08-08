# Delete Lead from Campaign

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/delete |
| **Auth** | API key (query param `api_key`) |

Removes a person from one campaign, and deletes them from the account entirely if that was the only campaign they were in.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to take a person out of a campaign and be told plainly whether that also erases them, **so that** I can correct a bad import without accidentally destroying history I need.

**Acceptance criteria**
- [ ] Given a lead attached to a campaign, when I remove it, then the campaign link goes, any pending draft for that lead in that campaign is cancelled, and the engine no longer schedules anything for it.
- [ ] Given the lead is in other campaigns, when I remove it from this one, then the person record survives with its research profile, notes and message history intact, and the confirmation says exactly that.
- [ ] Given this was the lead's only campaign, when I remove it, then the confirmation warns that the person will be deleted outright and the action cannot be undone, and asks for a second, explicit confirmation.
- [ ] Given a lead has already been emailed, when I remove it, then the sent messages remain attributable in Reports and the activity trail, so historical rates do not silently change.
- [ ] Given a lead has unsubscribed, when the person record would be deleted, then the suppression entry survives the deletion, so re-importing that address is still refused.
- [ ] Given a campaign id from another workspace, when I call the removal, then it returns not found and nothing is deleted.
- [ ] Given the removal succeeds, when I look at the activity trail, then there is one entry naming who removed whom, from which campaign, and whether the person record was deleted.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path — lead in two campaigns | Remove the lead from campaign A | 200 with an ok result; the lead still appears on Leads and still shows campaign B |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; nothing is removed and the row stays on screen |
| TC-3 | Campaign not found / wrong workspace | Remove using another workspace's campaign id | 404 with a campaign-not-found error; no rows touched in either workspace |
| TC-4 | Validation failure | Remove using a non-numeric lead id | 422 with a message naming the id parameter |
| TC-5 | Rate limited | Remove 200 leads in quick succession | 429 on some calls; the bulk action backs off and finishes, with the final count matching the selection |
| TC-6 | Empty result set | Bulk-remove with nothing selected | 200 with zero removals; the button is disabled in the UI so this is unreachable by hand |
| TC-7 | Last campaign — person deleted | Remove a lead that is only in this campaign | Second confirmation required; afterwards the person is gone from Leads entirely |
| TC-8 | Unsubscribed lead deleted | Remove an unsubscribed lead that is only in this campaign | Person is deleted but re-importing the same address is still skipped as unsubscribed |
| TC-9 | Lead with a pending draft | Remove a lead whose email is sitting in Needs your OK | The draft disappears from the approval queue and cannot be approved afterwards |
| TC-10 | Idempotency | Remove the same lead twice | Second call returns not found; the UI treats it as already done rather than showing an error |
| TC-11 | Reports integrity | Remove a lead that had received two emails | Reports' sent count for the campaign is unchanged |

## 4. Frontend user story

**As a** campaign owner, **I want** removal to tell me the consequence before I confirm it, **so that** "take this person off this campaign" never quietly means "erase this person".

**Scope**
- Campaigns → campaign detail → the attached leads list: a "Remove from campaign" row action and a bulk action on multi-select.
- The confirmation dialog changes wording based on the real consequence: "Removes them from this campaign; they stay in 2 others" versus "This is their only campaign — the person will be deleted permanently".
- Leads → lead detail: the campaign memberships block shows a remove control per campaign, and a separate, clearly labelled "Delete this person" action.
- Loading: the row is disabled with a spinner during the call. Empty: the campaign's lead list shows its existing empty state when the last lead goes. Error: the row is restored and the reason shown inline.
- Accessibility: the dialog traps focus, the destructive button is not the default focus, and the consequence sentence is read out by screen readers before the buttons. Responsive: the dialog is full-width under 640px.

**Definition of done**
- [ ] The dialog states the actual consequence, computed from the lead's real campaign count.
- [ ] Permanent deletion always needs a second confirmation.
- [ ] Bulk removal shows progress and a per-lead result, not a single silent success.
- [ ] Cancelled drafts are visibly gone from Needs your OK.

## 5. Backend user story

**As a** Harry API, **I want** removal to be transactional and to cascade correctly, **so that** a removed lead leaves no orphaned drafts or schedules but does leave its unsubscribe suppression behind.

**Scope**
- Route in `server/routes.js`: `DELETE /api/campaigns/:campaignId/leads/:leadId`, workspace-scoped, plus `DELETE /api/leads/:id` for the explicit person deletion.
- Data model: deletes the `campaign_leads` row; deletes the `leads` row only when no other `campaign_leads` rows remain. Pending rows in `drafts` for that campaign and lead are cancelled in the same transaction. The unsubscribe suppression is stored independently of the person record so it survives.
- Sent `messages` are retained and de-referenced rather than deleted, so campaign rates in Reports do not move.
- No pagination; bulk removal is a client-side loop with backoff on 429.
- Logged: an `events` row per removal (actor, lead, campaign, whether the person was deleted); `telemetry` only if the cascade is unusually slow.

**Definition of done**
- [ ] Cascade is covered by a test with a lead in one campaign and a lead in two.
- [ ] Cancelled drafts cannot be approved after removal, covered by a test.
- [ ] Unsubscribe suppression survives person deletion, covered by a re-import test.
- [ ] Cross-workspace removal returns 404 and changes nothing.

## 6. End-to-end test ticket

**Title:** E2E — Remove a lead from one campaign and delete another entirely

**Preconditions:** A workspace with two campaigns, a lead attached to both, a second lead attached only to campaign A with a draft waiting for approval, and a third lead who has unsubscribed and is only in campaign A.

**Flow**
1. Campaigns → campaign A → attached leads → remove the shared lead.
2. Read the confirmation wording, then confirm.
3. Remove the second lead; read the different wording and confirm twice.
4. Open Inbox → Needs your OK.
5. Remove the unsubscribed lead, confirming the permanent deletion.
6. Re-import the unsubscribed address via the CSV importer.
7. Open the Dashboard activity trail.

**Assertions**
- [ ] The first dialog says the person stays because they are in another campaign; the lead still appears on Leads afterwards.
- [ ] The second dialog warns of permanent deletion and requires a second confirmation.
- [ ] The second lead's draft is gone from Needs your OK and cannot be approved.
- [ ] The re-imported unsubscribed address is skipped with reason "unsubscribed".
- [ ] The activity trail has one entry per removal naming the actor and whether the person was deleted.

**Teardown:** Delete both campaigns; clear the suppression entry used by the test.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | Remove row action and bulk remove | Low | Sits in the existing row menu with the other lead actions |
| Leads → lead detail | Per-campaign remove plus a separate delete-person action | Medium | The two are visually separated and worded differently so they cannot be confused |
| Inbox → Needs your OK | Cancelled drafts disappear | Low | No new control; the queue simply shrinks |
| Dashboard activity trail | One entry per removal | Low | Bulk removals summarise into one entry |

**Verdict:** Fits an existing surface

Harry's Leads page already has delete; what this adds is the honest distinction between leaving a campaign and ceasing to exist, which today is a single button with one meaning. The whole cost is dialog wording computed from the lead's real campaign count, and no new navigation.
