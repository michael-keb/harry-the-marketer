# UX Brief: Lead tags

**Job:** Label people across campaigns so filtering and bulk work stay simple.

**Lives on:** Lead detail + Leads bulk action bar. Shared tags model with mailbox tags.

## How it works

1. On a lead (or multi-select), add/remove labels.
2. Create a label when needed from the same picker.
3. Table shows chips as read-only; editing stays on detail / bulk bar.
4. If the workspace has never created a label, the chip column stays gone.

## Hard rules

- One `tags` table keyed by workspace + applies_to + name.
- No standalone Tags destination in nav.

## Do not build

- Tag management as its own product area.
- Editable chip noise on every table cell.

**Specs:** [`../lead-tags/`](../lead-tags/) · 4 endpoints
