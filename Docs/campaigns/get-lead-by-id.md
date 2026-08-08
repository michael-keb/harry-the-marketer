# Get Lead by ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/leads/{id}` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-lead-by-id |
| **Auth** | API key (query param `api_key`) |

Returns everything known about one person — their details, custom fields, engagement, and how their last reply was classified — regardless of which campaign they are in.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** person about to approve an email, **I want** one view of everything known about the recipient, **so that** I can judge in seconds whether the draft in front of me is right for them.

**Acceptance criteria**
- [ ] Given a lead id, when I fetch it, then I get their contact details and custom fields plus their current state and engagement — mirroring the source API's `id`, `email`, `first_name`, `last_name`, `company_name`, `status`, `category_id`, `category_name`, `email_stats` (`is_opened`, `is_clicked`, `is_replied`) and `custom_fields`.
- [ ] Given this is a global lookup across campaigns, when I fetch a lead, then I get every campaign they are in, with their stage and playbook node in each, not just one.
- [ ] Given Harry derives stage rather than storing it, when the status is returned, then it is derived from messages, outcomes and signed agreements — not contacted, contacted, replied, interested, agreed, won, lost, unsubscribed, bounced — so it cannot drift from the record.
- [ ] Given a reply has been classified, when the lead is returned, then the classified intent (the source API's `category_name`, for example "Interested") is included along with whether a human corrected it.
- [ ] Given Harry researches companies, when a research profile exists, then the situation, likely pain, trigger, opportunity and personalisation hooks come with the lead, along with when they were last refreshed.
- [ ] Given the lead is scored against a goal's ICP, when the lead is returned, then the 0-100 score, its plain-language reasons and its confidence are included, and unknown data lowers confidence rather than inventing a score.
- [ ] Given a lead has unsubscribed, when they are returned, then that is unmistakable at the top of the record and no campaign action is offered.
- [ ] Given a lead id in another workspace, when I fetch it, then I get a 404 and no personal data is disclosed.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET lead 789 who has opened, clicked and replied | 200 with `email`, names, `company_name`, `status`, `category_name: "Interested"`, `email_stats` all true, and `custom_fields` including `job_title` |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401; no personal data returned |
| TC-3 | Not found / wrong workspace | GET a lead id from another workspace | 404; the response is identical to a genuinely missing id |
| TC-4 | Validation failure | GET with a non-numeric lead id | 422 with a field-level message on the lead id |
| TC-5 | Rate limited | Fetch leads in a tight loop while scrolling a list | 429 on the excess; the client batches its requests instead of one per row |
| TC-6 | Empty result set | GET a lead who has never been contacted | 200 with `email_stats` all false, status "not contacted", no research profile, and the page shows those as empty states rather than blanks |
| TC-7 | Multi-campaign lead | GET a lead attached to three campaigns | All three are listed with per-campaign stage and playbook node |
| TC-8 | Reclassified reply | Reclassify a reply in Inbox, then fetch the lead | The classified intent reflects the correction and the record notes it was human-corrected |
| TC-9 | Unsubscribed lead | GET a lead who unsubscribed | Status is unsubscribed, prominently; no campaign actions are offered on the page |
| TC-10 | Research profile absent | GET a lead with no API key configured for research | Profile section reads "Not researched" with a refresh action, never fabricated content |
| TC-11 | Low-confidence score | GET a lead with sparse data | Score is returned with low confidence and reasons naming what is unknown |
| TC-12 | Custom fields | GET a lead imported with 150 custom fields | All are returned and rendered as a scrollable key-value list without breaking the page |

## 4. Frontend user story

**As a** person working the approval queue, **I want** the recipient's full picture beside the draft, **so that** approving is an informed decision rather than a leap of faith.

**Scope**
- Leads → lead detail: contact details, custom fields, derived stage, per-campaign position, qualification score with reasons, research profile with a refresh action, engagement summary, and the full message timeline.
- Inbox → Needs your OK: a condensed version of the same record in a side panel next to the draft — name, company, score with its top reason, research hooks, and prior messages — so the approver does not have to leave the queue.
- Inbox → Replies: the same panel beside a thread.
- Loading: skeletons in each section independently, so the draft is readable before the profile finishes. Empty: each section has its own honest empty state ("Not researched yet", "No score — this lead is not linked to a goal"). Error: sections fail independently and retry independently.
- Accessibility: the side panel is a labelled complementary region reachable by keyboard from the draft; the score is a number with text reasons, not a gauge alone; unsubscribed status is announced. Responsive: the side panel becomes a collapsible section above the draft under 1024px.

**Definition of done**
- [ ] The same lead record renders on Leads and in the Inbox side panel from one endpoint.
- [ ] Sections load and fail independently without blocking the draft.
- [ ] Unsubscribed and bounced states are unmissable wherever the lead appears.
- [ ] Nothing in the profile is shown without provenance — research and scores state when and how they were produced.

## 5. Backend user story

**As a** Harry API, **I want** one lead route returning the person plus their derived state, **so that** every surface that shows a lead shows the same thing.

**Scope**
- Route in `server/routes.js`: `GET /api/leads/:id`, workspace-scoped, returning contact fields, custom fields, derived stage, engagement flags, per-campaign positions, qualification score with reasons and confidence, research profile with its timestamp, and recent messages.
- Data model: reads `leads`, `campaign_leads` and `messages` in `server/db.js`. Stage and engagement are computed, never stored, using the same derivation as the Leads page filter strip. Custom fields are stored as JSON on the lead.
- Access control returns 404 for another workspace's lead, indistinguishable from a missing id, since lead ids map to real people.
- No pagination on the object itself; the message timeline is paged with a sensible default of the most recent 20. Standard rate limiting; the client is expected to batch rather than fetch per row.
- Logged: nothing to `events` for a plain read. `telemetry` records assembly duration; bulk reads of personal data by export are logged separately by the export route.

**Definition of done**
- [ ] Stage and engagement derivation match the Leads page on a shared fixture.
- [ ] Cross-workspace access returns an indistinguishable 404, covered by a test.
- [ ] Research and score fields always carry provenance and are never synthesised when missing.
- [ ] Timeline paging is covered by a test on a lead with 200 messages.

## 6. End-to-end test ticket

**Title:** E2E — Approve an email with the recipient's full picture in view

**Preconditions:** A workspace with a sandbox mailbox, a goal with an ICP, a campaign linked to that goal, one lead who has been scored and researched and has replied once, and one lead who has never been contacted. Approvals on.

**Flow**
1. Open Inbox → Needs your OK and select the draft for the researched lead.
2. Read the side panel.
3. Open the same lead on the Leads page and compare.
4. Refresh the research profile from the Leads page.
5. Return to the queue and approve the draft.
6. Open the never-contacted lead's record.

**Assertions**
- [ ] The side panel shows the score with its top reason, the research hooks, and the previous reply's classified intent.
- [ ] The Leads page shows the same values, with no discrepancy in stage or score.
- [ ] Refreshing research updates the timestamp on both surfaces.
- [ ] Approving the draft does not alter the lead record other than adding the send to the timeline.
- [ ] The never-contacted lead shows honest empty states rather than zeros or invented content.
- [ ] A lead id from another workspace returns "Not available", disclosing nothing.

**Teardown:** Delete the campaign; keep the leads and their research profiles.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → lead detail | Consolidated record with score, research and per-campaign position | Medium | Sections are collapsible and each has an honest empty state; nothing renders when there is nothing to say |
| Inbox → Needs your OK | Side panel showing the condensed record | Medium | Condensed to five values; collapsible, and remembers its state per user |
| Inbox → Replies | The same panel | Low | Shares the component |

**Verdict:** Fits an existing surface

Lead detail already exists, and the approval queue already needs this context — approvers currently open a second tab to get it. Putting a condensed, collapsible version of the same record beside the draft removes that trip without adding a page, which is exactly where Harry's standing rule about human approval pays off.
