# smart-delivery — visual verification

28 endpoint specs. Regenerate with `npm run gallery`.

> A capture proves the surface renders with real data. Whether each spec's
> acceptance criteria are met is the **Verdict** column, from
> [../../REQUIREMENTS-MATRIX.md](../../REQUIREMENTS-MATRIX.md).

## Captures

### Monitoring — inbox placement in one section

The 28-endpoint deliverability category as one Monitoring section, with the 9 unverified upstream contracts stated openly.

**desktop**

![Monitoring — inbox placement in one section — desktop](./monitoring.png)

## What the specs in this category are judged at

| Spec | Verdict | Notes |
|---|---|---|
| [IP Blacklist Check](../blacklists.md) | Not reviewed |  |
| [Create Folder](../create-folder.md) | Not reviewed |  |
| [Delete Folder](../delete-folder.md) | Not reviewed |  |
| [Delete Tests in Bulk](../delete-tests-bulk.md) | Not reviewed |  |
| [DKIM Details](../dkim-details.md) | Not reviewed |  |
| [Domain Blacklist](../domain-blacklist.md) | Not reviewed |  |
| [Geo-wise Report](../geo-report.md) | Not reviewed |  |
| [Get Folder by ID](../get-folder-by-id.md) | Not reviewed |  |
| [Get All Folders](../get-folders.md) | Not reviewed |  |
| [IP Blacklist Count](../ip-blacklist-count.md) | Not reviewed |  |
| [IP Details](../ip-details.md) | Not reviewed |  |
| [List All Tests](../list-tests.md) | Not reviewed |  |
| [Mailbox Count](../mailbox-count.md) | Not reviewed |  |
| [Mailbox Summary](../mailbox-summary.md) | Not reviewed |  |
| [Get Provider IDs](../provider-ids.md) | Not reviewed |  |
| [Provider-wise Report](../provider-report.md) | Not reviewed |  |
| [rDNS Report](../rdns-report.md) | Not reviewed |  |
| [Email Reply Headers](../reply-headers.md) | Not reviewed |  |
| [Schedule History](../schedule-history.md) | Not reviewed |  |
| [Sender Account List](../sender-list.md) | Not reviewed |  |
| [Sender Account Report](../sender-report.md) | Not reviewed |  |
| [Spam Filter Report](../spam-filter-report.md) | Not reviewed |  |
| [SPF Details](../spf-details.md) | Not reviewed |  |
| [Get Spam Test Details](../test-details.md) | Not reviewed |  |
| [Test Email Content](../test-email-content.md) | Not reviewed |  |
| [Create Automated Placement Test](../create-automated-test.md) | Fixed — verified | Runs open on schedule with a claiming UPDATE; due-ness measured from the last run so downtime is caught up once, not replayed per tick. |
| [Create Manual Placement Test](../create-manual-test.md) | Fixed — verified | Seed sends actually happen, through mailer.sendEmail so suppression/quota/pacing apply. Marked `test` so they move no campaign figure. With no seeds it reports `seedsQueued: 0, awaitingSeeds: true` rather than promising work it will not do. |
| [Stop Automated Test](../stop-automated-test.md) | Partial | Still no `type` guard — a one-off manual test can be 'stopped'. |
