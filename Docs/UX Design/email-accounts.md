# UX Brief: Email accounts

**Job:** Keep the sending fleet connected, healthy, warm, and usable — spot the mailbox that needs you.

**Lives on:** Mailboxes list + mailbox detail (warmup, suspend/unsuspend, settings).

## How it works

1. Open Mailboxes — working list, not a card gallery. Connection + health obvious per row.
2. Add via OAuth or SMTP; update settings on the row/detail.
3. Warmup settings + warmup stats on the same detail — not a separate product.
4. Suspend / unsuspend when a mailbox must stop sending without deleting it.
5. Filter by health/tag/usage against daily limit (same filter patterns as Leads).

## Hard rules

- No credential theatre beyond connect once; Harry does not store/log card or mailbox secrets from procurement.
- Tags list endpoint can be invisible plumbing — UI uses the shared tags surface.
- No new nav item.

## Do not build

- Per-provider mini-apps.
- Warmup as its own top-level section.

**Specs:** [`../email-accounts/`](../email-accounts/) · 11 endpoints
