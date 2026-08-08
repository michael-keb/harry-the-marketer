# UX Brief: Analytics

**Job:** See whether outreach is working across the whole workspace — one honest picture, not two pages arguing.

**Lives on:** Dashboard KPI tiles + Reports. Same numbers, same date range.

## How it works

1. Open Reports (or Dashboard) and pick a date range.
2. See overview: sent, replies, positives, health at a glance.
3. Drill by campaign, mailbox, provider, day, or team board — same filters, same axes.
4. Empty range says “nothing in this window,” not fake zeros that look like failure.

## Hard rules

- One aggregate feeds Dashboard and Reports so they cannot disagree about the same week.
- Filters stay quiet; default view is unfiltered overview.
- No new nav item.

## Do not build

- A separate Analytics app or second chart language.
- Per-metric settings screens.
- Client-vs-agency pivots that belong in Clients (scope), not here.

**Specs:** [`../analytics/`](../analytics/) · 22 endpoints
