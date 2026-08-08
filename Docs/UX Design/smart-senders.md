# UX Brief: Smart senders

**Job:** Buy sending infrastructure (domains / mailboxes) without Harry ever touching card details.

**Lives on:** Mailboxes → buy / order flow (search domain → generate → order summary → confirm).

## How it works

1. Search domains / pick vendor options from Mailboxes procurement entry.
2. Auto-generate mailbox suggestions; review order summary (what + cost) before confirm.
3. Place order with explicit confirm + idempotency — no surprise charge path.
4. Order details and purchased domain list live in the same Mailboxes context.
5. OTP for admin mailbox when needed — shown once, not stored as a habit in UI chrome.

## Hard rules

- Harry never collects or stores card numbers.
- Mailbox credentials pass through once; no store, no log, no auto-enter later.
- This is the only money-spend flow — confirm is mandatory.

## Do not build

- A separate “Marketplace” nav world.
- Saved cards inside Harry.
- Silent re-orders.

**Specs:** [`../smart-senders/`](../smart-senders/) · 7 endpoints
