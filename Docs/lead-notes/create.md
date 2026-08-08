# Create Lead Note

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/create-note` |
| **Category** | lead-notes |
| **Source** | https://api.smartlead.ai/api-reference/lead-notes/create |
| **Auth** | API key (query param `api_key`) |

Writes a free-text note against one person in one campaign, visible to everyone who shares the workspace.

## 1. Epic

**Shared context on a prospect**

The things a human knows about a lead that never appear in the email thread — what was said on a call, what a colleague already tried, why this one is worth chasing. It matters because Harry's Team feature puts several people in one workspace and one inbox, and without notes the only shared memory is the messages, which is exactly the part that leaves out the important bit.

## 2. User story

**As a** workspace member, **I want** to write a note against a lead in a specific campaign, **so that** whoever picks up that thread next knows what happened away from email.

**Acceptance criteria**
- [ ] Given a lead in a campaign, when I write a note, then it is stored against that campaign-and-lead pairing (the equivalent of the source API's `email_lead_map_id`), so a note about one campaign does not appear as context for an unrelated one.
- [ ] Given the note is saved, when it renders, then it shows the note text, who wrote it and when, and it is visible to every member of the workspace.
- [ ] Given an empty or whitespace-only note, when I try to save it, then it is refused with a field-level message and nothing is written.
- [ ] Given a long note, when I save it, then it is accepted up to a stated character limit, with the remaining count visible while typing rather than a surprise rejection.
- [ ] Given the lead is not in the named campaign, when I try to attach a note, then it is refused with a message rather than silently creating an orphaned note.
- [ ] Given a note exists, when the agent composes the next email for that lead, then the note is available to the composer as context alongside the business briefing and the research profile — and the composer is still bound by the honest-outreach rules, so it may not invent anything from a note.
- [ ] Given a note is written, when I read the activity trail, then there is one entry saying a note was added, naming the author and the lead, without copying the note body into the log.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Save a note against a lead in a campaign | 200 with the created note carrying its id, the campaign-lead reference, the text and a created-at timestamp |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the typed note is kept in the composer so nothing is lost |
| TC-3 | Not found / wrong workspace | Save against a campaign-lead pairing from another workspace | 404; no note is created in either workspace |
| TC-4 | Validation failure — empty note | Save with an empty message | 422 with a field-level message on the note text |
| TC-5 | Rate limited | Save ten notes in quick succession | 429 on the later ones; the client retries with backoff and no note is lost or duplicated |
| TC-6 | Empty result set | Open a lead with no notes | The notes panel shows "No notes yet" with the composer focused, not a blank area |
| TC-7 | Over the length limit | Save a note longer than the stated limit | 422 naming the limit; the character counter had already warned before the save |
| TC-8 | Lead not in that campaign | Save a note referencing a lead and a campaign it is not attached to | 400 with a message that the lead is not in that campaign |
| TC-9 | Team visibility | Save a note as one member, then read it as another member of the same workspace | The second member sees the note with the first member's name as author |
| TC-10 | Composer context | Save a note, then let the agent compose the next email | The note is present in the composer's context and the resulting draft invents nothing beyond it |
| TC-11 | Markup safety | Save a note containing HTML and a script tag | Stored and rendered as plain text; nothing executes |

## 4. Frontend user story

**As a** workspace member, **I want** to add a note without leaving the thread or the lead I am looking at, **so that** writing one is faster than not writing one.

**Scope**
- Inbox → thread: a notes panel beside the message list, since most notes are prompted by something just read, with the composer always visible at the bottom.
- Leads → lead detail: the same notes panel, grouped by campaign so a note's context is obvious.
- Loading: the note appears optimistically with a pending marker and rolls back on failure. Empty: "No notes yet" with the composer focused. Error: the note text is preserved and the reason shown inline.
- The panel makes clear that notes are internal and never reach the prospect — one line of helper text, since the panel sits next to a reply box that does.
- Accessibility: the composer is a labelled textarea with a live character counter announced politely; notes render as a list with author and time as text. Responsive: below 768px the panel becomes a tab beside the messages rather than a sidebar.

**Definition of done**
- [ ] A note can be written from both the Inbox thread and the lead detail with the same component.
- [ ] It is unmistakable that a note is internal and not a reply.
- [ ] Notes show author and time, and the workspace sees each other's notes.
- [ ] Failed saves never lose the typed text.

## 5. Backend user story

**As a** Harry API, **I want** notes stored against the campaign-and-lead pairing with an author, **so that** context is attributable and scoped correctly in a shared workspace.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:leadId/notes` taking `{ campaignId, body }`, workspace-scoped like the neighbouring lead handlers.
- Data model: a new `lead_notes` table in `server/db.js` (id, workspace, lead_id, campaign_id nullable, author_user_id, body, created_at), with a foreign key to `campaign_leads` validated on write so a note cannot reference a pairing that does not exist.
- Body is stored as plain text with a length limit enforced server-side; rendering escapes it, and no HTML is permitted, since notes flow into the composer's prompt.
- No pagination on write. Standard rate limiting; the client retries 429 with backoff and dedupes by a client-supplied idempotency key so a retry cannot double-post.
- Logged: an `events` row that a note was added (actor, lead, campaign) with the body deliberately omitted; `telemetry` counts notes per workspace so Monitoring can show whether the feature is used at all.

**Definition of done**
- [ ] Notes cannot be created against a lead-campaign pairing that does not exist.
- [ ] The author is the authenticated user, never client-supplied.
- [ ] Note bodies never appear in `events` or telemetry.
- [ ] Retrying a failed save does not create two notes, covered by an idempotency test.

## 6. End-to-end test ticket

**Title:** E2E — Write a note from a thread and see it inform the next email

**Preconditions:** A workspace with two members, one sandbox mailbox, a campaign with a reply-interested edge, and one lead who has replied.

**Flow**
1. Sign in as member A, open Inbox → the lead's thread.
2. Write a note: "Called Priya — she wants pricing for 50 seats before any call."
3. Let the engine follow the interested edge and compose the next email.
4. Open Inbox → Needs your OK and read the draft.
5. Sign in as member B and open Leads → the lead → notes.
6. Open the Dashboard activity trail.

**Assertions**
- [ ] The note appears immediately in the thread panel with member A's name and the time.
- [ ] The composed draft reflects the note's substance and states nothing the note does not support.
- [ ] The draft is still waiting for approval; nothing has sent.
- [ ] Member B sees the same note, attributed to member A.
- [ ] The activity trail records that a note was added and does not contain the note text.

**Teardown:** Delete the note, the campaign and the lead; clear the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → thread | Notes panel with a composer | Medium | A tab beside the messages on narrow screens; the reply box stays the primary action |
| Leads → lead detail | Same notes panel, grouped by campaign | Low | Sits under the existing research profile, collapsed when empty |
| Dashboard activity trail | "Note added" entries | Low | One line, body omitted |

**Verdict:** New surface needed

There is nowhere in Harry today to record what a human knows that the email thread does not — the research profile is the agent's work, and the activity trail is a log, not a place to write. A notes panel is genuinely new, but it belongs inside two pages that already exist and must be visually distinct from the reply box so nobody ever mistakes an internal note for something the prospect will read.
