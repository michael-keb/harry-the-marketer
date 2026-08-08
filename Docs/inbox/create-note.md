# Create Lead Note

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/create-note` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/create-note |
| **Auth** | API key (query param `api_key`) |

Attaches a free-text note to one lead's place in one campaign, so the team shares what was learned outside the email thread.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member working a reply, **I want** to write a note against this lead in this campaign, **so that** what I learned on a call or from research is there for whoever picks the thread up next.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id` — in Harry the `campaign_leads` row) and note text (`note_message`), when I save a note, then it is stored against that pairing with the author and timestamp and appears immediately in the thread without a reload.
- [ ] Given empty or whitespace-only note text, when I save, then the request is rejected with a field-level message and nothing is stored.
- [ ] Given a lead-campaign pairing that belongs to another workspace, when I post a note, then the request returns 404 and nothing is stored.
- [ ] Given several notes on the same lead, when I open the thread, then they are listed newest first with the author's name on each.
- [ ] Given a lead in two campaigns, when I add a note in one campaign's thread, then the note is scoped to that pairing and is labelled with the campaign wherever the lead's full history is shown.
- [ ] Given a note that is very long, when I save it, then it is accepted up to a stated limit and the counter warns before the limit rather than truncating silently.
- [ ] Given a note is written, when a teammate opens Inbox, then the note is visible to them because notes are workspace-shared, not private.
- [ ] Given a note is written, edited or deleted, when it completes, then an entry is written to the activity trail naming the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_lead_map_id": 2433664091, "note_message": "Called lead - interested in Q2 rollout. Follow up end of Jan."}` | 200; a follow-up read of the lead returns the note with author and created timestamp |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the typed note is preserved in the box |
| TC-3 | Not found / wrong workspace | POST with an `email_lead_map_id` from another workspace | 404; UI shows "That lead is not available" and returns to Inbox |
| TC-4 | Validation failure — empty note | POST `{"email_lead_map_id": 2433664091, "note_message": ""}` | 422 with a field-level message on `note_message`; Save stays disabled |
| TC-5 | Rate limited | Post notes in a tight burst | 429 on the excess; the client retries once with backoff and the note is not lost |
| TC-6 | Empty result set | Open the notes panel on a lead that has none | 200 with an empty list; empty state reads "No notes yet" with the compose box focusable |
| TC-7 | Missing required field | POST with `note_message` only, no `email_lead_map_id` | 422 naming `email_lead_map_id`; nothing stored |
| TC-8 | Same lead, two campaigns | Add a note in campaign A's thread for a lead also in campaign B | The note appears on A's thread and is labelled with campaign A on the lead's combined history; B's thread is unchanged |
| TC-9 | Concurrent authors | Two teammates save notes on the same lead within a second | Both are stored; both appear, ordered by timestamp, neither overwrites the other |
| TC-10 | Over-length note | Save a note beyond the stated character limit | 422 with the limit named; the text is preserved for editing, never truncated silently |

## 4. Frontend user story

**As a** team member, **I want** a notes panel beside the email thread and on the lead's record, **so that** context and correspondence sit next to each other instead of in a separate tool.

**Scope**
- Inbox → Replies thread view: a "Notes" panel beside the message list with a compose box and a reverse-chronological list showing author, relative time and text. Adding a note does not touch the reply composer, so a half-written reply is never lost.
- Leads → lead detail: the same notes list, aggregated across that lead's campaigns with a campaign label per note.
- Loading: skeleton lines in the panel. Empty: "No notes yet — add what you learned." Error: inline banner above the compose box with the typed text preserved.
- Notes are plain text with line breaks preserved; no rich text, to keep the panel unambiguous and safe to render.
- Accessibility: the compose box is a labelled textarea with a visible character counter announced to screen readers near the limit; Save is a real button reachable by keyboard; author and time are text, not tooltips. Responsive: under 768px the panel becomes a collapsible section below the thread rather than a side column.

**Definition of done**
- [ ] A note saved in a thread appears in the panel and on the lead's record without a reload.
- [ ] Notes are visible to every workspace member, with the author named.
- [ ] Empty, loading, validation-error and offline states are designed and verified in light and dark.
- [ ] Adding a note never clears or interferes with a draft reply in the composer.

## 5. Backend user story

**As a** Harry API, **I want** notes stored against the lead-campaign pairing, **so that** context follows the lead through the playbook and is shared with the whole workspace.

**Scope**
- Routes in `server/routes.js`, workspace-scoped like the rest: `POST /api/leads/:leadId/notes` taking `{ campaignId, text }`, `GET /api/leads/:leadId/notes`, `DELETE /api/notes/:id` (author or owner only).
- Data model: a `lead_notes` table in `server/db.js` (`workspace_id`, `lead_id`, `campaign_id` nullable for lead-level notes, `author_user_id`, `text`, `created_at`), indexed on (`lead_id`, `created_at`).
- Validation: text trimmed and required, capped at a stated length; the lead and campaign must both belong to the caller's workspace or the route returns 404.
- Pagination: `GET` returns the most recent 50 with a cursor, since a long-running lead can accumulate many notes; the standard app rate limiter applies, no special retry handling needed.
- Notes are read-only input to the AI layer: `server/ai.js` may include recent notes as context when composing a reply, clearly separated from the thread so the composer does not quote a private note back to the prospect.
- Logged: an `events` row per note created or deleted with actor, lead and campaign; no telemetry beyond error counts.

**Definition of done**
- [ ] Table, index and routes exist and are covered by tests, including cross-workspace 404.
- [ ] Notes are never included verbatim in outgoing email text; a test asserts this.
- [ ] Delete is restricted to the note's author or the workspace owner.
- [ ] Note creation and deletion appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Capture call context on a lead and hand the thread over

**Preconditions:** A workspace with two members, one sandbox mailbox, a running campaign, one lead that has replied so a thread exists in Inbox → Replies.

**Flow**
1. Member A opens Inbox → Replies and selects the lead's thread.
2. In the Notes panel, A writes "Spoke with decision maker. Budget approved. Next step: demo." and saves.
3. A starts typing a reply in the composer but does not send.
4. Member B signs in and opens the same thread.
5. B opens Leads → the same lead and checks the notes there.

**Assertions**
- [ ] The note appears in A's panel immediately, showing A's name and a relative timestamp.
- [ ] A's half-written reply is still in the composer after the note saves.
- [ ] B sees the same note, attributed to A, in the thread and on the lead record with the campaign labelled.
- [ ] The activity trail contains one note-created entry naming A.
- [ ] Deleting the note as B (not the author, not the owner) is refused.

**Teardown:** Delete the note, the lead and the campaign; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | New Notes panel beside the messages | Medium | Collapsed to a single "Notes (0)" line when empty, so a thread with no notes looks like today's thread |
| Leads → lead detail | Notes list added to the existing detail layout | Low | Goes below the existing knowledge profile, same card treatment |
| Activity trail | Note entries appear | Low | One more event type in a feed that already mixes types |

**Verdict:** Fits an existing surface

Harry's Inbox has the thread and the manual reply but no way to record anything that happened off-email, so notes are a real gap rather than a duplicate of something existing. The thread view already has room beside the message list, and collapsing the panel when empty keeps the default view unchanged for anyone who never writes a note.
