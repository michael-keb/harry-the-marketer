# UX Brief: Smart delivery

**Job:** Check whether mail lands in inbox — one Monitoring section for every placement test and report.

**Lives on:** Monitoring → Deliverability. `list-tests` + `test-details` are the load-bearing shell; the other 26 endpoints render inside them.

## How it works

1. Open Monitoring → Deliverability — tests table (name, type, status, cadence in words, dates).
2. Run a manual or automated test; stop automated when done.
3. Open a test → detail is the report: providers, geo, senders, SPF/DKIM, blocklists, spam filters, content, schedule history.
4. Optional folders for organising tests; bulk delete when cleaning up.
5. Empty state: “No placement tests yet” + Run a test. No tests → section collapses to a quiet summary line.

## Hard rules

- One section, not 28 screens. No new nav item.
- Cadence in words; never show raw `null`.
- Provider IDs are invisible plumbing.
- Stale list beats a lying empty list when upstream is down.

## Do not build

- Deliverability as its own top-level app.
- One page per report type in the nav.
- Filter UIs that pretend the empty `{}` API bodies are fully specified server filters.

**Specs:** [`../smart-delivery/`](../smart-delivery/) · 28 endpoints
