# Unsubscribe Lead Globally

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/leads/{id}/unsubscribe` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/unsubscribe |
| **Auth** | API key (query param `api_key`) |

Marks a person as unsubscribed everywhere, so no campaign in the account emails them again.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to unsubscribe a person from everything in one action, **so that** when someone asks to be left alone by any route — a reply, a phone call, a forwarded complaint — I can honour it immediately and completely.

**Acceptance criteria**
- [ ] Given a lead, when I unsubscribe them, then the unsubscribed flag is set on the person record, not on one campaign link, and it applies to every current and future campaign.
- [ ] Given the lead is unsubscribed, when the engine ticks, then nothing is scheduled or sent to them anywhere, and their derived stage reads "unsubscribed" in every list.
- [ ] Given the lead has drafts waiting in Needs your OK, when they are unsubscribed, then those drafts are cancelled and cannot be approved.
- [ ] Given the lead stays attached to campaigns, when I look at those campaigns, then the person is still listed with a suppression marker rather than vanishing, so the record of who was in the list survives.
- [ ] Given the lead's address is later re-imported, when the import runs, then the row is skipped with reason "unsubscribed", and no setting anywhere in Harry can override it.
- [ ] Given the same lead is unsubscribed twice, when the second call runs, then it reports that nothing changed rather than failing, and only one activity trail entry exists.
- [ ] Given the unsubscribe came from a recipient clicking the footer link or the List-Unsubscribe header, when it lands, then it produces exactly the same state as a human doing it from the Leads page — one code path, not two.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Unsubscribe a lead enrolled in two campaigns | 200 with a success result; the person's unsubscribed flag is true and both campaigns show the suppression marker |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the lead is not unsubscribed and the control reverts |
| TC-3 | Not found / wrong workspace | Unsubscribe a lead id belonging to another workspace | 404 with a lead-not-found error; nothing changes in either workspace |
| TC-4 | Validation failure | Unsubscribe with a non-numeric lead id | 422 naming the id parameter |
| TC-5 | Rate limited | Unsubscribe 100 leads from a bulk selection | 429 on some calls; the bulk action backs off and completes with the correct final count |
| TC-6 | Empty result set | Bulk unsubscribe with nothing selected | 200 with zero changes; the action is disabled in the UI |
| TC-7 | Already unsubscribed | Unsubscribe the same lead twice | Second call reports no change; a single activity trail entry remains |
| TC-8 | Drafts cancelled | Unsubscribe a lead with an email waiting in Needs your OK | The draft disappears from the queue and cannot be approved |
| TC-9 | Re-import blocked | Unsubscribe, then re-import the address by CSV | The row is skipped with reason "unsubscribed"; no UI toggle exists to force it |
| TC-10 | Recipient-initiated | Click the unsubscribe footer link in a sent email | The same state results, the activity trail records the recipient as the actor, and the campaign follows the playbook's Unsubscribed terminal node |
| TC-11 | Reports integrity | Unsubscribe a lead who had received two emails | The campaign's unsubscribe rate in Reports rises and the sent count is unchanged |
| TC-12 | Reversal | Attempt to undo an unsubscribe from the UI | No UI path exists; the only recorded reversal is a documented support action leaving an activity trail entry |

## 4. Frontend user story

**As a** campaign owner, **I want** unsubscribing to be obvious, one click, and clearly permanent, **so that** honouring a request is never slower than ignoring it.

**Scope**
- Leads and Leads → lead detail: an "Unsubscribe everywhere" action, with a confirmation that states plainly that it applies to all campaigns and cannot be undone from the interface.
- Inbox → thread: the same action in the thread header, since most requests arrive as a reply; the classifier's `unsubscribe` intent already flags these threads, so the action sits right where the flag appears.
- Leads stage strip: the existing "unsubscribed" stage is the filter for these people; no new counter is added.
- Loading: optimistic with rollback. Empty: the existing empty state. Error: the reason inline.
- Accessibility: the confirmation traps focus, the destructive button is not the default focus, and the suppression marker is text plus an icon, never colour alone. Responsive: the confirmation is full-width under 640px.

**Definition of done**
- [ ] The action is reachable from Leads, lead detail and the Inbox thread.
- [ ] The confirmation states the scope (all campaigns) and the permanence.
- [ ] Unsubscribed people remain visible in campaign lists with a suppression marker.
- [ ] No control anywhere offers to email an unsubscribed person.

## 5. Backend user story

**As a** Harry API, **I want** one suppression record that every send path checks, **so that** an unsubscribe cannot be defeated by any route into the mailer.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:id/unsubscribe`, workspace-scoped and idempotent, returning whether anything changed.
- Data model: an `unsubscribed_at`, `unsubscribed_by` and `unsubscribed_source` on `leads` in `server/db.js`, plus a workspace suppression list keyed on the lowercased address so the suppression survives the person record being deleted.
- Enforcement in three places: the importer skips suppressed addresses, `server/engine.js` skips suppressed leads and routes them to the playbook's Unsubscribed terminal node, and `server/mailer.js` refuses to send to a suppressed address as the last line of defence. Pending drafts are cancelled in the same transaction.
- The public unsubscribe page and the List-Unsubscribe header handler call this same function, so recipient-initiated and human-initiated unsubscribes cannot diverge.
- Logged: an `events` row naming the actor (a user, or the recipient via the public page) and the source; `telemetry` counts unsubscribes per campaign so Monitoring can grade the rate against cold-outreach benchmarks.

**Definition of done**
- [ ] One suppression check function, called by importer, engine and mailer, covered by a test for each.
- [ ] The suppression survives deletion of the person record, covered by a delete-then-reimport test.
- [ ] The public unsubscribe page and this route produce identical state, covered by a test.
- [ ] Repeat calls report no change and leave a single trail entry.

## 6. End-to-end test ticket

**Title:** E2E — Unsubscribe a lead by hand and confirm it holds everywhere

**Preconditions:** A workspace with one sandbox mailbox, two campaigns, one lead attached to both with a draft waiting for approval in one, and a CSV containing that lead's address.

**Flow**
1. Inbox → open the lead's thread → Unsubscribe everywhere → confirm.
2. Inbox → Needs your OK.
3. Leads → filter the stage strip to "unsubscribed".
4. Campaigns → open both campaigns and find the lead.
5. Let the engine tick with the sandbox clock advanced past the next edge.
6. Import the CSV into a third campaign.
7. Reports → read the unsubscribe rate.

**Assertions**
- [ ] The waiting draft is gone from Needs your OK and cannot be approved.
- [ ] The stage strip shows the lead under "unsubscribed" and the count increments.
- [ ] Both campaigns still list the person, marked as suppressed, with no email action available.
- [ ] After the tick, the sandbox mailbox records no send to that address, in either campaign.
- [ ] The CSV import skips the row with reason "unsubscribed".
- [ ] Reports shows the campaign's unsubscribe rate rise, with the sent count unchanged.

**Teardown:** Delete the campaigns; leave the suppression entry in place and note it in the test fixture, since it is intentionally not reversible from the interface.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads / lead detail | "Unsubscribe everywhere" action | Low | Joins the existing row menu; the stage strip already has an unsubscribed bucket |
| Inbox → thread | Same action in the thread header | Low | Sits beside the classifier's existing unsubscribe intent chip |
| Campaigns → campaign detail | Suppression marker on the lead row | Low | A text badge, no layout change |
| Reports | No change | Low | The unsubscribe rate is already reported |

**Verdict:** Fits an existing surface

Harry already honours unsubscribes end to end — a footer link, a List-Unsubscribe header, a public page that finishes the lead everywhere, and an `unsubscribe` intent the classifier always respects even without a playbook edge. What is missing is a human-initiated version for requests that arrive by phone or forwarded complaint, and it should call the same code the public page does rather than becoming a second path.
