# UX Brief: Email account tags

**Job:** Label mailboxes so a large fleet can be filtered and assigned in bulk.

**Lives on:** Mailboxes — same page as the fleet. Shared `tags` table with lead tags (`applies_to`).

## How it works

1. On Mailboxes, select one or many rows (multi-select stays quiet until used).
2. Assign or remove tags in one action.
3. Create/rename tags from the same tagging UI — not a Tags admin island.
4. Filter the fleet by tag when attaching senders to a campaign.

## Hard rules

- One tags model for mailbox + lead labels; create/update are explicit routes (no silent upsert habit in Harry).
- Tagging UI only where the things being tagged already live.

## Do not build

- A standalone Tags page in nav.
- Different tag systems per feature.

**Specs:** [`../email-account-tags/`](../email-account-tags/) · 5 endpoints
