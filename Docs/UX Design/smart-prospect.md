# UX Brief: Smart prospect

**Job:** Find people who match the ICP, preview before spending credits, then fetch usable emails into Leads.

**Lives on:** Leads → **Find prospects** *(new two-pane)*; same preview can sit under Goals → Refine audience.

## How it works

1. Open Find prospects: filters left, preview right.
2. Tune filters; debounced search shows **count + sample**. Huge counts read as scale (“about 16 million”) and discourage fetch until narrowed.
3. Preview emails are marked not usable. Paging is “Show more” (cursor), not page numbers.
4. Confirm credits → fetch real contacts → review / save search / push into a list or campaign path Harry already has.
5. Lookups (industries, titles, geos, etc.) only feed the filter form — no separate lookup UIs.

## Hard rules

- Preview ≠ paid contacts. Fetch is the spend step with confirmation.
- Credit failure can be HTTP 200 + `success: false` — handle honestly.
- `filter_id` stays server/session-side; user never manages it.
- No new top-level nav beyond the Leads entry that owns discovery.

## Do not build

- A standalone Prospecting product with its own IA.
- Numbered pagination against a cursor API.
- Treating preview addresses as sendable.

**Specs:** [`../smart-prospect/`](../smart-prospect/) · 26 endpoints · **New surface**
