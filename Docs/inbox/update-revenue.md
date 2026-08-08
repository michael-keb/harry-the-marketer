# Update Lead Revenue

| | |
|---|---|
| **Endpoint** | `PATCH https://server.smartlead.ai/api/v1/master-inbox/update-revenue` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/update-revenue |
| **Auth** | API key (query param `api_key`) |

Records what a lead turned out to be worth, so campaign results can be measured in money rather than only in replies.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** campaign owner who has just won a deal, **I want** to record its value against the lead from the thread, **so that** the goal's progress reflects money won and not just meetings booked.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`) and a non-negative `revenue` amount, when I save it, then the response confirms the amount and an `updated_at` timestamp.
- [ ] Given a negative amount, when I submit, then I get 422 with `field: "revenue"` and the value provided echoed back, and nothing is stored.
- [ ] Given a lead-campaign pairing from another workspace, when I submit, then I get 404 and nothing is stored.
- [ ] Given the currency comes from workspace settings rather than the request, when an amount renders, then it is shown with that currency and never with an assumed symbol.
- [ ] Given a revenue amount is recorded on a lead that has not reached a Won outcome, when it is saved, then it is accepted but clearly marked as recorded against a lead that is not yet won, so nothing is quietly counted as revenue that has not happened.
- [ ] Given a goal whose target is expressed in revenue, when an amount is recorded on a lead attached to that goal, then goal progress moves by that amount and the goal states which leads contributed.
- [ ] Given the amount is edited or cleared, when it completes, then the change is recorded with the actor and the previous value, because a revenue figure is the kind of number people ask questions about later.
- [ ] Given several leads at the same company, when revenue is recorded on one, then it is not duplicated onto the others — the amount belongs to the lead-campaign pairing.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PATCH `{"email_lead_map_id": 2433664091, "revenue": 50000}` | 200, `success: true`, `data.revenue: 50000`, `data.updated_at` present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the typed amount is preserved |
| TC-3 | Not found / wrong workspace | PATCH with an id from another workspace | 404; nothing stored |
| TC-4 | Validation failure — negative | PATCH `revenue: -1000` | 422, `{"error": "revenue must be non-negative", "field": "revenue", "provided_value": -1000}`; the input is flagged |
| TC-5 | Rate limited | Update revenue on many leads in a burst | 429 on the excess; the client backs off with jitter; no amount is written twice |
| TC-6 | Empty result set | Open the revenue field on a lead with none recorded | The field is empty with a placeholder, not zero, so "not recorded" and "zero" are distinguishable |
| TC-7 | Zero is meaningful | PATCH `revenue: 0` | 200; the lead shows a recorded value of zero, distinct from not recorded |
| TC-8 | Currency from settings | Record an amount with the workspace currency set to AUD | The amount renders as AUD everywhere it appears, including Reports and goal progress |
| TC-9 | Not-yet-won lead | Record revenue on a lead at "interested" | Accepted, but marked as pending and excluded from won-revenue totals until the lead reaches a Won outcome |
| TC-10 | Goal progress | Record revenue on a lead attached to a revenue-target goal | The goal's progress increases by that amount and lists the lead as a contributor |
| TC-11 | Edit and audit | Change a recorded amount from 50000 to 40000 | 200; the activity trail records the actor, the previous value and the new one |
| TC-12 | Precision | Record a fractional amount such as 1234.56 | Stored and displayed without rounding drift; totals in Reports match the sum of the parts |

## 4. Frontend user story

**As a** campaign owner, **I want** a revenue field on the lead wherever I am when the deal closes, **so that** recording it takes seconds and the numbers stay honest.

**Scope**
- Inbox → Replies thread view: a revenue field in the lead summary beside the stage, editable inline, showing the workspace currency and a clear "not recorded" placeholder.
- Leads → lead detail: the same field, plus the recorded value on the Leads list as an optional column.
- Goals: a revenue-target goal shows progress from recorded amounts with the contributing leads listed, extending the existing "progress measured from real won outcomes" behaviour rather than replacing it.
- Reports: a revenue column beside the existing per-campaign rates, with won revenue and pending revenue separated so nothing unearned is presented as earned.
- Loading: the field shows its previous value while saving. Empty: placeholder, not zero. Error: inline message under the field keeping the typed amount.
- Accessibility: the field is a labelled numeric input with the currency in its accessible name; pending versus won is text, not colour alone; totals are announced when they change. Responsive: the field sits under the stage on narrow screens.

**Definition of done**
- [ ] Revenue can be recorded, edited and cleared from the thread and the lead record.
- [ ] Not recorded, zero and pending are visually and textually distinct.
- [ ] Goal progress and Reports both read the same stored amounts.
- [ ] Loading, empty, validation-error and pending states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** revenue stored per lead-campaign pairing with an audit trail, **so that** goal progress and campaign ROI rest on a number someone can defend.

**Scope**
- Route in `server/routes.js`: `PATCH /api/campaign-leads/:id/revenue` taking `{ amount }` where amount is non-negative or null to clear. Workspace-scoped, 404 outside the workspace.
- Data model: `revenue_amount` (stored as integer minor units to avoid floating-point drift) and `revenue_updated_by` / `revenue_updated_at` on `campaign_leads` in `server/db.js`; workspace currency lives in settings, not on the row, so it cannot vary per lead.
- Won revenue is derived by joining the amount with the lead's stage, which is itself derived rather than stored — so a lead that later moves out of Won stops counting toward won revenue automatically, with no cleanup job.
- Goals: `server/routes.js` goal progress reads recorded amounts for attached leads, extending the existing outcome-based progress rather than introducing a second definition of "progress".
- Validation: reject negatives with the documented field and provided-value shape; accept zero as a real value distinct from null. Standard rate limiter; 429 retried by the client with backoff and jitter.
- Logged: an `events` row per revenue change with actor, previous and new value; `telemetry` records the proportion of Won leads with no revenue recorded so Monitoring can show how complete the data is.

**Definition of done**
- [ ] Column, route and audit fields exist, covered by tests including cross-workspace 404 and negative rejection.
- [ ] A test asserts amounts are stored in minor units and that totals sum exactly.
- [ ] A test asserts won revenue follows the derived stage, including when a lead moves out of Won.
- [ ] Revenue changes appear in the activity trail with the previous value.

## 6. End-to-end test ticket

**Title:** E2E — Record a closed deal and see the goal move

**Preconditions:** A workspace with the currency set to AUD, a sandbox mailbox, a revenue-target goal ("Generate $200k in new business"), one campaign attached to that goal, one lead who has signed the agreement and reached a Won outcome, one lead at "interested".

**Flow**
1. Open Inbox → Replies and open the Won lead's thread.
2. Record 50000 in the revenue field and save.
3. Open Goals and read the goal's progress.
4. Open the "interested" lead's thread and record 20000.
5. Return to Goals and to Reports.
6. Edit the Won lead's amount to 40000.

**Assertions**
- [ ] Both amounts render in AUD, taken from workspace settings.
- [ ] Goal progress increased by the Won lead's amount only; the "interested" lead's amount is shown as pending and excluded from won revenue.
- [ ] The goal lists the Won lead as a contributor.
- [ ] Reports shows won and pending revenue separately, and the totals match the sum of the recorded amounts exactly.
- [ ] After the edit, the goal reflects 40000 and the activity trail shows the actor with both the previous and the new value.

**Teardown:** Clear both amounts, delete the campaign, lead and goal; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | Revenue field in the lead summary | Low | One inline field beside the stage that already renders there |
| Leads | Revenue on the detail and an optional list column | Low | Column is off by default so the list does not widen for workspaces that never track revenue |
| Goals | Revenue-target progress fed by recorded amounts | Medium | Extends the existing outcome-based progress rather than adding a second progress concept; goals without a revenue target are unchanged |
| Reports | Won and pending revenue columns | Low | Joins the existing per-campaign rates table |

**Verdict:** Fits an existing surface

Harry's Revenue Goals already measure progress from real won outcomes, but there is no place to say what a win was worth, so a goal phrased in money cannot currently be tracked in money. Adding one field per lead closes that without a new page, and keeping won and pending revenue separate is what stops the feature turning optimism into a reported number.
