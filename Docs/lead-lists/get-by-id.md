# Get Lead List by ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/lead-list/{id}` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/get-by-id |
| **Auth** | API key (query param `api_key`) |

Returns the details of one saved lead group — its name, how many leads it holds, and when it was made and last changed.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to open one segment and see exactly what it is and when it last changed, **so that** I can trust it before I point a campaign at it.

**Acceptance criteria**
- [ ] Given a segment id I own, when I fetch it, then a 200 returns `id`, `name`, `lead_count`, `created_at` and `updated_at`, and the header of the Leads page reflects those values.
- [ ] Given `lead_count` is 1,250, when I compare it to the filtered Leads table, then the two agree exactly — the count is derived from membership, not a stored number.
- [ ] Given `updated_at` differs from `created_at`, when I view the segment, then the age is shown in plain words ("last changed 3 days ago") rather than a raw timestamp.
- [ ] Given a segment id that does not exist, when I fetch it, then a 404 is returned and the UI shows "That segment no longer exists" with a link back to all leads, not a blank page.
- [ ] Given a segment id from another workspace, when I fetch it, then a 404 is returned and no name or count is leaked in the error body.
- [ ] Given a segment holding zero leads, when I open it, then a 200 with `lead_count: 0` renders the empty state offering the two ways to fill it, not a bare empty table.
- [ ] Given a non-numeric id, when I fetch it, then a 422 states that the id must be a number.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET /lead-list/500` | 200 with `data.id: 500`, `data.name`, `data.lead_count: 1250`, ISO `created_at` and `updated_at` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; sign-in prompt, no cached data shown as if current |
| TC-3 | Not found | `GET /lead-list/999999` | 404; "That segment no longer exists" with a link back to all leads |
| TC-4 | Wrong workspace | Fetch another workspace's segment id | 404 with no `name` or `lead_count` in the body |
| TC-5 | Validation failure | `GET /lead-list/abc` | 422 stating the id must be a number |
| TC-6 | Rate limited | Poll the segment 60 times in a minute | 429; the client backs off and the last successful values stay on screen with a "refreshing" note |
| TC-7 | Empty result set | Fetch a segment with no members | 200 with `lead_count: 0`; empty state offering "Add existing leads" and "Import a CSV" |
| TC-8 | Count freshness | Add 3 leads, refetch | `lead_count` is exactly 3 higher and `updated_at` has moved forward |
| TC-9 | Renamed segment | Rename, then refetch | `name` reflects the new name and `updated_at` is later than `created_at` |
| TC-10 | Deleted mid-session | Another team member deletes the segment while it is open | Next fetch returns 404 and the page falls back to all leads with a quiet note, not an error screen |

## 4. Frontend user story

**As a** campaign owner, **I want** the selected segment's name and count in the Leads page header, **so that** I always know which subset of people I am looking at.

**Scope**
- Leads page: when a segment is selected, the page header shows its name, "N leads", and "last changed X ago", with Rename, Push to campaign and Delete in an overflow menu beside it.
- The segment is reflected in the URL (`/app/leads?segment=500`) so it can be bookmarked and shared with a teammate in the same workspace.
- States: header skeleton while fetching; zero-lead empty state replacing the table with the two fill actions; a 404 clears the segment from the URL and shows a one-line note above the full table; stale data is never presented as fresh during a retry.
- Accessibility: the header is an `<h1>` change announced on selection; the "last changed" text uses a `<time>` element with a machine-readable `datetime`. Responsive: the header collapses to name plus count under 640px, with the age moved into the overflow menu.

**Definition of done**
- [ ] The header count always equals the number of rows the table would show unfiltered by stage.
- [ ] A deleted or invalid segment degrades to the full lead table, never to an error page.
- [ ] The selected segment survives a page reload via the URL.
- [ ] Timestamps are shown in relative words, with the exact value on hover.

## 5. Backend user story

**As a** Harry API, **I want** a single-segment route returning derived membership counts and timestamps, **so that** the Leads page header is correct without a second request.

**Scope**
- Route in `server/routes.js`: `GET /api/lead-lists/:id`, workspace-scoped, returning `{ id, name, leadCount, tags, createdAt, updatedAt }` — tags included so the header can render label chips without another call.
- Data model: reads `lead_lists`, aggregates `lead_list_leads` for `leadCount`, and joins `lead_list_tags`. `updated_at` is bumped by renames and by membership changes so "last changed" is meaningful.
- No pagination on this route; the member leads themselves come from the existing paginated leads route filtered by segment. Standard app rate limiting applies; the client backs off on 429 and keeps the last good values.
- Any id outside the caller's workspace returns 404 with an empty body, matching how campaign lookups already behave.
- Logged: no `events` row for a read; `telemetry` records lookup latency.

**Definition of done**
- [ ] `leadCount` is derived by aggregate on every call, never read from a stored counter.
- [ ] Cross-workspace and non-existent ids are indistinguishable in the response.
- [ ] `updatedAt` moves on both rename and membership change.
- [ ] Tests cover the zero-member case, count freshness after an import, and workspace isolation.

## 6. End-to-end test ticket

**Title:** E2E — Open a segment and confirm its header matches the table

**Preconditions:** A workspace with a segment "SMB Tech Companies" holding 850 leads, created a week ago and renamed yesterday.

**Flow**
1. Open Leads and select the segment.
2. Read the header.
3. Copy the URL, open it in a new tab.
4. Add 3 leads to the segment from the table's bulk action.
5. Reload.

**Assertions**
- [ ] The header shows the segment name, "850 leads", and "last changed 1 day ago".
- [ ] The pasted URL opens with the same segment already selected.
- [ ] After adding 3 leads the header reads "853 leads" and the age resets to "just now".
- [ ] Deleting the segment in another tab makes this tab fall back to all leads with a note, not an error.

**Teardown:** Remove the 3 added leads from the segment.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Header shows the selected segment's name, count and age | Low | Replaces the generic page title rather than adding a band above it |
| Leads | Segment reflected in the URL query | Low | Invisible until shared or bookmarked |
| Leads | Overflow menu with Rename, Push to campaign, Delete | Low | One menu, three items, only present when a segment is selected |

**Verdict:** Fits an existing surface

This endpoint backs a page header, not a page: the only thing it changes is what the Leads page calls itself while a segment is selected. Putting the segment in the URL is the one design decision worth defending, because it turns "which list were you looking at" into a link a teammate can open.
