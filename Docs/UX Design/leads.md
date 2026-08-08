# UX Brief: Leads

**Job:** The person record and its lifecycle in outreach — find, update, pause, resume, unsubscribe, export.

**Lives on:** Leads page + campaign’s lead list (same list component, campaign-scoped when inside a campaign).

## How it works

1. Browse/filter leads (stage strip + engagement/date filters shared with campaign view).
2. Open a lead: profile, activity, category, tags, notes, tasks.
3. Add to campaign / remove from campaign; pause or resume sending for that pairing.
4. Global unsubscribe is a deliberate, confirmed action.
5. Export from the campaign (or equivalent) when a CSV is needed.
6. Activities feed the trail; categories power Inbox intent chips.

## Hard rules

- Same list UX on Leads and on campaign leads — one component to learn.
- Suppression unconditional on unsubscribe.
- Update is partial and safe; no silent cross-workspace leaks.

## Do not build

- A second CRM with different stages for “campaign leads.”
- Lifecycle controls buried only in API-shaped screens.

**Specs:** [`../leads/`](../leads/) · 11 endpoints
