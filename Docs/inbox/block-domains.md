# Block Email Domains

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/block-domains` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/block-domains |
| **Auth** | API key (query param `api_key`) |

Adds one or more email domains to a workspace-wide block list so no campaign ever emails an address at those domains again.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** workspace owner, **I want** to block a domain from all outreach in one action, **so that** a company that has asked us to stop, or a domain that only ever bounces, is never emailed again by any campaign.

**Acceptance criteria**
- [ ] Given a list of one or more domains, when I block them, then every one is recorded on the workspace block list with the blocking `source` (`manual`, `bounce`, `complaint`, or `invalid`) and a `blocked_at` timestamp, and the response confirms which domains were blocked.
- [ ] Given an empty `domains` array, when I submit, then the request is rejected with a field-level message on `domains` ("must contain at least 1 domain") and nothing is written.
- [ ] Given a blocked domain, when the engine next reaches a `Send:` node for a lead at that domain, then no email is composed or queued and the lead is finished as blocked with the reason visible in the activity trail.
- [ ] Given a blocked domain, when a draft for a lead at that domain is already sitting in Needs your OK, then approving it is refused with "This domain is blocked" rather than sending.
- [ ] Given a domain already on the block list, when I block it again, then the call succeeds without creating a duplicate entry.
- [ ] Given a hard bounce or a spam complaint on a lead, when the mailer records it, then that lead's domain may be blocked automatically with `source: bounce` or `source: complaint`, and the automatic origin is distinguishable from a manual block in the UI.
- [ ] Given a blocked domain, when the owner unblocks it, then future sends to that domain resume and the unblock is written to the activity trail with the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, several domains | Block `["spam.com", "invalid.com"]` with `source: manual` | 200, `success: true`, `data.blocked_domains` lists both, `data.source` is `manual`, `data.blocked_at` is an ISO timestamp |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; block list unchanged |
| TC-3 | Wrong workspace | Block a domain, then read the block list as a member of another workspace | The domain is not visible or enforced there; each workspace has its own list |
| TC-4 | Validation failure — empty array | POST `{"domains": []}` | 422, `{"error": "domains array must contain at least 1 domain"}`; the field is highlighted in the dialog |
| TC-5 | Rate limited | Fire a burst of block requests | 429 on the excess; client backs off with jitter and shows one "Retrying…" state |
| TC-6 | Empty result set | Open the block list on a workspace that has never blocked anything | 200 with an empty list; empty state reads "No domains blocked" with an add action |
| TC-7 | Malformed domain | Block `["not a domain", "http://example.com/path"]` | 422 with a per-value message; valid entries in the same batch are not silently written |
| TC-8 | Idempotent re-block | Run TC-1 twice | Second call 200, list still contains each domain exactly once |
| TC-9 | Enforcement on a live campaign | Block the domain of a lead in a running campaign, then let the engine tick | No email is composed for that lead; the lead is marked blocked and the campaign continues for others |
| TC-10 | Enforcement on a pending draft | Block a domain with a draft already in Needs your OK, then press Approve | Approve is refused with "This domain is blocked"; the draft is removed from the queue rather than sent |
| TC-11 | Subdomain handling | Block `example.com`, then add a lead at `mail.example.com` | Documented behaviour is applied consistently and shown in the UI ("exact domain only" or "includes subdomains"), never ambiguous |

## 4. Frontend user story

**As a** workspace owner, **I want** a block list I can add to from Settings and directly from a reply, **so that** shutting a company out of our outreach takes one click at the moment I decide it.

**Scope**
- Settings gains a "Blocked domains" section: a table of domain, source (Manual / Bounce / Complaint / Invalid), who blocked it, when, and an Unblock action. An "Add domains" dialog takes one domain per line so a paste of several works.
- Inbox → Replies thread view gains a "Block this domain" action in the thread's overflow menu, pre-filled with the sender's domain and defaulting to `source: manual`. A confirmation states how many current leads it will stop.
- Leads page shows a "Blocked" marker on any lead whose domain is on the list, so the reason a lead never gets contacted is visible where the lead lives.
- Loading: skeleton rows. Empty: "No domains blocked — nothing is being held back." Error: inline banner in the dialog with the typed domains preserved.
- Accessibility: the dialog is a labelled modal with focus trap and Escape to close; source is text, never colour alone; the destructive confirmation names the count of affected leads. Responsive: the table collapses to stacked rows under 640px.

**Definition of done**
- [ ] Domains can be added from Settings and from a thread, and unblocked from Settings.
- [ ] The affected-lead count in the confirmation matches what actually stops.
- [ ] Automatic blocks (bounce, complaint) appear in the same table, labelled by source.
- [ ] Loading, empty, validation-error and permission-denied states are all designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a workspace-scoped domain block list that the engine and mailer both consult, **so that** a block is enforced everywhere rather than only in the place it was set.

**Scope**
- Routes in `server/routes.js`, following the existing workspace-scoped pattern: `POST /api/blocked-domains` taking `{ domains: [], source }`, `GET /api/blocked-domains`, `DELETE /api/blocked-domains/:domain`.
- Data model: a `blocked_domains` table in `server/db.js` (`workspace_id`, `domain` normalised to lowercase, `source`, `blocked_by`, `created_at`) with a unique constraint on (`workspace_id`, `domain`) so re-blocking is idempotent.
- Enforcement: `server/engine.js` skips `Send:` nodes for leads whose domain is blocked and finishes them with a blocked outcome; `server/mailer.js` refuses at dispatch as a second gate; the approval route refuses with a clear message so an already-composed draft cannot slip through.
- Automatic blocking: hard bounce and spam-complaint handling writes an entry with `source: bounce` / `source: complaint`, capped so a single noisy domain cannot flood the table.
- No pagination needed at workspace scale; the list is cached in memory per workspace and invalidated on write so the engine does not hit SQLite on every send.
- Logged: an `events` row per block and unblock with actor, domain, source and affected lead count; `telemetry` counts sends prevented by domain block so Monitoring can show it.

**Definition of done**
- [ ] Table and unique constraint created; domains normalised before comparison.
- [ ] Engine, mailer and approval route all consult the list, each covered by a test.
- [ ] Cross-workspace isolation is asserted by a test.
- [ ] Blocks and unblocks appear in the activity trail with the actor.

## 6. End-to-end test ticket

**Title:** E2E — Block a domain and prove nothing further is sent to it

**Preconditions:** A workspace with a sandbox mailbox, one running campaign, three leads at `example.com` and three at `other.com`, approvals on (the default), one draft already waiting for a lead at `example.com`.

**Flow**
1. Open Inbox → Replies and open a thread from a lead at `example.com`.
2. Choose "Block this domain" and confirm; note the affected-lead count shown.
3. Open Settings → Blocked domains and confirm `example.com` is listed as Manual with your name.
4. Open Inbox → Needs your OK and try to approve the waiting `example.com` draft.
5. Let the engine tick twice.
6. Open Leads and filter to the blocked marker.

**Assertions**
- [ ] The confirmation named three affected leads and the block list shows `example.com` with source Manual.
- [ ] Approving the waiting draft is refused with "This domain is blocked" and the draft leaves the queue unsent.
- [ ] After the ticks, no message rows exist for any `example.com` lead and all three carry the Blocked marker on Leads.
- [ ] The three `other.com` leads continue normally, proving the block is scoped to the domain.
- [ ] The activity trail contains one block entry naming the actor and the domain.

**Teardown:** Unblock `example.com`, delete the test leads and campaign, reset the sandbox mailbox counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings | New "Blocked domains" section with a table and add dialog | Low | Sits with the other list-style settings; hidden behind an existing section header |
| Inbox → Replies thread | One extra item in the thread overflow menu | Low | Goes in the existing menu, not a new button on the thread header |
| Leads | A "Blocked" marker on affected rows | Low | Reuses the existing stage-marker treatment; no new column |
| Monitoring | A "sends prevented by domain block" counter | Low | One more line in the existing delivery telemetry list |

**Verdict:** Fits an existing surface

Harry already has a per-lead unsubscribe path, but nothing that stops a whole company at once, so the capability is genuinely new; the places to put it are not. Settings already holds workspace-wide lists and the thread already has an overflow menu, so no navigation item is added and a user who never blocks a domain sees nothing change.
