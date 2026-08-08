# Get Campaign by ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-by-id |
| **Auth** | API key (query param `api_key`) |

Returns one campaign's full record: its status, schedule, tracking and stop settings, sending limit, and how many of its leads have been contacted and replied.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner opening a campaign, **I want** everything that defines it in one response, **so that** the campaign page renders complete and I never have to guess at a setting that is not shown.

**Acceptance criteria**
- [ ] Given a campaign I own, when I fetch it, then I get its id, name, status, created and updated timestamps, its schedule, its tracking settings, its stop condition, its sending limit, and its lead counts — mirroring the source API's `id`, `name`, `status`, `created_at`, `updated_at`, `scheduler_cron_value`, `track_settings`, `stop_lead_settings`, `sending_limit`, `total_leads`, `leads_contacted`, `leads_replied`.
- [ ] Given Harry's campaigns are Mermaid playbooks, when I fetch a campaign, then the playbook text and its validation result come with it, so the editor can render immediately without a second request.
- [ ] Given the stop condition, when it is returned, then it is one of the documented values (`REPLY_TO_AN_EMAIL`, `OPENED_EMAIL`, `CLICKED_LINK`, `NEVER`) and is shown in plain English on the page.
- [ ] Given tracking settings, when `DONT_EMAIL_OPEN` or `DONT_LINK_CLICK` is present, then the campaign page shows that tracking is off for that signal, and Reports refuses to display the corresponding rate as zero.
- [ ] Given a campaign that does not exist or is not mine, when I fetch it, then I get a 404 with no detail about whether it exists elsewhere.
- [ ] Given a campaign in draft, when I fetch it, then the response carries the readiness state — playbook valid, mailbox attached, leads attached — so the page can explain why Launch is disabled without extra requests.
- [ ] Given a running campaign that is currently holding, when I fetch it, then the response includes the holding reason and the estimated next send time, matching what the pacing logic computes.
- [ ] Given a campaign is a follow-on of another, when I fetch it, then its parent is identified so the page can state where its leads arrive from.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET campaign 123 | 200 with a campaign object carrying `name`, `status`, `track_settings`, `stop_lead_settings`, `sending_limit`, `total_leads`, `leads_contacted`, `leads_replied` and the schedule |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401, `{"message": "Invalid API Key"}`; the page redirects to sign-in |
| TC-3 | Not found / wrong workspace | GET a campaign id from another workspace | 404, `{"error": "Resource not found"}`; the response is identical to a genuinely missing id, revealing nothing |
| TC-4 | Validation failure | GET with a non-numeric id | 422, `{"error": "Invalid parameters provided"}` |
| TC-5 | Rate limited | Fetch the campaign every second | 429 on the excess; the page keeps its last render and shows a "last updated" note |
| TC-6 | Empty result set | GET a campaign with no leads and no playbook | 200 with zero counts and an empty playbook; the page shows the readiness strip with all items outstanding |
| TC-7 | Counts accuracy | GET a campaign with 5240 leads, 4128 contacted and 312 replied | Those exact counts are returned and match the campaign's leads table when filtered by stage |
| TC-8 | Tracking off | GET a campaign whose `track_settings` contains `DONT_EMAIL_OPEN` | The page states open tracking is off; the open rate is shown as not tracked rather than 0% |
| TC-9 | Holding reason | GET a running campaign outside its working hours | The response carries the holding reason and next send estimate, and the page states both |
| TC-10 | Invalid playbook | GET a campaign whose diagram fails validation | The validation errors come with the response and the editor highlights them without a second call |
| TC-11 | Follow-on campaign | GET a campaign with a parent | The parent is named and linked on the page |
| TC-12 | Deleted campaign | GET an id that was just deleted | 404, not a 500 or a stale cached object |

## 4. Frontend user story

**As a** campaign owner, **I want** the campaign page to load complete in one go, **so that** the diagram, the settings and the state all appear together rather than stuttering in.

**Scope**
- Campaigns → campaign detail: a single fetch populates the header (name, status, holding reason), the metrics strip, the Mermaid editor with its live render and validation, the sending settings summary (window, daily cap, minimum gap, stop condition, tracking), and the attached mailbox and lead counts.
- The readiness strip on a draft campaign, and the holding explanation on a running one, both render from this same response.
- Loading: one skeleton for the whole page keeping the final layout, not four independent spinners. Empty: a brand-new campaign shows the starter diagram and all readiness items outstanding. Error: 404 renders "That campaign is not available" with a link back to Campaigns, not a stack trace.
- Accessibility: the status and holding reason are announced as a live region when they change; the settings summary is a description list; the diagram has a text alternative listing the playbook's steps and edges. Responsive: editor and settings stack under 1024px with the diagram first.

**Definition of done**
- [ ] The page renders fully from one request with no secondary fetch on first paint.
- [ ] Draft readiness and running holding reasons both come from this response.
- [ ] Tracking-off settings are stated on the page, not only in Reports.
- [ ] The 404 case is a designed state, not an error boundary.

## 5. Backend user story

**As a** Harry API, **I want** one detail route returning the campaign plus its computed state, **so that** the client never assembles the page from several inconsistent snapshots.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id`, workspace-scoped, returning the campaign row, its playbook text and validation result from `server/playbook.js`, its pacing state from `server/pacing.js`, aggregate lead counts, attached mailboxes and parent campaign.
- Data model: reads `campaigns`, `campaign_leads`, `campaign_mailboxes` and `messages` in `server/db.js`. Counts are computed in the same query; stage-derived counts use the same derivation as the Leads page so they cannot disagree.
- Access control returns 404 rather than 403 for another workspace's campaign, so ids cannot be probed.
- No pagination — this is a single object. Standard rate limiting; a short cache keyed on the campaign's `updated_at` and last message id.
- Logged: nothing to `events`. `telemetry` records assembly duration, since this route does the most work per page load.

**Definition of done**
- [ ] Playbook validation and pacing state are included, removing the follow-up requests the page would otherwise make.
- [ ] Cross-workspace access returns an indistinguishable 404, covered by a test.
- [ ] Lead counts match the Leads page derivation on a shared fixture.
- [ ] Assembly stays within the query-time budget on a 5,000-lead campaign.

## 6. End-to-end test ticket

**Title:** E2E — Open a campaign and see its complete, current state

**Preconditions:** A workspace with two campaigns: one draft with an invalid playbook, no mailbox and no leads; one running with 5,000 leads, open tracking disabled, currently outside working hours. One follow-on campaign attached to the running one.

**Flow**
1. Open Campaigns and choose the draft.
2. Read the readiness strip and the editor's validation errors.
3. Go back and open the running campaign.
4. Read the header, metrics strip and settings summary.
5. Open the follow-on campaign.
6. Delete the draft in another tab, then reload its page in the first tab.

**Assertions**
- [ ] The draft's readiness strip lists all three outstanding items and the editor shows the validation errors on first paint.
- [ ] The running campaign's header states it is holding and roughly when the next email goes.
- [ ] Its settings summary shows the sending window, daily cap, stop condition, and that open tracking is off.
- [ ] Its lead counts match the campaign's leads table filtered by stage.
- [ ] The follow-on campaign names its parent and links to it.
- [ ] The reloaded deleted campaign shows "That campaign is not available", not an error screen.

**Teardown:** Delete the running campaign and its follow-on; keep the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | Page assembled from one response; settings summary added | Low | Consolidates what the page already needed; the summary is a compact description list |
| Campaigns list | Reuses the same computed state | Low | Same derivation, no new component |
| Campaign header | Holding reason and next-send estimate | Low | One sentence, present only while holding |

**Verdict:** Fits an existing surface

Campaign detail already exists and already needs all of this; the endpoint's contribution is making the page load as one coherent picture rather than several. Nothing new appears in navigation, and the only visible addition is a settings summary that answers questions users currently answer by trial and error.
