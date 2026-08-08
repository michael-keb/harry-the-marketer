# Get Lead Notes

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/crm/leads/notes/{id}` |
| **Category** | lead-notes |
| **Source** | https://api.smartlead.ai/api-reference/lead-notes/get-all |
| **Auth** | API key (query param `api_key`) |

Returns every note written about one person, each with its text, its author and when it was written.

## 1. Epic

**Shared context on a prospect**

The things a human knows about a lead that never appear in the email thread — what was said on a call, what a colleague already tried, why this one is worth chasing. It matters because Harry's Team feature puts several people in one workspace and one inbox, and without notes the only shared memory is the messages, which is exactly the part that leaves out the important bit.

## 2. User story

**As a** workspace member, **I want** to read every note about a lead in one place, newest first, **so that** before I reply to someone I know what my colleagues already know.

**Acceptance criteria**
- [ ] Given a lead with notes, when I read them, then each note returns its id, the lead it belongs to, its text, who created it and when.
- [ ] Given several notes, when they render, then they are ordered newest first, and each shows a readable absolute time as well as a relative one.
- [ ] Given notes were written in different campaigns, when they render on the lead detail, then they are grouped or labelled by campaign so context is not misread across campaigns.
- [ ] Given a lead with no notes, when I open the panel, then an empty state invites the first note rather than showing a blank area.
- [ ] Given a lead in another workspace, when I request its notes, then nothing is returned — notes never cross the workspace boundary that the Team feature draws.
- [ ] Given a lead with many notes, when the panel loads, then it shows the most recent handful with a "show all" rather than rendering hundreds at once.
- [ ] Given a note's author has since left the workspace, when the note renders, then their name is still shown, because attribution must survive membership changes.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Read the notes for a lead with three notes | 200 with three note objects, each carrying id, lead id, text, author and created-at, newest first |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the panel shows a sign-in prompt rather than "no notes" |
| TC-3 | Not found / wrong workspace | Read notes for a lead id belonging to another workspace | 404; no note text leaks |
| TC-4 | Validation failure | Read notes with a non-numeric lead id | 422 naming the id parameter |
| TC-5 | Rate limited | Open and close a thread repeatedly, refetching each time | 429 after the burst; the client caches per lead for the session rather than refetching on every open |
| TC-6 | Empty result set | Read notes for a lead that has none | 200 with an empty list; the panel shows "No notes yet" with the composer focused |
| TC-7 | Many notes | Read a lead with 200 notes | The panel shows the newest 10 with a "show all" that pages the rest; the first render is not delayed by the tail |
| TC-8 | Cross-campaign grouping | Read a lead with notes from two campaigns | Each note is labelled with its campaign; notes with no campaign are grouped as general |
| TC-9 | Departed author | Read a note whose author was removed from the workspace | The author's name still renders, marked as a former member |
| TC-10 | Markup safety | Read a note whose text contains a script tag | Rendered as plain text; nothing executes |
| TC-11 | Ordering with identical timestamps | Two notes written in the same second | Ordering is stable and deterministic, tie-broken by id |

## 4. Frontend user story

**As a** workspace member, **I want** the notes to be visible next to the thread I am reading, not behind a click, **so that** I do not reply before I have read what a colleague already found out.

**Scope**
- Inbox → thread: the notes panel shows the newest notes without interaction; older ones are behind "show all".
- Leads → lead detail: the same panel, grouped by campaign, sitting under the research profile so the agent's findings and the humans' findings read as one story.
- Loading: skeleton note rows of the right height. Empty: "No notes yet" with the composer focused. Error: an inline retry that does not clear a note being typed.
- Notes are read-only in this story apart from the composer covered by the create endpoint; editing and deleting are deliberately out of scope so the record stays honest.
- Accessibility: notes render as a list with author and time as text; "show all" is a real button with a count in its accessible name. Responsive: below 768px the panel becomes a tab beside the messages.

**Definition of done**
- [ ] The newest notes are visible without interaction on both surfaces.
- [ ] Notes are labelled by campaign wherever a lead spans more than one.
- [ ] The panel loads in one request per lead and caches for the session.
- [ ] Authors who have left the workspace still appear by name.

## 5. Backend user story

**As a** Harry API, **I want** a single workspace-scoped notes query per lead, **so that** the panel renders in one request and attribution survives membership changes.

**Scope**
- Route in `server/routes.js`: `GET /api/leads/:id/notes` accepting an optional `limit` and `before` cursor, workspace-scoped like the other lead handlers.
- Data model: reads the `lead_notes` table introduced by the create endpoint, joined to users for the author name. The author name is resolved at read time from the user record, and a note is never deleted when its author is removed from the workspace.
- Ordering by created-at descending, tie-broken by id, so paging is stable. Cursor paging rather than offset, because notes are append-only and new ones arrive while reading.
- Standard rate limiting; the client caches per lead for the session and refetches only after writing a note.
- Logged: `telemetry` for query latency only. No `events` row — reading a note is not an act on the lead.

**Definition of done**
- [ ] One query returns notes and author names; no N+1.
- [ ] Ordering is deterministic under identical timestamps, covered by a test.
- [ ] Cross-workspace lead ids return 404 and leak no text.
- [ ] Removing a workspace member does not remove or unattribute their notes, covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Read a colleague's notes before replying to a lead

**Preconditions:** A workspace with two members, a lead enrolled in two campaigns, three notes written by member A across both campaigns, and one note by a member who is then removed from the workspace.

**Flow**
1. Sign in as member B and open Inbox → the lead's thread.
2. Read the notes panel without clicking anything.
3. Open Leads → the lead → notes.
4. Remove the departed member in Settings → Team, then reload the notes.
5. Write a reply in the thread.

**Assertions**
- [ ] The newest notes are visible in the thread panel on load, newest first, with author names and times.
- [ ] On the lead detail, notes are labelled with the campaign they were written in.
- [ ] The departed member's note is still present and still attributed, marked as a former member.
- [ ] The notes panel makes it unmistakable that notes are internal, and nothing from a note appears in the reply unless member B types it.
- [ ] Reading notes leaves no entry in the activity trail.

**Teardown:** Delete the notes and the lead; restore the removed member if the fixture is reused.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → thread | Notes panel reads the newest notes on load | Medium | Becomes a tab under 768px; only the newest handful render before "show all" |
| Leads → lead detail | Notes grouped by campaign under the research profile | Low | Collapsed when empty; reuses the same list component |
| Settings → Team | Removing a member warns their notes remain | Low | One sentence in the existing confirmation |

**Verdict:** Fits an existing surface

The panel itself is new work, but it is the read half of the notes panel introduced by the create endpoint, so it adds no surface of its own. The only judgement call is putting the newest notes on screen without interaction in the Inbox — worth the space, because a note nobody reads before replying may as well not exist.
