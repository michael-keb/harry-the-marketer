# Complex Brief v3 — Webhook Failure & Missing Replies

**Scenario:** A CRM webhook starts failing. Replies stop syncing into Harry. The owner fixes the endpoint, runs a manual catch-up, and confirms the lost thread before replying.

**Purpose:** Isolated token A/B — run WYRE and HTML in **separate fresh chats** (see `RUN-WYRE.md` / `RUN-HTML.md`).

**Actor:** Jordan Lee (agency owner)  
**Version:** 3.0 · 2026-08-08

---

## Problem & goal

**Problem:** SmartLead replies are not appearing in Harry. The webhook endpoint returns 502. Jordan must not reply from stale data or miss a hot lead.

**Goal:** See the failure, fix the URL, backfill missing replies, confirm Priya Sharma's thread is present, then draft a reply — nothing sends without OK.

---

## Trigger

Jordan opens **Monitoring → Webhooks** after a teammate says "inbox feels quiet."

---

## Journey (with failures)

1. **Webhooks list** — endpoint `https://hooks.acme.io/smartlead` shows **Failing** (3 of last 10 failed). Others healthy.
2. **Webhook detail** — delivery log: 502 errors, last success 6 hours ago. Banner: "Replies may not sync until fixed."
3. **Fix endpoint** — Jordan edits URL typo (`/smartled` → `/smartlead`), clicks **Send test event** → success toast.
4. **Inbox warning** — banner on Inbox: "Some replies may be missing — last sync 6h ago." Button **Sync missing replies**.
5. **Sync in progress** — progress bar, "Fetching 14 threads from SmartLead…" Cannot bulk-send while syncing.
6. **Thread recovered** — Priya Sharma thread appears with badge **Recovered**. Prior messages intact. Draft reply box empty.
7. **Needs your OK** — Jordan drafts reply; send button routes to approval queue (not instant send).

---

## Hard rules

1. Nothing sends without explicit user OK.
2. Webhook fix does not auto-replay failed payloads silently — user sees what was missed.
3. Sync is explicit (not background-only).
4. Recovered threads are labeled so user knows they were backfilled.
5. No new nav — lives under existing Monitoring and Inbox.

---

## Do not build

- Webhook payload schema editor
- Multi-endpoint load balancing
- Auto-retry cron configuration UI
- Client-scoped webhook permissions (agency-only for this brief)

---

## Screens (7)

| # | Screen ID | Title |
|---|---|---|
| 1 | WebhooksList | Monitoring · Webhooks |
| 2 | WebhookDetail | Webhook · delivery log |
| 3 | WebhookFix | Fix endpoint + test |
| 4 | InboxWarning | Inbox · sync banner |
| 5 | SyncProgress | Sync missing replies |
| 6 | ThreadRecovered | Thread · Priya Sharma |
| 7 | NeedsYourOk | Draft · needs approval |
