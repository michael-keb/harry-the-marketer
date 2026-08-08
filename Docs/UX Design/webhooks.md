# UX Brief: Webhooks

**Job:** Tell an external URL when Harry events happen — connect tools in two minutes.

**Lives on:** Settings (workspace webhooks) + campaign webhook block where campaign-scoped hooks already live.

## How it works

1. Paste endpoint URL; tick events in plain English.
2. Save / update / delete from the same collapsed block.
3. Default: one quiet line when unused — users who never integrate see almost nothing.
4. Failed deliveries can be retriggered from the campaign webhook tools already specified under campaigns.

## Hard rules

- Event names in plain English.
- Collapsed by default; no integration theatre for non-integrators.
- No new nav item.

## Do not build

- A Webhooks product area with dashboards.
- Developer-console chrome for marketers who only need a URL + checkboxes.

**Specs:** [`../webhooks/`](../webhooks/) · 4 endpoints
