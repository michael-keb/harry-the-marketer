# Harry The Marketer — UX audit fix plan

**Source:** [ux-audit-self-healing.md](./ux-audit-self-healing.md)  
**Framework:** [v2 mermaid self healing ux.md](./v2%20mermaid%20self%20healing%20ux.md)  
**Status:** PLAN — nothing in the audit backlog is implemented yet  
**Rule:** one primary fix in flight per surface. Do not ship two competing voices on the same screen in the same PR.

This plan turns the audit into sequenced work. It is the “what needs to be done” companion to the audit’s “what it means.”

---

## How to use this document

1. Work **waves in order**. Later waves assume earlier honesty (scope, interruption, waiting).
2. Each work item is a **shippable PR** with files, behaviour, and a done check.
3. Do not regress the [preserve list](#do-not-regress).
4. After each wave, tick the matching checkboxes in `ux-audit-self-healing.md`.
5. Closure is not “all tickets closed.” Closure is the [adversarial scenario](#adversarial-pass) no longer producing a support screenshot that fails to defend itself.

---

## Locked decisions

These are decided so implementation does not reopen product debates.

| # | Decision | Why |
|---|----------|-----|
| D1 | **Client Lens is hybrid, not banner-only.** Filter Dashboard, Needs You, and Goals when a client is selected. Keep Reports, Monitoring, and Inbox workspace-wide — and **name every surface** in the lens copy. | Filter-or-disclose is already the product rule in `ClientLens.jsx` / `api.js`. The bug is that Dashboard / Needs You / Goals are neither filtered nor named. Banner-only (audit Option B) is a fallback if a join cannot be made honest. |
| D2 | **Inbox composer drafts persist in `localStorage` first**, keyed by workspace + thread id. Server drafts only if a later PR needs multi-device. | Typed work must survive refresh and thread switch on one machine. A server draft is a bigger API change than the gap needs. |
| D3 | **Campaign Start always opens a confirmation modal** before `PUT …/status`. Demote “Run engine now” to Manage (ghost, never `btn-primary`). | Launch is a money / reputation moment. The prototype already had this ritual; the React header currently fires Start with no summary. |
| D4 | **Campaign webhooks are a UI panel on campaign Settings**, not a new nav item. Backend already exists (`/api/campaigns/:id/webhooks`). | Prototype promised it; tests already cover the API. This is parity, not a new product. |
| D5 | **Auth failures never take down marketing pages.** `/api/auth/me` errors (non-401) leave `/`, `/pricing`, `/security`, etc. rendering; only `/app/*` shows the full-page error. | The trust pages exist precisely for when the product is sick. |
| D6 | **Signup OAuth errors return to `/signup?error=…`**, not `/login`. Login copy stays “Welcome back.” | A first-timer must not land on a returning-user screen. |
| D7 | **HTML prototypes are historical.** Do not rebuild the product to match them. Absorb the *intent* (launch modal, order-done release, campaign webhooks) into shipped React, then mark the prototype folder stale. | Prototypes have already drifted (Action Center → Needs You, Mailboxes → Connections). |
| D8 | **H18 screenshots come last**, after behaviour is shipped. Do not delay P0 on photography. | The framework wants images; customers need the product to stop lying first. |

---

## Do not regress

These patterns are already strong. Touch them only to extend, never to replace with a weaker pattern.

- Needs You review drawer before send; honest `—` / “at least N+” counts; poll pause while reading
- Send confirmation modals that name mailbox + recipients
- Campaign `LaunchChecklist` (all blockers at once with fix links)
- Honesty primitives: null as `—`, stale markers, pending ≠ zero
- Settings Readout / EditableSection (read before edit) for *text* fields
- Inbox URL state for folder, thread, draft id, filters
- Command palette combobox a11y tests

---

## Wave 0 — Trust architecture (P0)

**Goal:** The Monday-morning agency screenshot stops being a lie.

**Adversarial test after this wave:** Select client Acme → Dashboard KPIs and Needs You only show Acme. Start a reply, refresh, the text is still there. Reports Overview cannot be misread as “last week” when the funnel is all-time. Starting a campaign requires a named confirmation.

### 0.1 Client Lens — filter what can be filtered, name the rest

**Files**

- `web/src/api.js` — extend `LENS_AWARE` (today: `/api/leads`, `/api/campaign-list`, `/api/mailboxes/fleet`)
- `server/routes.js` — `GET /api/dashboard` honour `?clientId=`
- `web/src/dashboard/needs-you-data.jsx` — pass lens into drafts / tasks / reminders / attention
- `web/src/pages/Goals.jsx` + goals API — filter or disclose
- `web/src/ClientLens.jsx` — rewrite the continuous note so it is true
- `web/src/__tests__/ClientLens.test.jsx`, `tests/client-lens.test.js`

**Behaviour**

1. When a client is selected, Dashboard stats, chart, activity, and `attention` rows are scoped to that client’s campaigns / leads / mailboxes (join on `client_id`). Unscoped house work stays visible only on “All clients.”
2. Needs You sources that can join a lead or campaign `client_id` are filtered the same way. Sources that cannot join are either omitted from the lensed queue **or** labelled “workspace-wide” in the row — never mixed silently.
3. Goals: filter if a goal has a join path; otherwise a page banner: “Goals are workspace-wide.”
4. Client Lens copy becomes an accurate inventory, e.g. *“Campaigns, leads, mailboxes, Dashboard, and Needs You are filtered to this client. Inbox, Reports, and Monitoring stay workspace-wide.”*
5. Fallback: if a join would guess, do not guess — disclose. Honest beats consistent.

**Done when**

- [ ] Test: two clients, two campaigns → dashboard counts for client A exclude client B
- [ ] Test: lens-aware routes stay listed; Reports / Monitoring still receive **no** `clientId`
- [ ] UI copy names Dashboard, Needs You, Goals, Inbox, Reports, Monitoring correctly
- [ ] Existing ClientLens tests still pass

---

### 0.2 Needs You — “still checking” is never silent

**Files:** `web/src/dashboard/NeedsYou.jsx`, `web/src/dashboard/needs-you-data.jsx`

**Behaviour**

- Keep showing rows that have already arrived (do not hide early truth).
- While **any** source is `loading` and others have rows, show a banner: *“Still checking approvals, tasks, and reminders — this list may grow.”*
- Tab pills that are still loading keep `—` (already true).
- All-clear empty state only when `!loading && !unavailable && total === 0` (already true — do not weaken).

**Done when**

- [ ] Partial load cannot be mistaken for a complete queue
- [ ] Existing honest-count behaviour (`at least N+`, unavailable banner) is unchanged

---

### 0.3 Inbox — persist the reply the customer already typed

**Files:** `web/src/inbox/Composer.jsx`, `web/src/inbox/DraftPane.jsx` (dirty-switch warning)

**Behaviour**

- Persist reply (and SMS reply) body + subject per `workspaceId + threadId` in `localStorage`.
- Restore on mount; clear only after a **successful** send.
- Switching threads saves the previous thread first.
- Draft **edit** mode: if dirty, confirm before switching drafts (branded `Confirm`, not `window.confirm`).
- Cap storage (e.g. 50 threads) so this cannot grow forever.

**Done when**

- [ ] Refresh mid-compose restores the text
- [ ] Switching threads and coming back restores the other draft
- [ ] Successful send clears the stored draft for that thread

---

### 0.4 Reports Overview — one strip that names the clocks

**Files:** `web/src/reports/OverviewTab.jsx`, `web/src/pages/Reports.jsx`, `web/src/reports/CampaignDrilldown.jsx`, `web/src/pages/Dashboard.jsx`

**Behaviour**

- Overview: a persistent strip above the first all-time panel: *“Headline & contact mix: [from–to] · Funnel & learning: all time.”*
- Campaign drill-down: each panel already has a note — add a visible **scope chip** (Range / All time / Active since) on the panel header, not only in the note.
- Dashboard KPI tiles that link to Reports: label them all-time, or land Reports on a matching default. Do not imply the tile and the report are the same number.

**Done when**

- [ ] A 7-day filter cannot produce a screenshot where the funnel looks like last week
- [ ] Drill-down panels answer “which clock?” without reading the paragraph

---

### 0.5 Campaigns — launch ritual; demote the engine button

**Files:** `web/src/campaigns/StatusControl.jsx`, `web/src/pages/CampaignDetail.jsx`

**Behaviour**

- Start / Resume opens a modal: lead count, mailbox (or SMS) pool, next send window if known, approval-mode reminder, primary *Start sending*.
- Existing `LaunchChecklist` still blocks Start when unready — the modal is for **ready** campaigns, not a second checklist.
- After success: a durable header note *“Started [time] · Next send [time or ‘on schedule’] · [N] awaiting your OK”* until the first send or the user dismisses it. Toast may remain; toast is not enough.
- Move “Run engine now” to the Manage tab as `btn-ghost`. Never `btn-primary` in the header.

**Done when**

- [ ] A ready campaign cannot Start with one click from the header
- [ ] Header primary actions are Start / Pause / Stop / Send me a test — not the engine
- [ ] Existing blocker / Stop / duplicate flows still work

---

## Wave 1 — Recovery and narration (P1)

**Goal:** Interruption and waiting have a story. Auth failures land on the right emotional job.

### 1.1 Signup errors stay on Signup

**Files:** `server/auth.js` (`loginErrorRedirect`), `web/src/auth/Signup.jsx`, `web/src/auth/Login.jsx`, `tests/auth-oauth.test.js`

**Behaviour**

- Callback / OAuth errors that started from `/signup` redirect to `/signup?error=…`.
- Customer-facing error strings only. No “check server logs”, no `AUTH0_DOMAIN` on the customer path.
- Login lede stays returning-user; Signup lede stays first-timer.

**Done when**

- [x] Test: signup-started OAuth failure lands on `/signup?error=`
- [x] Login never shows signup-intent errors as “Welcome back” with campaign copy

---

### 1.2 Marketing site survives API outage

**Files:** `web/src/Root.jsx`

**Behaviour**

- Non-401 `/api/auth/me` failure: treat user as signed-out for marketing (`user = null`), do **not** replace the tree with `ErrorState`.
- `/app/*` still shows retry ErrorState (or RequireAuth spinner → login if session truly unknown).
- Optional: a slim banner on marketing “We cannot check your session right now” — never a full-page wall.

**Done when**

- [x] `/security` and `/pricing` render when the API is down
- [x] `/app` does not silently open unauthenticated

---

### 1.3 OAuth tap is not silence

**Files:** `web/src/auth/Login.jsx`, `web/src/auth/Signup.jsx`

**Behaviour**

- Clicking “Continue / Sign up with Google” sets a local busy state: disable the control, copy *“Redirecting to Google…”*.
- Full mobile trust panel: show all five `ASIDE` points, or a “Why it’s safe” disclosure — do not truncate to three bullets as the only mobile truth.

**Done when**

- [x] Double-click cannot fire two OAuth starts from the UI
- [x] Mobile signup has the same trust facts as desktop (possibly collapsed, not deleted)

---

### 1.4 Find Emails — job survives leaving the sheet

**Files:** `web/src/leads/FindEmails.jsx`, `web/src/pages/Leads.jsx`

**Behaviour**

- While `busy`, Cancel is disabled; copy says *“Safe to leave — this keeps running. Reopen Find emails to see progress.”*
- Persist `jobId` (and lead ids) so reopening the sheet calls `GET /api/leads/find-emails/:jobId` automatically.
- Show batch progress when the payload has it; otherwise narrate “Looking up N of M…”
- Optional later: a global pill in the Leads header while a job is in flight. Wave 1 minimum is sheet + auto-reread.

**Done when**

- [ ] Closing the sheet mid-job does not lose the job
- [ ] Reopen restores status without starting a duplicate lookup

---

### 1.5 Inbox sync is visible

**Files:** `web/src/inbox/MailClient.jsx`

**Behaviour**

- Sync in progress: small status *“Checking mail…”* (list header or live region).
- Failure: toast + retry; do not swallow.
- Optional: “Last checked [relative time]” when idle.

**Done when**

- [ ] A failed sync is user-visible
- [ ] Happy-path 10s poll does not spam toasts

---

### 1.6 Goals — wait has steps; win has a release

**Files:** `web/src/pages/Goals.jsx`

**Behaviour**

- During build: a progress card that mirrors server `steps` as they arrive (or a staged list: planning → qualifying → attaching → launching). Button label alone is not enough.
- Failure: inline error on the form, typed prompt preserved. Toast may accompany; toast is not the only surface.
- Achieved: a Notice — what was hit, link to Reports / that campaign, not only a “won” badge.
- Replace `window.confirm` on archive with branded `Confirm`.

**Done when**

- [ ] A 20-second build is narrated, not a frozen button
- [ ] Hitting target is a moment, not a chip colour change

---

## Wave 2 — Orientation and parity (P2)

**Goal:** You can land, share, and finish without remembering a previous screen.

### 2.1 Leads — URL memory + import parity

**Files:** `web/src/pages/Leads.jsx`, `web/src/leads/LeadDetail.jsx`, import UI (workspace vs segment)

**Behaviour**

- `?tab=` already exists. Add `?lead=` for the drawer; closing the drawer removes it. Back button closes the drawer.
- Breadcrumb in the drawer: *Leads / [name]* (and Board / stage chip if opened from Board).
- Workspace CSV import uses the same `ImportSummary` as segment import. Do not close until the user dismisses the summary.
- Segment-selected chrome: visually distinct table treatment plus the existing amber banner so the table cannot be read as “these are the segment members.”

**Done when**

- [ ] Sharing `/app/leads?tab=people&lead=123` opens that lead
- [ ] Workspace import outcome is screenshot-defensible (counts + row errors)

---

### 2.2 Settings shell — name the room; find it from a phone

**Files:** `web/src/pages/Settings.jsx`, `web/src/App.jsx`, `web/src/CommandPalette.jsx`, `web/src/__tests__/CommandPalette.test.jsx`

**Behaviour**

- H1 = area label (`Billing`, `Never contact`, …). “Settings” is breadcrumb or lead, not the only title. `document.title` includes the area.
- Mobile top bar: search icon that opens the palette (⌘K remains).
- Palette labels match tabs: Alerts (not “Webhooks” as the only name), Integrations (not “Connections”), Team & clients. Add Billing and Account commands.
- Instant send toggles: either operable without Edit, or drop the “instant” comment and keep the Edit gate — pick one and make copy match.

**Done when**

- [ ] Cold screenshot of Billing is titled Billing
- [ ] Typing “billing” or “webhooks” in the palette lands on the right area
- [ ] Phone can open search without opening the full nav first

---

### 2.3 Order completion — release the buyer

**Files:** `web/src/mailboxes/Senders.jsx` (SenderFlow), `web/src/mailboxes/Orders.jsx`

**Behaviour**

- After place: a completion panel, not “Back to the flow” as primary.
- Show reference, pending vs complete, copy-reference control.
- Primary CTAs: *View this order* · *Open fleet* · *Done* (closes the purchase card).
- Pending copy: what happens next, that they will not be double-charged.

**Done when**

- [ ] Success does not dump the user back onto a filled purchase form
- [ ] Matches the *intent* of `Docs/UX Design/HTML Prototype/pages/order-done.html` without cloning the prototype chrome

---

### 2.4 Campaign sending health + campaign webhooks UI

**Files:** `web/src/pages/CampaignDetail.jsx`, `web/src/campaigns/MailboxesPanel.jsx`, new panel under Settings tab, reuse patterns from `web/src/settings/WebhooksSection.jsx`

**Behaviour**

- When status is Running: a header “Sending health” strip — hold reason, mailbox `lastError`, bounce/complaint brake, pending-OK count — one primary fix link.
- Settings tab: campaign webhook list / add / secret-once / deliveries, calling existing `/api/campaigns/:id/webhooks`.
- Do not add a ninth campaign tab if Settings can hold it.

**Done when**

- [ ] A running campaign with a dead mailbox is obvious without opening Sending from
- [ ] Campaign webhooks can be created in the UI (API already tested)

---

### 2.5 Monitoring — waiting tests and actionable incidents

**Files:** `web/src/pages/Monitoring.jsx`, inbox-placement list / `CreateTestForm`, test detail header

**Behaviour**

- Active / scheduled tests: list row shows progress or “safe to leave,” not only a status chip.
- Incidents and delivery error rows: one primary link (mailbox drawer, test, or Connections).
- Unverified deliverability: per-panel “confirmed” vs “best-effort” badge, not only a global `<details>`.
- Replace `sequenceStepId` free text with a Send-step picker from the campaign playbook.

**Done when**

- [ ] An in-flight test is understandable from the list
- [ ] An incident screenshot includes a next step

---

## Wave 3 — Polish and evidence (P3)

**Goal:** Remaining H-codes and the audit’s own evidence gap.

### 3.1 Leads list — labels you can see

- People table: labels column or chips.
- Lead detail: show “+ Label” even when the workspace has zero labels (first-run tagging).

### 3.2 Reports empty states

- Replace grey one-liners with `EmptyState` + CTA (widen range / launch campaign / connect mailbox), matching Overview’s “No activity in this range.”

### 3.3 Inbox triage and echo

- Open triage (assignee / intent) by default on unread inbound, or pin a one-line summary above the composer.
- Toast or inline echo on notes / tasks / reminder saves.
- Replace native `confirm()` on approve-all / decline with branded `Confirm`.

### 3.4 Dashboard hierarchy

- Needs You is the reason to open the page: keep it first, make its heading compete with (or outrank) the generic “Dashboard” H1. Unread replies stay a chip, not a second queue.

### 3.5 Auth / settings jargon

- Account and Integrations: no `.env` / `AUTH0_*` / README in customer copy. Link to a help article or hide behind an “for your admin” disclosure.

### 3.6 H18 screenshot pass (last)

Capture, at minimum:

| Surface | States |
|---------|--------|
| Auth | Login, Signup, OAuth busy, signup error on Signup, API-down marketing |
| Dashboard | Empty Needs You, partial load banner, client lens on, all-clear + stale engine |
| Campaign | Launch modal, running + sending-health fail, engine button on Manage only |
| Inbox | Composer restored after refresh, sync failed, sync idle |
| Leads | `?lead=` drawer, import summary, Find Emails in-flight |
| Reports | Overview with scope strip, empty range, stale marker |
| Buy senders | Order completion panel |
| Settings | Per-area H1, mobile search |

Then: mark HTML prototypes historical in `Docs/UX Design/HTML Prototype/index.html` (one sentence: shipped product is React; these pages are design history).

Re-triage H2 / H3 / H10 / H17 only after this bundle exists.

---

## Suggested PR slices

Keep PRs small. Suggested titles, in order:

| PR | Wave | Title |
|----|------|--------|
| 1 | 0.1 | Filter Dashboard and Needs You through Client Lens |
| 2 | 0.2 | Needs You still-checking banner |
| 3 | 0.3 | Persist inbox reply drafts |
| 4 | 0.4 | Reports time-scope strip and drill-down chips |
| 5 | 0.5 | Campaign launch confirmation; demote Run engine now |
| 6 | 1.1–1.3 | Auth: signup errors, marketing on API down, OAuth busy + mobile trust |
| 7 | 1.4 | Find Emails job persistence |
| 8 | 1.5 | Inbox sync status |
| 9 | 1.6 | Goals progress and achieved release |
| 10 | 2.1 | Leads deep links and import summary |
| 11 | 2.2 | Settings titles, palette labels, mobile search |
| 12 | 2.3 | Sender order completion |
| 13 | 2.4 | Campaign sending health + webhooks panel |
| 14 | 2.5 | Monitoring test progress and incident links |
| 15 | 3.x | Labels column, empty states, triage, confirm seams, jargon |
| 16 | 3.6 | Screenshot bundle + prototype historical note |

Do not combine PR 1 with anything else. Scope honesty is the load-bearing change.

---

## Test plan (minimum)

| Area | Automated | Manual |
|------|-----------|--------|
| Client lens | Extend `tests/client-lens.test.js` + `web/src/__tests__/ClientLens.test.jsx` | Agency: two clients, switch, Dashboard + Needs You + Leads |
| Auth | `tests/auth-oauth.test.js` redirect target | Signup with Google fail → still on Signup |
| Inbox drafts | Component test: persist / restore / clear on send | Refresh mid-reply; switch threads |
| Campaign start | StatusControl: modal before START | Ready campaign cannot one-click start |
| Find Emails | Job id round-trip | Close sheet, reopen, same job |
| Reports | Assert scope strip copy in Overview | 7-day range + funnel still labelled all time |
| Webhooks | API already in `tests/parity-webhooks.test.js`; add UI smoke if cheap | Create campaign webhook in Settings tab |
| Regression | Existing inbox / campaigns / leads / send-controls tests | Send confirmation still names mailbox |

Browser-verify every UI PR: the changed flow end to end, plus one adjacent surface that shares state (lens, URL params, or send confirmations).

---

## Adversarial pass

Re-run after Wave 0, then after Wave 1.

**Script:** Agency user, Client Acme, phone, interrupted twice.

1. Dashboard with Acme selected — numbers and Needs You are Acme’s, or the page says they are not.
2. Needs You still loading one source — cannot look “done.”
3. Inbox reply, app switch, return — text still there.
4. Reports, last 7 days — funnel cannot be read as last week.
5. Start a campaign — must confirm who / from where / under what approval.

If any step produces a screenshot that needs a developer to explain it, that wave is not done.

---

## Closure

The audit stays **OPEN** until:

- [ ] Wave 0 and Wave 1 checkboxes are done
- [ ] Wave 2 items 2.1–2.5 are done or explicitly deferred with owner sign-off (campaign webhooks UI is the only large defer candidate; the API already exists, so prefer shipping it)
- [ ] Wave 3.6 screenshot bundle exists
- [ ] Adversarial pass passes on the five steps above
- [ ] `ux-audit-self-healing.md` status line updated to `CLOSED v1` bound to that screenshot set

---

## What this plan is not

- A visual redesign. Taste (H10) waits on screenshots.
- A rewrite of Client Lens into a navigation item. It stays in the shell.
- Matching the HTML prototype pixel-for-pixel.
- Adding new main-nav destinations.

---

*Plan for the 30 August 2026 Self-Healing UX audit. Implement Wave 0 first.*
