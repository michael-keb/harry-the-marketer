# Duplicate Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/duplicate` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/duplicate |
| **Auth** | API key (query param `api_key`) |

Copies a campaign's whole setup — its sequence, schedule, settings and mailboxes — into a fresh draft, without copying its leads or its numbers.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner with a campaign that works, **I want** to copy it as a starting point for the next audience, **so that** I keep the playbook and settings that earned replies without rebuilding them by hand.

**Acceptance criteria**
- [ ] Given a campaign I own, when I duplicate it, then a new campaign is created in draft and its id is returned (the source API returns `ok: true` and `newCampaignId`).
- [ ] Given the duplicate is created, when I open it, then it carries the original's playbook diagram, sending schedule and working hours, tracking settings, stop conditions and attached mailboxes.
- [ ] Given the duplicate is created, when I open its leads, then it has none — leads are deliberately not copied, so a copy can never re-email the original's audience.
- [ ] Given the duplicate is created, when I open Reports, then it has no statistics of its own; the original's analytics stay with the original.
- [ ] Given the original has follow-on campaigns, when I duplicate with the "also copy follow-on campaigns" option (the source API's `duplicate_sub_sequence`, default off), then those children are copied and re-pointed at the new parent, not at the original.
- [ ] Given webhooks on the original, when I duplicate, then they are not copied — notification destinations must be chosen deliberately for the new campaign.
- [ ] Given the duplicate is created, when I look at its name, then it is clearly derived from the original ("Copy of …") and immediately renameable inline.
- [ ] Given a campaign id that is not mine, when I duplicate it, then the request fails with a not-found style error and no campaign is created.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST duplicate on campaign 125 with both options false | 200, `{"ok": true, "newCampaignId": 842}`; campaign 842 is in draft with the same playbook and mailboxes |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; no campaign created |
| TC-3 | Not found / wrong workspace | Duplicate a campaign id from another workspace | Error with `{"message": "Invalid campaign Id!"}` (the source API returns 500 here; Harry's equivalent returns 404) and nothing created |
| TC-4 | Validation failure | POST `duplicate_sub_sequence: "yes"` | 422 with a field-level message stating a boolean is required |
| TC-5 | Rate limited | Duplicate a campaign 30 times in a burst | 429 on the excess; client backs off, no orphaned half-copies |
| TC-6 | Empty result set | Duplicate a campaign that has no mailboxes and an empty playbook | 200; the copy is created with the same emptiness and its readiness strip lists what is missing |
| TC-7 | Leads not copied | Duplicate a campaign with 500 leads | The copy has zero leads; the original still has 500 |
| TC-8 | Statistics not copied | Duplicate a campaign with 200 sends and 30 replies | The copy shows zero sends and zero replies in Reports |
| TC-9 | Follow-on campaigns | Duplicate with `duplicate_sub_sequence: true` on a parent with two children | Two child copies exist, each pointing at the new parent; the original's children are unchanged |
| TC-10 | Webhooks not copied | Duplicate a campaign with a Slack hook | The copy has no hooks; the original still delivers |
| TC-11 | Duplicate of a running campaign | Duplicate while the original is live | Copy is created in draft; the original keeps running undisturbed and sends nothing extra |
| TC-12 | Partial failure | Force a failure while copying the playbook | Nothing is left behind — no half-built campaign appears in the list |

## 4. Frontend user story

**As a** campaign owner, **I want** Duplicate on the campaign menu with a short list of what will and will not be copied, **so that** I know before clicking that the copy starts with no audience.

**Scope**
- Campaigns list and campaign detail: "Duplicate" in the same overflow menu as Archive and Delete.
- The dialog shows two lines — copied (playbook, schedule, settings, mailboxes) and not copied (leads, statistics, notifications) — plus one optional checkbox for follow-on campaigns, unticked by default.
- On success the user is taken to the new campaign's detail page with the name field focused for renaming, and the readiness strip already showing "no leads attached".
- Loading: the dialog button shows progress and the menu is disabled. Error: the invalid-campaign case reads "That campaign is no longer available", not a raw server message. Empty: not applicable — a duplicate always produces one campaign.
- Accessibility: the copied/not-copied lists are real lists so a screen reader hears them as such; the checkbox has a visible label naming what a follow-on campaign is. Responsive: dialog is full-height on mobile.

**Definition of done**
- [ ] Duplicate is available from both places campaigns are listed.
- [ ] The dialog states plainly that leads and statistics are not copied.
- [ ] Success navigates to the copy with the name ready to edit.
- [ ] The follow-on option is off by default and copies children re-pointed at the new parent.

## 5. Backend user story

**As a** Harry API, **I want** a duplicate route that deep-copies configuration and nothing else, **so that** copying a campaign is fast, atomic, and can never contact the original's audience.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/duplicate` taking `{ includeChildren?: boolean }` and returning `{ id }`, workspace-scoped.
- Data model: no new tables. Copies the `campaigns` row (playbook text, schedule, working hours, tracking flags, stop conditions, linked goal) and the `campaign_mailboxes` links. Explicitly excludes `campaign_leads`, `messages`, node statistics and `campaign_webhooks`. Status is forced to draft regardless of the original's status.
- Whole copy runs in one SQLite transaction so a failure leaves no partial campaign. When children are included, each child is copied and its `parent_campaign_id` rewritten to the new campaign inside the same transaction.
- No pagination. Standard rate limiting; a repeat submit within a short window returns the campaign already created rather than a second copy.
- Logged: an `events` row recording source campaign, new campaign, and whether children were included; `telemetry` counts duplications so Monitoring can see the feature being used.

**Definition of done**
- [ ] The copy is provably lead-free and statistic-free, covered by a test.
- [ ] Status is always draft, even when duplicating a running campaign.
- [ ] Child re-pointing is covered by a test asserting no child points at the original.
- [ ] A forced mid-copy failure leaves zero rows behind.

## 6. End-to-end test ticket

**Title:** E2E — Reuse a proven playbook for a new audience

**Preconditions:** A workspace with a running campaign that has a valid playbook, two sandbox mailboxes, 20 leads, at least 5 sent emails and 1 reply, one follow-on campaign, and a Slack-shaped test hook.

**Flow**
1. Open Campaigns, open the campaign's overflow menu and choose Duplicate.
2. Tick "also copy follow-on campaigns" and confirm.
3. Rename the copy to "Q2 — ANZ" on the page it lands on.
4. Attach 10 different leads and launch the copy.
5. Open Reports and compare both campaigns.
6. Trigger a reply on the copy's sandbox mailbox.

**Assertions**
- [ ] The copy opens in draft with the same diagram and both mailboxes attached.
- [ ] The copy has zero leads and zero statistics before step 4.
- [ ] The copied follow-on campaign points at the copy, and the original's follow-on still points at the original.
- [ ] The original keeps running throughout, with no extra sends caused by the duplication.
- [ ] The copy's reply does not deliver to the Slack test hook, because notifications were not copied.
- [ ] Reports shows two separate campaigns with separate numbers.

**Teardown:** Delete the copy and its child; leave the original running for other tests.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns list | Duplicate added to the existing overflow menu | Low | One more item in a menu that already holds Archive and Delete |
| Campaign detail | Same menu item in the header | Low | Shares the component |
| Duplicate dialog | Copied / not copied lists and one checkbox | Low | Two short lists; no settings to configure at copy time |

**Verdict:** Fits an existing surface

Duplicating is a campaign action, so it lives in the campaign's own menu beside Archive and Delete — no new page, no new navigation item. The one thing worth spelling out in the dialog is that leads do not come along, because that is the assumption most likely to cause a costly mistake.
