# smart-prospect — visual verification

26 endpoint specs. Regenerate with `npm run gallery`.

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
| [Cities API](../cities.md) | Not reviewed |  |
| [Company API](../company.md) | Not reviewed |  |
| [Countries API](../countries.md) | Not reviewed |  |
| [Departments API](../departments.md) | Not reviewed |  |
| [Domain API](../domain.md) | Not reviewed |  |
| [Fetched Searches API](../fetched-searches.md) | Not reviewed |  |
| [Find Emails API](../find-emails.md) | Not reviewed |  |
| [Get Contacts API](../get-contacts.md) | Not reviewed |  |
| [Head Counts API](../head-counts.md) | Not reviewed |  |
| [Industries API](../industries.md) | Not reviewed |  |
| [Job Title API](../job-title.md) | Not reviewed |  |
| [Keywords API](../keywords.md) | Not reviewed |  |
| [Levels API](../levels.md) | Not reviewed |  |
| [Recent Searches API](../recent-searches.md) | Not reviewed |  |
| [Reply Analytics API](../reply-analytics.md) | Not reviewed |  |
| [Revenue API](../revenue.md) | Not reviewed |  |
| [Review Contacts API](../review-contacts.md) | Not reviewed |  |
| [Save Search API](../save-search.md) | Not reviewed |  |
| [Saved Searches API](../saved-searches.md) | Not reviewed |  |
| [Search Analytics API](../search-analytics.md) | Not reviewed |  |
| [Search Contacts API](../search-contacts.md) | Not reviewed |  |
| [States API](../states.md) | Not reviewed |  |
| [Sub-Industries API](../sub-industries.md) | Not reviewed |  |
| [Update Fetched Lead API](../update-fetched-lead.md) | Not reviewed |  |
| [Update Saved Search API](../update-saved-search.md) | Not reviewed |  |
| [Fetch Contacts API](../fetch-contacts.md) | Verified | Credit failure handled as HTTP 200 + `success:false`, stored as `insufficient_credits`. Covered by tests. |
