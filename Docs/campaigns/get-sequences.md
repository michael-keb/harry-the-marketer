# Get Campaign Sequences

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/sequences` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-sequences |
| **Auth** | API key (query param `api_key`) |

Returns a campaign's email steps in order, each with its subject, body, wait time and any A/B variants.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to read a campaign's steps as an ordered list with their waits and wording, **so that** I can review the whole sequence without reading the diagram node by node.

**Acceptance criteria**
- [ ] Given a campaign, when I fetch its steps, then I get them ordered by position with each step's id, position, subject, body and wait — mirroring the source API's `id`, `seq_number`, `subject`, `email_body` and `seq_delay_details.delayInDays`.
- [ ] Given Harry's campaigns are Mermaid playbooks, when the steps are derived, then each `Send:` node in the diagram becomes one step, its position follows the diagram's path from Start, and its wait comes from the `no reply Xd` or `Wait: Xd` edge that leads into it.
- [ ] Given the agent writes each email at send time rather than storing a template, when a step is returned, then its "subject" and "body" are the node's instruction plus a sample composed for a representative lead, clearly labelled as a sample rather than as what will be sent.
- [ ] Given the diagram branches, when the steps are listed, then branches are represented rather than flattened — a linear list would misrepresent a playbook where `reply: interested` and `no reply 3d` lead to different emails.
- [ ] Given variants exist (the source API's `sequence_variants` with `variant_name`, subject and body), when Harry has no A/B testing, then the field is absent rather than faked, and the UI does not imply a capability that does not exist.
- [ ] Given step ids are needed for updates, when steps are returned, then each carries a stable identifier tied to its diagram node id, so an editor can target a specific step.
- [ ] Given a campaign with no playbook yet, when I fetch its steps, then I get an empty list and the page offers the starter diagram or "Generate with AI".
- [ ] Given a campaign whose diagram fails validation, when I fetch its steps, then I get the validation errors instead of a partial, misleading list.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET sequences for a campaign with two send steps | 200 with `success: true` and a `data` array of two entries ordered by `seq_number`, each with `subject`, `email_body` and the campaign id |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401, `{"message": "Invalid API Key"}`; no content returned |
| TC-3 | Not found / wrong workspace | GET for another workspace's campaign | 404, `{"error": "Resource not found"}` |
| TC-4 | Validation failure | GET with a non-numeric campaign id | 422, `{"error": "Invalid parameters provided"}` |
| TC-5 | Rate limited | Poll while typing in the editor | 429 on the excess; the editor debounces and keeps its last valid render rather than flickering |
| TC-6 | Empty result set | GET for a campaign whose playbook is empty | 200 with an empty `data` array; the page offers the starter diagram and "Generate with AI" |
| TC-7 | Branching playbook | GET for a diagram where a node has `reply: interested` and `no reply 3d` edges | Both downstream steps are listed with their branch condition named, not merged into one linear order |
| TC-8 | Wait derivation | GET for a step reached by `no reply 3d` | Its wait reads 3 days, matching the edge, and notes that smart follow-up timing may adjust it within bounds |
| TC-9 | Invalid diagram | GET for a campaign whose Mermaid fails to parse | Validation errors are returned instead of a step list, with the offending line identified |
| TC-10 | Merge fields | GET for a campaign with no API key configured, using template fallback | Subjects and bodies show the `{{firstName}}`-style merge fields the fallback composer will use, labelled as template mode |
| TC-11 | Sample labelling | GET steps for a campaign using the AI composer | Each sample is labelled as an example for a named representative lead, never presented as the email that will be sent |
| TC-12 | Stable ids | Edit an unrelated node, then refetch | Untouched steps keep their identifiers so an editor's selection survives the edit |

## 4. Frontend user story

**As a** campaign owner, **I want** a readable list view of my playbook's send steps beside the diagram, **so that** I can check the wording and the waits without mentally executing the flowchart.

**Scope**
- Campaigns → campaign detail: a "Steps" view alongside the Mermaid editor, listing each send step in path order with its instruction, its wait, its branch condition, and a sample composed email marked clearly as a sample.
- Each step row shows the node performance Harry already computes — emails sent and leads currently at that node — plus, from Reports' Learning section, how many replies that step earned.
- Selecting a step highlights the corresponding node in the diagram, and vice versa, so the two views are one thing seen two ways.
- Loading: skeleton rows; empty: "No steps yet" with the starter diagram and "Generate with AI"; error: an invalid diagram shows the validation errors in place of the list, with the offending line linked in the editor.
- Accessibility: steps are an ordered list with each branch condition in text; sample emails are in labelled regions marked as examples; the diagram-to-list selection link is keyboard operable. Responsive: the list stacks below the diagram under 1024px.

**Definition of done**
- [ ] Steps render in path order with branch conditions named, never flattened.
- [ ] Samples are unmistakably labelled as examples, not as queued emails.
- [ ] Selection is linked in both directions between the diagram and the list.
- [ ] An invalid diagram shows errors instead of a misleading partial list.

## 5. Backend user story

**As a** Harry API, **I want** a route that projects a validated playbook into an ordered step list, **so that** clients get a linear reading of the diagram without reimplementing the parser.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/steps`, workspace-scoped, returning `{ steps: [], errors: [] }` where each step carries the node id, position, branch condition, instruction, derived wait, and optionally a sample composition.
- Data model: no new table. Steps are projected from the campaign's stored Mermaid text by `server/playbook.js`, which already parses and validates it; node performance counts come from `messages` grouped by node.
- Sample compositions are generated on request only when explicitly asked for, using `server/ai.js`, and are cached briefly; they are never persisted as drafts and never enter the send path, so a preview can never be mistaken for an approved email.
- No pagination — a playbook has tens of nodes. Standard rate limiting, with debounce expected from the editor client.
- Logged: nothing to `events` for a read; a sample composition writes an AI call record to `telemetry` like any other model call, so Monitoring's AI call log stays complete.

**Definition of done**
- [ ] The projection is produced by the existing parser, with no second implementation of the DSL.
- [ ] Branching is represented in the output structure, covered by a test on a branching fixture.
- [ ] Sample compositions never create `drafts` rows, asserted by a test.
- [ ] Invalid diagrams return errors and no partial step list.

## 6. End-to-end test ticket

**Title:** E2E — Review a playbook as a list of steps

**Preconditions:** A workspace with an API key configured, a campaign whose playbook has one intro send, a `reply: interested` branch, a `reply: question` branch and a `no reply 3d` follow-up, with 30 leads and some sending history.

**Flow**
1. Open Campaigns → campaign detail and switch to the Steps view.
2. Read the steps and their branch conditions.
3. Select the follow-up step and confirm the diagram highlights its node.
4. Request a sample composition for that step.
5. Break the diagram by deleting an edge label, save, and reload the Steps view.
6. Fix the diagram and check Inbox → Needs your OK.

**Assertions**
- [ ] All four send steps appear in path order, each naming the condition that leads to it.
- [ ] The follow-up step's wait reads 3 days and notes that timing may be adjusted within bounds.
- [ ] Selecting a step highlights the matching diagram node, and clicking a node selects the matching step.
- [ ] The sample composition is labelled as an example and appears nowhere in the approval queue.
- [ ] The broken diagram shows validation errors instead of a step list.
- [ ] Per-step sent counts and reply attribution match Reports' Learning section.

**Teardown:** Delete the campaign; keep the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | A "Steps" view beside the Mermaid editor | Medium | A toggle between two views of the same thing, not a second editor; the diagram remains the source of truth and the list is read-only |
| Campaign detail node performance | Counts shown per step as well as per node | Low | Same numbers, presented in the view where they are easiest to read |
| Reports | Learning section already attributes replies to steps | Low | Shares the attribution, no new panel |

**Verdict:** Fits an existing surface

Harry's whole premise is that the diagram is the campaign, so a step list must be a reading of the diagram rather than a rival place to edit it. Making the list read-only and bidirectionally linked to the nodes gives people the linear review they ask for without creating two sources of truth.
