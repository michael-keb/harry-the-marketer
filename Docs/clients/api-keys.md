# Manage Client API Keys

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/client/api-key` |
| **Category** | clients |
| **Source** | https://api.smartlead.ai/api-reference/clients/api-keys |
| **Auth** | API key (query param `api_key`) |

Creates, lists, deletes and regenerates named API keys that let a client's own systems talk to their workspace without borrowing the agency's key.

## 1. Epic

**Agency client workspaces**

The epic lets one agency or consultant run Harry for several brands at once, each brand with its own leads, campaigns, mailboxes, inbox and reports, its own people, its own look, and its own allowance — while the agency keeps a single place to see them all. It matters because Harry's current Team model does the opposite by design: invite someone in Settings → Team and they share the one workspace, so an agency serving three clients today has no way to stop the third client's contact from reading the first client's inbox.

**Honest gap note:** Harry has no client concept at all. This epic is new build, not an adjustment. Everything below assumes a new `clients` table and a workspace scope threaded through the queries that currently scope on the owning user.

## 2. User story

**As an** agency owner, **I want** to issue named API keys scoped to one client, **so that** that client's CRM can push leads in without a key that would also reach every other brand I run.

**Acceptance criteria**
- [ ] Given a `clientId` and a `keyName`, when a key is created, then a 200 returns `{id, client_id, key_name, api_key, status: "active", created_at}` and the key value is shown exactly once, with a copy button and a line saying it will not be shown again.
- [ ] Given `keyName` contains anything other than letters, numbers, spaces, hyphens and underscores, when creation is attempted, then a 422 names `keyName` and states the allowed characters.
- [ ] Given keys exist, when the list is fetched with `clientId`, `status` (`active` or `inactive`) or a partial `keyName`, then only matching keys are returned, and no listing ever includes the secret value — only `id`, `key_name`, `status` and `created_at`.
- [ ] Given a key is deleted by id, when the delete succeeds, then any request using it fails with 401 immediately, and the deletion is written to the activity trail with who did it.
- [ ] Given a key is reset by id, when the reset succeeds, then the same key record keeps its id and name, the old value stops working at once, and the new value is shown once.
- [ ] Given a `clientId` outside the caller's account, when a key is created for it, then a 404 is returned and nothing hints that the client exists.
- [ ] Given a key has never been used, when the list renders, then it shows "Never used" rather than a blank, and a key unused for 90 days is marked so it can be cleaned up.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path create | POST `{"clientId": 301, "keyName": "Production Key"}` | 200, `data.id` present, `data.status` is `active`, `data.api_key` returned once in this response only |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the dialog keeps its input |
| TC-3 | Not found / wrong workspace | POST with a `clientId` from another agency | 404; no client name echoed, nothing created |
| TC-4 | Validation failure | POST `{"clientId": 301, "keyName": "prod/key!"}` | 422 naming `keyName` and the allowed character set |
| TC-5 | Rate limited | Create 20 keys in one second | 429 with `Retry-After`; the create button disables and explains |
| TC-6 | Empty result set | `GET /client/api-key?clientId=301` for a client with no keys | 200 with `data: []`; "No API keys for this client yet" and one Create button |
| TC-7 | Secret shown once | Create a key, then list keys | The create response contains `api_key`; the list response contains no secret field at all, only a masked prefix |
| TC-8 | Delete | `DELETE /client/api-key/45`, then call any endpoint with that key | Delete 200; the subsequent call 401; an activity-trail entry names the deleter |
| TC-9 | Reset | `PUT /client/api-key/reset/45`, then call with the old value and the new one | Same `id` and `key_name` returned; old value 401, new value 200 |
| TC-10 | Status filter | Create two keys, deactivate one, list with `status=active` then `status=inactive` | Each list returns exactly one key, and the two sets do not overlap |
| TC-11 | Name search | List with `keyName=prod` against keys named "Production Key" and "Staging" | Only "Production Key" is returned; matching is partial and case-insensitive |
| TC-12 | Cross-client use | Use client A's key to read client B's leads | 404, and one `events` row recording an out-of-scope attempt |

## 4. Frontend user story

**As an** agency owner, **I want** an API keys panel inside each client, **so that** I can hand a brand's engineer exactly the access they need and take it back without touching anything else.

**Scope**
- Settings → Clients → a client card's Detail view: an API keys table with name, status, created date, last used and per-row Reset and Delete actions.
- Creating a key opens a small dialog asking only for a name. The result screen shows the value once in a monospace field with a Copy button and a plain sentence: "This is the only time this value is shown. Store it in your password manager."
- Filters for status and a name search sit above the table only when there are more than a handful of keys.
- Reset and Delete both require a confirmation naming the key, and both say in plain English what will stop working.
- Loading disables the row's actions; empty shows "No API keys for this client yet"; error keeps the table and offers Retry.
- Accessibility: a real table with a caption, actions reachable by keyboard, confirmation dialogs with focus trapping, and the one-time secret announced as a live region so it is not missed. On narrow screens rows collapse to stacked cards.

**Definition of done**
- [ ] The secret value is never rendered outside the create and reset result screens.
- [ ] Copy uses the clipboard and confirms visibly.
- [ ] Reset and Delete confirmations name the key and state the consequence.
- [ ] Empty, filtered, loading and error states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** hashed, client-scoped API keys with create, list, delete and reset routes, **so that** programmatic access can be granted and revoked per brand without a shared secret.

**Scope**
- Routes in `server/routes.js`: `POST /api/clients/:clientId/api-keys`, `GET /api/clients/:clientId/api-keys?status&keyName`, `DELETE /api/api-keys/:id`, `POST /api/api-keys/:id/reset`. Owner-only; a client's own contact may list and reset their own keys but not another client's.
- Data model: new `client_api_keys` table (`id`, `client_id`, `key_name`, `key_hash`, `key_prefix`, `status`, `created_at`, `last_used_at`) in `server/db.js`. Only a hash is stored; the plaintext exists solely in the create or reset response body.
- Authentication middleware resolves an inbound key by prefix, verifies the hash, loads the client scope, and stamps `last_used_at` at most once a minute per key so the write does not become the bottleneck. An inactive or deleted key is 401, never 403.
- `keyName` is validated against the documented pattern (letters, numbers, spaces, hyphens, underscores). Rate limit key creation hard — this is a credential-minting route.
- Logged to `events`: creation, reset, deletion and any out-of-scope use, each with the actor, the key id and name, never the value. Key verification latency goes to `telemetry`.

**Definition of done**
- [ ] No route, log line, telemetry row or error message ever contains a key's plaintext value after the response that minted it.
- [ ] A deleted or reset key is rejected on the very next request, proved by a test.
- [ ] Client scoping is enforced in the middleware, so no individual route can forget it.
- [ ] `last_used_at` updates are throttled and covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Client-scoped API keys

**Preconditions:** An agency account with two clients, each holding a few leads, and a scriptable HTTP client for the API calls.

**Flow**
1. Sign in as the owner and open client A's detail view.
2. Create a key named "Production Key" and copy the value.
3. Use the key to read client A's leads, then client B's leads.
4. Reset the key and use both the old and new values.
5. Delete the key and use the new value.
6. Open the activity trail.

**Assertions**
- [ ] The value is shown exactly once, with the "only time" sentence and a working Copy button.
- [ ] Client A's leads read successfully; client B's read returns 404.
- [ ] After the reset the key keeps its name and row position, the old value fails with 401 and the new one works.
- [ ] After the delete the new value fails with 401 and the row is gone from the table.
- [ ] The activity trail shows create, reset, delete and the cross-client attempt, each naming the actor and none containing a key value.
- [ ] The table shows "Never used" before step 3 and a recent timestamp after it.

**Teardown:** Delete any remaining keys, then the two clients and their scoped rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Clients → client detail | An API keys table with create, reset and delete | Medium | Lives one level inside a client, so nobody who is not issuing keys ever sees it |
| Settings | No change to the existing Team section | Low | Keys belong to clients, not members; the two lists stay separate |
| Activity trail | Key lifecycle entries | Low | Same entry format as every other trail row |

**Verdict:** Fits an existing surface

This is a table inside a detail view that the client stories already create, so it costs no navigation. The care goes into the one-time reveal and the confirmations rather than the layout — a credential screen that is quiet and unambiguous is the whole job here.
