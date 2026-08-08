# UX Briefs — Harry the Marketer

One short brief per capability folder. Matching **WYRE wireform prototypes** live in [`prototypes/`](prototypes/).

Standing product rules (apply everywhere):

1. Nothing sends without the user's OK.
2. A new capability should not cost a new thing to think about — prefer existing surfaces.
3. No new nav items unless the brief says so (only Clients and Find prospects argue for new surface; Deliverability is one Monitoring section).

| Brief | Surface | Specs | Prototype |
|---|---|---|---|
| [analytics](analytics.md) | Reports / Dashboard | [`../analytics/`](../analytics/) | [`prototypes/analytics.wyre`](prototypes/analytics.wyre) |
| [campaign-statistics](campaign-statistics.md) | Campaign detail | [`../campaign-statistics/`](../campaign-statistics/) | [`prototypes/campaign-statistics.wyre`](prototypes/campaign-statistics.wyre) |
| [campaigns](campaigns.md) | Campaigns | [`../campaigns/`](../campaigns/) | [`prototypes/campaigns.wyre`](prototypes/campaigns.wyre) |
| [clients](clients.md) | Settings → Clients *(new)* | [`../clients/`](../clients/) | [`prototypes/clients.wyre`](prototypes/clients.wyre) |
| [email-account-tags](email-account-tags.md) | Mailboxes | [`../email-account-tags/`](../email-account-tags/) | [`prototypes/email-account-tags.wyre`](prototypes/email-account-tags.wyre) |
| [email-accounts](email-accounts.md) | Mailboxes | [`../email-accounts/`](../email-accounts/) | [`prototypes/email-accounts.wyre`](prototypes/email-accounts.wyre) |
| [inbox](inbox.md) | Inbox | [`../inbox/`](../inbox/) | [`prototypes/inbox.wyre`](prototypes/inbox.wyre) |
| [lead-lists](lead-lists.md) | Leads → segments | [`../lead-lists/`](../lead-lists/) | [`prototypes/lead-lists.wyre`](prototypes/lead-lists.wyre) |
| [lead-notes](lead-notes.md) | Inbox thread + Lead detail *(new panel)* | [`../lead-notes/`](../lead-notes/) | [`prototypes/lead-notes.wyre`](prototypes/lead-notes.wyre) |
| [lead-tags](lead-tags.md) | Leads | [`../lead-tags/`](../lead-tags/) | [`prototypes/lead-tags.wyre`](prototypes/lead-tags.wyre) |
| [lead-tasks](lead-tasks.md) | Inbox + Dashboard Action Center | [`../lead-tasks/`](../lead-tasks/) | [`prototypes/lead-tasks.wyre`](prototypes/lead-tasks.wyre) |
| [leads](leads.md) | Leads + Campaign leads | [`../leads/`](../leads/) | [`prototypes/leads.wyre`](prototypes/leads.wyre) |
| [smart-delivery](smart-delivery.md) | Monitoring → Deliverability | [`../smart-delivery/`](../smart-delivery/) | [`prototypes/smart-delivery.wyre`](prototypes/smart-delivery.wyre) |
| [smart-prospect](smart-prospect.md) | Leads → Find prospects *(new)* | [`../smart-prospect/`](../smart-prospect/) | [`prototypes/smart-prospect.wyre`](prototypes/smart-prospect.wyre) |
| [smart-senders](smart-senders.md) | Mailboxes → buy senders | [`../smart-senders/`](../smart-senders/) | [`prototypes/smart-senders.wyre`](prototypes/smart-senders.wyre) |
| [utilities](utilities.md) | Settings (+ invisible helper) | [`../utilities/`](../utilities/) | [`prototypes/utilities.wyre`](prototypes/utilities.wyre) |
| [webhooks](webhooks.md) | Settings / Campaign | [`../webhooks/`](../webhooks/) | [`prototypes/webhooks.wyre`](prototypes/webhooks.wyre) |

Each brief answer is only: **what job, where it lives, how it works, hard rules, what not to build.**

**View prototypes:** WYRE → `npm run dev` in `ReqOps/wireform` · HTML → [`HTML Prototype/index.html`](HTML%20Prototype/index.html) (28 pages)

Source of truth for contracts remains the per-endpoint specs. These briefs and wireforms only say how the UX fits together.
