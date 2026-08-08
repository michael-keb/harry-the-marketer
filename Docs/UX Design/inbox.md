# UX Brief: Inbox

**Job:** One place for every reply and every human OK — read, answer, reroute, park, assign, or stop.

**Lives on:** Inbox (Replies, Needs your OK, and the existing views: unread, important, assigned, snoozed, scheduled, sent, archived, reminders, untracked, custom views).

## How it works

1. Open Inbox → Replies: one list across campaigns.
2. Filter/search/sort/page (ceilings enforced in UI before request). List never loads full history; opening a thread does.
3. Open a thread → reply or forward **with confirmation**. Category, assignee, reminder, revenue, read/important as light actions on the thread.
4. Needs your OK is where drafts wait — approve or edit; nothing sends without that OK.
5. Push to subsequence, resume paused lead, block domains — actions on the lead/thread, not new pages.
6. Notes and tasks start here when the message prompts them (see lead-notes / lead-tasks).

## Hard rules

- Nothing sends without the user's OK.
- Filter bar collapsed by default with active-filter count — list stays primary.
- Same query shape for personal / important / unread / archived views.
- Forward and reply share the confirmation pattern.

## Do not build

- Per-campaign inboxes as the main path.
- A second “approvals” product outside Inbox.
- Loud always-on filter chrome.

**Specs:** [`../inbox/`](../inbox/) · 25 endpoints
