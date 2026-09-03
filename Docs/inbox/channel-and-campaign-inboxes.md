# Plan: Email / SMS inboxes + per-campaign inbox

**Status:** proposed — not built  
**Date:** 2026-09-01  
**Surfaces:** `/app/inbox`, `/app/campaigns/:id`

Parent: [Docs/messaging-channels-plan.md](../messaging-channels-plan.md)  
SMS context: [Docs/SMS/implementation-plan.md](../SMS/implementation-plan.md)

---

## Goal

Operators should not hunt for an SMS reply inside a mixed email list.

1. **Two channel inboxes on the Inbox page** — Email and SMS are separate lists, not a badge on a mixed feed.
2. **Each campaign has its own inbox** — switch campaign from Inbox, and open that campaign’s inbox from the campaign page.

Same folders (Active, Unread, Sent, …), same reading pane, same reply actions. The split is **which conversations are in the list**.

---

## What already exists (do not rebuild)

| Piece | Today |
|-------|--------|
| One mail client | `web/src/inbox/MailClient.jsx` at `/app/inbox` |
| Folder rail | Active / Unread / Important / Sent / … |
| Campaign filter (hidden) | `campaignId` in Filters + `GET /api/inbox/threads?campaignId=` |
| SMS vs email data | `messages.channel`, SMS thread keys `sms:{accountId}:{e164}` |
| SMS row badge + SMS composer | `ThreadList.jsx`, `ThreadPane.jsx` |
| Campaign channel mode | `email` / `sms` / `multi` on the campaign |

**Missing:** `channel` is not a query param or UI tab. Campaign filter is buried. Campaign page has no Inbox tab (only per-lead `MessageHistory`).

---

## Product design

Keep **one** `MailClient`. Do not fork EmailInbox / SmsInbox. Scope it with two first-class selectors.

```
┌──────────────────────────────────────────────────────────────┐
│  Inbox                                                       │
│  [ Email ]  [ SMS ]                 Campaign: [ All ▾ ]      │
├────────────┬─────────────────────────┬───────────────────────┤
│ Folders    │ Thread list             │ Reading pane          │
│ Active  4  │  (this channel +        │  Email reply  or      │
│ Unread  2  │   this campaign only)   │  SMS composer         │
│ Sent       │                         │                       │
└────────────┴─────────────────────────┴───────────────────────┘
```

### 1. Channel split (Email | SMS)

- Segmented control **above** the folder rail (or in the page header).
- Default: **Email** (current mental model). SMS-only users still one click away.
- Optional third tab **All** is **out of v1** — the request is two separate inboxes.
- Switching channel:
  - Clears the open thread (different conversation set).
  - Keeps folder when it exists on both sides (Active, Unread, Sent, …).
  - Folder copy and empty states change (`email` vs `sms` wording).
- Counts on the folder rail are **for the current channel** (and campaign, if scoped).
- **Needs your OK:** email drafts in Email inbox; SMS drafts in SMS inbox.
- **Untracked:** Email only (mailbox replies with no lead). SMS unmatched stays a later gap unless a phone cannot be matched.

**Thread identity:** a person can have an email thread and an SMS thread. They stay two conversations. Opening SMS does not mix Gmail threads in.

**Classification of a thread:** `channel = sms` if the conversation’s messages are SMS (existing `shapeThread` / thread detail). Mixed threads are rare; treat “any SMS message” as SMS so they appear in SMS, not Email.

### 2. Per-campaign inbox

Two ways to land in the same scoped list:

**A. Inbox page — campaign switcher (always visible)**

- Control in the header: `All campaigns` plus a searchable list of this workspace’s campaigns.
- Single-select for v1 (API already allows up to 5 `campaignId`s; UI today is a buried multi-checkbox).
- Switching campaign keeps **channel + folder**, clears the open thread.
- SMS-only campaigns still appear in the Email inbox as empty unless you switch to SMS (and vice versa). Helper text: “This campaign is SMS — switch to SMS.”
- Deep link: `/app/inbox?channel=sms&campaignId=2&folder=active`

**B. Campaign page — Inbox tab**

- New tab on `CampaignDetail`: **Inbox** (alongside Playbook, Leads, …).
- Embeds the same `MailClient` with:
  - `campaignId` **locked** (no “All campaigns”).
  - Default `channel` from `channelMode`: sms → SMS, email → Email, multi → Email with SMS tab still available.
- Header CTA elsewhere: “Open inbox” → `/app/inbox?campaignId={id}&channel={sms|email}`.
- Unread badge on the tab = unread threads for that campaign (needs scoped unread-count).

The Leads drawer `MessageHistory` stays as **one lead’s transcript**. It is not the campaign inbox.

---

## URL and API

### URL (`/app/inbox`)

| Param | Values | Notes |
|-------|--------|--------|
| `channel` | `email` \| `sms` | New. Default `email`. Always written (like `folder`). |
| `campaignId` | one integer | Promote from hidden filter to header switcher. |
| `folder` | existing | Unchanged |
| `thread`, `viewId`, … | existing | Unchanged |

Campaign page embed uses the same params internally; may omit writing `campaignId` to the campaign URL (campaign id is already in the path). Prefer query on `/app/inbox` so the two surfaces share one client.

### API

`GET /api/inbox/threads`

- Add `channel=email|sms`. Omit or `all` = current mixed behaviour (keep for saved views / scripts; UI v1 never omits).
- Apply in `parseFilters()` + `threadPredicate()` / `listMessages()`.
- Index already exists: `idx_messages_channel (user_id, channel, id)`.

`GET /api/inbox/unread-count`

- Accept `channel` and `campaignId` so the campaign Inbox tab and channel tabs can badge correctly.

`GET /api/inbox/views`

- Stored views may include `channel` + `campaignId` (campaign already stored). Applying a view sets both selectors.

`POST /api/inbox/sync`

- Unchanged (Gmail). SMS still arrives via webhook.

---

## Files to touch

| Layer | Files |
|-------|--------|
| API | `server/parity/inbox.js` (`parseFilters`, `threadPredicate`, `listMessages`, unread-count) |
| Inbox UI | `MailClient.jsx` (header selectors, URL), `FolderRail.jsx` (scoped counts), `Filters.jsx` (stop burying campaign as the only campaign UI; hide duplicate when switcher exists), `ListPane.jsx` (empty copy), `ThreadList.jsx` (already badges SMS) |
| Campaign | `CampaignDetail.jsx` (Inbox tab), optional slim wrapper `CampaignInbox.jsx` that renders `MailClient` with locked props |
| Tests | `tests/inbox-*.test.js`, `web/src/inbox/*.test.jsx`, new channel/campaign filter cases |

---

## Build sequence

### Phase 1 — Channel inboxes (Inbox page)

1. Backend: `channel` on thread list + scheduled/sent + unread-count.
2. URL: `?channel=email|sms`.
3. Header segmented control Email | SMS.
4. Folder counts and empty states scoped to channel.
5. Split approval queue by draft channel (`subject: SMS` / `messages.channel`).
6. Tests: list email-only, sms-only; SMS campaign thread does not appear on Email.

**Done when:** Squad Institute SMS replies are invisible on Email and listed on SMS.

### Phase 2 — Campaign switcher on Inbox

1. Header campaign select: All + campaigns (`useRefs().campaigns`).
2. Wire existing `campaignId` query; lock to one id in the UI.
3. Empty state when channel ≠ campaign mode.
4. “Open inbox” from campaign header → deep link.

**Done when:** `/app/inbox?campaignId=2&channel=sms` shows only that campaign’s SMS threads.

### Phase 3 — Campaign page Inbox tab

1. New tab mounts `MailClient` with `lockedCampaignId` + default channel.
2. Hide global campaign switcher; keep Email | SMS if `channelMode === 'multi'`.
3. Unread badge on the tab.
4. Folder rail can collapse to a strip on the campaign page (already has `variant="strip"`).

**Done when:** `/app/campaigns/2` → Inbox shows the same list as the deep link, without leaving the campaign.

### Phase 4 — Polish (same PR or follow-up)

- Saved views include channel.
- Copy: “emails” → channel-aware in folder hints (`FolderRail` / `ListPane` `EMPTY_COPY`).
- SMS untracked (unmatched phone) — **not required** for the two-inbox split.
- Real-time push — out of scope (10s poll stays).

---

## Decisions (locked for v1)

| Decision | Choice | Why |
|----------|--------|-----|
| One client vs two apps | One `MailClient`, scoped | Same folders, selection, composer |
| Combined All-channels tab | No in v1 | Request is two separate inboxes |
| Campaign select | Single campaign or All | Matches “this campaign’s inbox” |
| Default channel | Email, unless campaign is SMS-only | Don’t surprise email users |
| Mixed email+SMS person | Two threads | Existing `sms:` vs Gmail keys |
| Campaign Leads history | Keep | Per-lead, not a list of conversations |

---

## Test plan (when we build)

- [ ] `GET /api/inbox/threads?channel=sms` returns only SMS threads
- [ ] `channel=email` excludes `sms:` threads
- [ ] `campaignId=2&channel=sms` excludes other campaigns and email
- [ ] Folder counts change when switching Email ↔ SMS
- [ ] Inbox URL round-trips `channel` + `campaignId` + `folder`
- [ ] Campaign page Inbox tab matches the deep-link list
- [ ] Email approval drafts do not appear in SMS “Needs your OK”
- [ ] Keyboard/folder rail still works with the new header

---

## Out of scope

- WhatsApp / Telegram inboxes (same pattern later: another `channel=` value)
- Merging email + SMS into one person-thread
- WebSocket live inbox
- Changing SMS webhook / engine send behaviour
