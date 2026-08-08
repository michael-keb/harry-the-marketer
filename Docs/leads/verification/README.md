# leads — visual verification

11 endpoint specs. Regenerate with `npm run gallery`.

> A capture proves the surface renders with real data. Whether each spec's
> acceptance criteria are met is the **Verdict** column, from
> [../../REQUIREMENTS-MATRIX.md](../../REQUIREMENTS-MATRIX.md).

## Captures

### Leads — labels, segments, tasks, prospect search

Segments sidebar, derived stage strip, labels, and the Find-prospects pane.

**mobile**

![Leads — labels, segments, tasks, prospect search — mobile](./leads-mobile.png)

**desktop**

![Leads — labels, segments, tasks, prospect search — desktop](./leads.png)

### Command palette (⌘K) — searching across every kind of record

One search over leads, campaigns, segments, clients, labels, mailboxes and placement tests.

**1 closed**

![Command palette (⌘K) — searching across every kind of record — 1 closed](./command-palette-1-closed.png)

**2 open**

![Command palette (⌘K) — searching across every kind of record — 2 open](./command-palette-2-open.png)

**3 searching**

![Command palette (⌘K) — searching across every kind of record — 3 searching](./command-palette-3-searching.png)

## What the specs in this category are judged at

| Spec | Verdict | Notes |
|---|---|---|
| [Get All Leads Activities](../activities.md) | Not reviewed |  |
| [Add Leads to Campaign](../add-to-campaign.md) | Not reviewed |  |
| [Get Lead Categories](../categories.md) | Not reviewed |  |
| [Delete Lead from Campaign](../delete.md) | Not reviewed |  |
| [Get Campaign Leads](../get-by-campaign.md) | Not reviewed |  |
| [Get Lead by Email](../get-by-email.md) | Not reviewed |  |
| [Pause Lead](../pause.md) | Not reviewed |  |
| [Resume Lead](../resume.md) | Not reviewed |  |
| [Export Campaign Leads](../export.md) | Divergent | Registered as `GET /api/campaigns/:id/leads/export` (campaigns module owns it). Same capability, different path. |
| [Unsubscribe Lead Globally](../unsubscribe.md) | Partial | Transport-level suppression and the unified predicate are in. Still open: the footer unsubscribe (tracking.js) writes leads.status only — no unsubscribed_at, so Reports counts 0 — and leaves the draft pending. Four unsubscribe writers, three sets of consequences. |
| [Update Lead](../update.md) | Divergent | Spec names `POST /api/leads/:id`; implemented as `PATCH` — partial update, and `POST /leads` already creates. |
