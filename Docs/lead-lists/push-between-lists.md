# Move Leads Between Lists

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/leads/leads/push-between-lists` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/push-between-lists |
| **Auth** | API key (query param `api_key`) |

Copies or moves people from one saved group into another, either by picking specific leads or by taking everyone from a source group.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to split or merge my segments by copying or moving leads between them, **so that** a big imported list can become the two or three groups I will actually run campaigns against.

**Acceptance criteria**
- [ ] Given `action: "move"`, `fromListId: 500` and `toListId: 501`, when I submit, then every lead in 500 is added to 501 and removed from 500, and the response reports `total_leads_moved`.
- [ ] Given `action: "copy"` with the same ids, when I submit, then the leads appear in 501 and remain in 500, and the difference between copy and move is stated in the confirmation before I commit.
- [ ] Given `leadIds` of specific ids (1 to 10,000 allowed) instead of `fromListId`, when I submit, then only those leads are transferred; supplying both `leadIds` and `fromListId` is rejected as ambiguous.
- [ ] Given neither `leadIds` nor `fromListId`, or a missing `toListId`, when I submit, then a 422 names the missing field and nothing is transferred.
- [ ] Given a lead already in the destination segment, when I copy or move it, then it is not duplicated there, and it is reported as already-present rather than counted as transferred.
- [ ] Given `leadIds` with more than 10,000 entries, when I submit, then a 422 names `leadIds` and its 1-10,000 range; the UI chunks large selections rather than making me split them.
- [ ] Given a move of 1,250 leads fails part way, when the call returns, then the whole transfer is rolled back — leads are never missing from both segments at once.
- [ ] Given the transfer succeeds, when the engine next ticks, then no campaign changes as a result: segment membership is organisation only, and no email is composed or sent by this action.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path — move a whole list | POST `{"action":"move","fromListId":500,"toListId":501}` | 200 with `data.total_leads_moved: 1250`; segment 500 count is 0, 501 has gained 1,250 |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; both segments unchanged |
| TC-3 | Not found / wrong workspace | `toListId` belongs to another workspace | 404; nothing transferred, destination name not leaked |
| TC-4 | Validation failure — no source | POST `{"action":"move","toListId":501}` | 422 stating that either `leadIds` or `fromListId` is required |
| TC-5 | Rate limited | Transfer 50,000 leads across chunked calls | 429 on some chunks; the client backs off and resumes, final counts are exact with no duplicates |
| TC-6 | Empty result set | Move from a segment holding zero leads | 200 with `total_leads_moved: 0`; "Nothing to move" message, no state change |
| TC-7 | Copy versus move | POST TC-1 with `action: "copy"` | 200; segment 500 still holds 1,250 and 501 has gained them |
| TC-8 | Specific ids | POST `{"action":"copy","leadIds":[1,2,3],"toListId":501}` | 200 with `total_leads_moved: 3` |
| TC-9 | Both sources supplied | POST with `leadIds` and `fromListId` together | 422 stating that exactly one source may be given |
| TC-10 | Already in destination | Copy a lead that is already in 501 | 200; it is reported as already present and appears once in 501 |
| TC-11 | Over the id cap | POST `leadIds` with 10,001 entries | 422 naming `leadIds` and the 1-10,000 range |
| TC-12 | Same source and destination | POST `{"action":"move","fromListId":500,"toListId":500}` | 422 stating source and destination must differ; no rows touched |
| TC-13 | Rollback | Force a failure at row 900 of a 1,250-lead move | The whole move is rolled back; segment 500 still holds all 1,250 |

## 4. Frontend user story

**As a** campaign owner, **I want** to select leads and send them to another segment with a clear copy-or-move choice, **so that** reorganising groups never loses anyone by accident.

**Scope**
- Leads page bulk action bar (visible once rows are ticked): "Add to segment", opening a picker of existing segments plus "New segment", with a two-option toggle — Copy (keep in the current segment) or Move (remove from it). Move is only offered when a segment filter is active, because otherwise there is nothing to move out of.
- Segments panel overflow menu: "Move all leads to…" and "Copy all leads to…" for whole-segment transfers, which map to `fromListId`.
- The confirmation states the counts in plain words: "Copy 1,250 leads into SMB Tech Companies. They stay in Q1 2025 Enterprise Prospects too."
- States: pending disables the picker and shows chunk progress for selections over a few thousand; success updates both segment counts in place; already-present leads are reported as "N were already there" rather than as errors; failure leaves both segments exactly as they were.
- Accessibility: the copy/move toggle is a radio group with visible labels, not an icon pair; progress uses `aria-live="polite"`. Responsive: the picker becomes a bottom sheet under 640px.

**Definition of done**
- [ ] Copy and move are always named in words in the confirmation, never inferred from an icon.
- [ ] Both segment counts update without a page reload.
- [ ] Move is hidden when there is no source segment to move out of.
- [ ] A failed transfer leaves both segments untouched.

## 5. Backend user story

**As a** Harry API, **I want** one transactional route for copying or moving segment membership, **so that** reorganising thousands of leads is atomic and cannot strand a lead in neither segment.

**Scope**
- Route in `server/routes.js`: `POST /api/lead-lists/transfer` taking `{ action, leadIds, fromListId, toListId }`, workspace-scoped, rejecting requests where both or neither source is supplied and where source equals destination.
- Data model: writes only `lead_list_leads`. Insert into the destination uses the `(list_id, lead_id)` unique constraint so re-running is a no-op; a move then deletes the source rows in the same SQLite transaction. `leads` rows are never modified. Both segments' `updated_at` are bumped.
- Bounds mirror the source API: `leadIds` 1-10,000 per call; whole-list transfers are executed in server-side chunks with the whole operation wrapped so a mid-way failure rolls back. Standard rate limiting; the client retries 429 with backoff.
- Every lead id is verified as belonging to the caller's workspace before any write, so a guessed id returns 404 rather than transferring a stranger's lead.
- Logged: one `events` row per transfer (actor, action, source, destination, transferred count, already-present count); `telemetry` records rows per second so Monitoring can see large reorganisations.

**Definition of done**
- [ ] Move and copy share one code path, differing only by whether the source delete runs.
- [ ] The operation is atomic — a partial transfer is impossible.
- [ ] Re-running an identical copy transfers zero and returns 200.
- [ ] Tests cover both actions, the ambiguous-source rejection, the same-id rejection, and the rollback path.

## 6. End-to-end test ticket

**Title:** E2E — Split one imported segment into two

**Preconditions:** A workspace with segment "Q1 2025 Enterprise Prospects" holding 1,250 leads and an empty segment "SMB Tech Companies"; 20 of the 1,250 are already in a running campaign.

**Flow**
1. Open Leads and select "Q1 2025 Enterprise Prospects".
2. Tick 300 rows using the table's filters.
3. Bulk action → Add to segment → SMB Tech Companies → Move.
4. Read the confirmation, confirm.
5. Open the Segments panel.
6. Repeat with 50 rows using Copy.

**Assertions**
- [ ] The confirmation names both segments and says the leads will be removed from the source.
- [ ] After the move, the two counts read 950 and 300 and the totals add up.
- [ ] After the copy, the counts read 950 and 350 — nothing left the source.
- [ ] The 20 leads in the running campaign are still in that campaign and still at their original stages.
- [ ] No draft appears in Inbox → Needs your OK as a result of the transfer.
- [ ] The activity trail shows two entries, one per transfer, with counts.

**Teardown:** Move the 350 leads back and delete "SMB Tech Companies".

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads bulk action bar | "Add to segment" with a copy/move toggle | Medium | The bar already exists and only appears when rows are ticked; the toggle is two labelled radios, not a settings panel |
| Leads → Segments panel | "Move all / Copy all to…" in the overflow menu | Low | Two items in a menu that already holds Rename and Delete |
| Confirmation dialog | Plain-English sentence naming both segments and the effect | Low | One sentence replaces what would otherwise be a diagram |

**Verdict:** Fits an existing surface

Reorganising segments is a bulk action on rows the user has already selected, so it belongs in the bulk action bar the Leads table shows today. The one thing that genuinely needs care is copy versus move — an icon toggle would fail the "don't make me think" test, so both options must be spelled out in words in the confirmation, with the consequence stated for the source segment.
