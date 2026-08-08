# Domain Block List Management

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/leads/get-domain-block-list` |
| **Category** | utilities |
| **Source** | https://api.smartlead.ai/api-reference/utilities/domain-block-list |
| **Auth** | API key (query param `api_key`) |

Lists the email addresses and whole domains that must never be contacted, along with why each one was blocked, and lets you add to or remove from that list.

## 1. Epic

**Sending controls outside the playbook**

The epic covers the two things a Harry workspace needs that no Mermaid diagram describes: a list of addresses and domains that must never be emailed no matter which campaign picks them up, and a way to send a single email outside any playbook. It matters because both are safety questions — one stops Harry contacting someone it should not, and the other is an escape hatch that must never become a way around the standing rule that nothing sends without the user's OK.

## 2. User story

**As a** marketer, **I want** a suppression list of addresses and domains Harry will never contact, **so that** a competitor, a former client or a bounced address cannot be reached again by any campaign, including ones I have not written yet.

**Acceptance criteria**
- [ ] Given the list is fetched, when it returns, then it is an array of objects each carrying `id`, `email_or_domain`, `created_at`, `source` and `client_id`, and the UI shows the source in plain words ("Added by you", "Bounced", "Unsubscribed").
- [ ] Given `offset` and `limit` are used, when the list is paged, then `limit` defaults to 100 and values outside 1–1000 return a 422 `{"error": "Limit must be between 1 and 1000"}` rather than being silently clamped.
- [ ] Given `filter_email_or_domain=example.com` is supplied, when the list is fetched, then only matching entries are returned and the search box shows what was matched.
- [ ] Given a bare domain such as `competitor.com` is added, when any lead at that domain is about to be emailed, then the send is blocked, the lead is marked blocked with the reason, and the block is written to the activity trail — the engine must never send first and record afterwards.
- [ ] Given `domain_block_list` is posted as an array of domains and addresses, when it is saved, then a `{"success": true, "message": "3 entries added to block list"}` shape is returned and duplicates are ignored rather than counted twice.
- [ ] Given `domain_block_list` is not an array, when it is posted, then a 422 `{"error": "domain_block_list must be an array"}` names the field and nothing is added.
- [ ] Given an entry is deleted by `id`, when the delete succeeds, then a `{"success": true}` is returned; given the id does not exist, then a 404 `{"error": "Block list entry not found"}` is returned.
- [ ] Given a lead's own domain is the user's own sending domain, when it is added to the list, then the addition is refused with a clear explanation, because blocking your own domain would break reply handling.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path list | Seed three blocked entries. `GET ...?offset=0&limit=100` | 200; an array of three objects with `id`, `email_or_domain`, `created_at`, `source`, `client_id` |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the list shows "Your session has expired" |
| TC-3 | Not found / wrong workspace | Delete an `id` belonging to another workspace | 404 `{"error": "Block list entry not found"}`; the other workspace's entry is untouched |
| TC-4 | Validation failure | `GET` with `limit=5000` | 422 `{"error": "Limit must be between 1 and 1000"}`; the UI never requests above 1000 |
| TC-5 | Rate limited | Type quickly in the search box so 30 requests fire in a second | 429 avoided by debouncing; if it occurs, one backoff retry and the previous rows stay |
| TC-6 | Empty result set | Call on a workspace with nothing blocked | 200 with `[]`; "Nothing is blocked yet" and an Add box, not an empty table |
| TC-7 | Add | POST `{"domain_block_list": ["competitor.com", "spam@example.com"], "client_id": null}` | 200 `{"success": true, "message": "2 entries added to block list"}`; both appear with source "Added by you" |
| TC-8 | Duplicate add | Post the same domain twice | The second add reports zero new entries; exactly one row exists |
| TC-9 | Domain blocks its leads | Block `competitor.com`, then launch a campaign containing `ana@competitor.com` | No email is sent to that lead; the lead shows as blocked with the reason, and one activity-trail entry explains it |
| TC-10 | Bounce source | Force a hard bounce on a sandbox mailbox | The address appears with source "Bounced" without anyone adding it, and the lead is excluded from further sends |
| TC-11 | Remove | Delete an entry, then run the campaign again | The previously blocked lead becomes eligible again and the removal is in the activity trail |
| TC-12 | Search | Search `example.com` against entries `spam@example.com` and `other.com` | Only the first is returned; matching covers both bare domains and addresses at that domain |

## 4. Frontend user story

**As a** marketer, **I want** one place to see and edit everything Harry will never email, **so that** compliance and common sense are a list I can read rather than a rule I have to trust.

**Scope**
- Settings → Sending: a "Never contact" block listing entries with what is blocked, why (Added by you / Bounced / Unsubscribed), and when. Paste-many-at-once input accepting a mix of addresses and domains, one per line or comma-separated.
- The Leads page shows a blocked lead with the same stage chip vocabulary it already uses, and its reason on hover, so a lead that is not being contacted is never a mystery.
- Search over the list appears once there are more than a handful of entries; paging follows the same infinite-scroll pattern as Leads.
- Loading shows skeleton rows; empty reads "Nothing is blocked yet"; error keeps loaded rows and offers Retry. Removing an entry asks for confirmation naming what will become contactable again.
- Accessibility: a real table with a caption, the paste box a labelled textarea with format help, and per-row remove buttons that name the entry in their accessible label. On narrow screens rows collapse to two lines.

**Definition of done**
- [ ] Adding accepts a pasted mixture of addresses and domains and reports how many were new.
- [ ] A blocked lead's reason is visible on the Leads page without opening anything.
- [ ] Removal is confirmed and explains the consequence.
- [ ] Empty, search, error and paging states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** the block list enforced in the mailer rather than in each campaign, **so that** no future code path can send to a suppressed address by forgetting a check.

**Scope**
- Routes in `server/routes.js`: `GET /api/block-list?offset&limit&search`, `POST /api/block-list`, `DELETE /api/block-list/:id`. Smartlead's `filter_client_id` is not modelled until Harry has clients; `filter_email_or_domain` and `filter_email_with_domain` collapse to one `search`.
- Data model: new `block_list` table (`id`, `user_id`, `value`, `is_domain`, `source`, `created_at`) in `server/db.js`, with a unique constraint on workspace plus normalised value so duplicates cannot exist. Existing unsubscribes and hard bounces are backfilled into it as sources, since Harry already honours both.
- Enforcement lives in `server/mailer.js`, immediately before dispatch, checking both the exact address and its domain. A blocked send is not an error: the lead is marked blocked, the campaign continues with the next lead, and one `events` row explains it.
- `limit` is validated to 1–1000 and returns 422 outside it, matching the upstream contract exactly. Rate limited on the settings bucket.
- Logged: additions, removals and each prevented send to `events`; counts of prevented sends to `telemetry` so Monitoring can show the list is doing something.

**Definition of done**
- [ ] Enforcement is in the mailer, proved by a test that calls the send path directly with a blocked address.
- [ ] Domain entries match subdomains consistently, one way, and that behaviour is documented in the UI's format help.
- [ ] Existing unsubscribes and bounces appear in the list after the migration.
- [ ] A blocked lead never produces a draft awaiting approval, so the Inbox is not polluted with emails that could never be sent.

## 6. End-to-end test ticket

**Title:** E2E — Never contact a blocked address or domain

**Preconditions:** A workspace with one campaign, a sandbox mailbox, and six leads including `ana@competitor.com`, `spam@example.com` and one address that will be forced to hard bounce.

**Flow**
1. Sign in and open Settings → Sending.
2. Paste `competitor.com` and `spam@example.com` into the "Never contact" box and save.
3. Launch the campaign and let the engine tick.
4. Open the Inbox and the Leads page.
5. Force the hard bounce on the remaining address and let the engine tick again.
6. Remove `competitor.com` from the list and rerun the campaign.

**Assertions**
- [ ] Step 2 reports two entries added, both with source "Added by you".
- [ ] After step 3 no draft exists for either blocked lead, and no email reaches them.
- [ ] The Leads page shows both as blocked with the reason visible.
- [ ] After step 5 the bounced address is added automatically with source "Bounced".
- [ ] After step 6 the competitor lead becomes eligible again and a draft appears in the Inbox awaiting approval — never sent automatically.
- [ ] The activity trail explains every block and both list changes.

**Teardown:** Clear the block list entries created by the run, delete the campaign, leads and messages, clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Sending | A "Never contact" list with a paste box | Low | One block in a section that already governs sending behaviour; collapsed to a count until opened |
| Leads | A blocked stage chip with a reason | Low | Reuses the existing stage-chip vocabulary; no new column |
| Monitoring | A prevented-sends count in the existing telemetry | Low | One number beside delivery telemetry |

**Verdict:** Fits an existing surface

This is not invisible plumbing — a suppression list is something users need to read and edit — but it is a small block in a settings section that already exists, plus one chip on a page that already has chips. Harry already honours unsubscribes and bounces, so most of what fills this list arrives on its own and the user only ever adds the handful of names they care about.
