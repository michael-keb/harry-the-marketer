# lead-tags — visual verification

4 endpoint specs. Regenerate with `npm run gallery`.

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

## What the specs in this category are judged at

| Spec | Verdict | Notes |
|---|---|---|
| [Add Tags to Lead](../add-to-lead.md) | Not reviewed |  |
| [Create Tag](../create.md) | Not reviewed |  |
| [Get Lead Tags](../get-all.md) | Not reviewed |  |
| [Remove Tag from Lead](../remove-from-lead.md) | Divergent | `DELETE /api/leads/tags` would be shadowed by routes.js's `DELETE /leads/:id`; moved to `/api/leads/tags/bulk`. Deliberate, commented at the route. |
