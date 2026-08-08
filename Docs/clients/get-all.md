# Get All Clients

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/client/` |
| **Category** | clients |
| **Source** | https://api.smartlead.ai/api-reference/clients/get-all |
| **Auth** | API key (query param `api_key`) |

Lists every client sub-account under your own account, with each one's id, name, contact email and creation date.

## 1. Epic

**Agency client workspaces**

The epic lets one agency or consultant run Harry for several brands at once, each brand with its own leads, campaigns, mailboxes, inbox and reports, its own people, its own look, and its own allowance — while the agency keeps a single place to see them all. It matters because Harry's current Team model does the opposite by design: invite someone in Settings → Team and they share the one workspace, so an agency serving three clients today has no way to stop the third client's contact from reading the first client's inbox.

**Honest gap note:** Harry has no client concept at all. This epic is new build, not an adjustment. Everything below assumes a new `clients` table and a workspace scope threaded through the queries that currently scope on the owning user.

## 2. User story

**As an** agency owner, **I want** one list of every client workspace I run, **so that** I can switch between brands and see at a glance which one needs me today.

**Acceptance criteria**
- [ ] Given the account has clients, when the list is fetched, then a 200 returns `data` as an array of objects each carrying `id`, `name`, `email` and `created_at`, sorted newest first.
- [ ] Given the account has no clients, when the list is fetched, then `data` is `[]` and Settings → Clients shows "No client workspaces yet" with one Create button — not an empty table.
- [ ] Given the endpoint takes no parameters beyond the key, when the list is fetched, then no filter or paging control is offered on it; an agency with many clients gets client-side search over the returned list instead.
- [ ] Given a caller who is a member rather than the owner, when the list is fetched, then only the clients they have been given access to are returned, and the others are absent rather than listed and locked.
- [ ] Given the API key is missing or invalid, when the list is fetched, then the 401 `{"message": "Invalid API Key"}` is shown once as "Your session has expired" and the switcher falls back to the current client.
- [ ] Given a client was deleted, when the list is refetched, then it disappears and any pinned selection falls back to the agency's own workspace with a one-line explanation.
- [ ] Given two clients share a display name, when the list renders, then they remain distinguishable because selection is keyed on `id` and the contact email is shown as a subtitle.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed two clients. `GET /client/?api_key=...` | 200, `ok: true`, two objects with `id`, `name`, `email`, `created_at` matching the fixtures |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; "Your session has expired" shown once |
| TC-3 | Not found / wrong workspace | Call with a key belonging to a different agency | Only that agency's clients are returned; none of the first agency's clients appear |
| TC-4 | Validation failure | Call with a stray `clientId=abc` parameter | 422 or the parameter ignored; either way the list still renders and the UI never sends it |
| TC-5 | Rate limited | Call 30 times in one second by re-opening the switcher | 429; the switcher reuses its short cache and never blanks |
| TC-6 | Empty result set | Call on an agency with no clients | 200 with `data: []`; "No client workspaces yet" and one Create button |
| TC-7 | Many clients | Seed 200 clients | 200; the switcher offers type-ahead search rather than a 200-row menu |
| TC-8 | Duplicate names | Seed two clients both named "Acme" | Both listed with their contact emails as subtitles; selecting one is keyed on `id` |
| TC-9 | Deleted client | Delete a client that is currently selected, then refetch | It is absent from the list and the app falls back to the agency workspace with an explanation |
| TC-10 | Member scope | Call as a member with access to one of three clients | Exactly one client is returned; the other two are absent from the response, not just hidden in the UI |

## 4. Frontend user story

**As an** agency owner, **I want** a client switcher and a client list, **so that** moving between brands costs one click and never leaves me unsure which brand I am looking at.

**Scope**
- App shell header: a client switcher showing the current brand's name, appearing only when the account has two or more clients. It reads from this list and stores the selection so a reload lands in the same brand.
- Settings → Clients: the same list as cards, each with name, contact email, created date and a link into that client's workspace.
- Loading shows the switcher disabled with the last known name; empty hides the switcher entirely and shows the create prompt in Settings; error keeps the current selection and marks the switcher degraded.
- The current brand's name is also shown in the page title, so a tab left open overnight is not mistaken for the wrong brand.
- Accessibility: the switcher is a labelled combobox with type-ahead and keyboard operation, the current selection announced on change. On narrow screens it collapses to the brand's initial with the full name in the menu.

**Definition of done**
- [ ] The switcher is absent, not disabled, for accounts with fewer than two clients.
- [ ] The selected client survives a reload and is reflected in the document title.
- [ ] Search appears automatically above a threshold number of clients.
- [ ] Empty, error and single-client states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a scoped client list route, **so that** the switcher can be built without any page needing to know how client access is decided.

**Scope**
- Route: `GET /api/clients` in `server/routes.js`, returning only the clients the session may see — the agency owner's own, or the subset a member has been granted.
- Data model: none new beyond the `clients` table introduced by the create story; the query joins the member-access table so scope is decided in one place.
- No paging: the upstream contract has none, and an agency with hundreds of clients is served by returning a light row (`id`, `name`, `email`, `created_at`) and searching client-side. Rate limited on the settings bucket with `Retry-After` on 429.
- Telemetry: query duration and row count. Nothing logged to `events` — reading a list is not an auditable act here.

**Definition of done**
- [ ] Scope filtering is enforced in the query, not the response mapper, and is covered by a test using two agencies.
- [ ] The row shape is exactly the four light fields; no permissions, credits or branding leak into the list.
- [ ] An empty account returns `{ ok: true, data: [] }`.
- [ ] Response stays under the latency budget with 500 seeded clients.

## 6. End-to-end test ticket

**Title:** E2E — Client list and brand switcher

**Preconditions:** An agency account with three client workspaces, each holding one campaign and a handful of leads, plus one member granted access to only the second client.

**Flow**
1. Sign in as the owner.
2. Open the client switcher in the header.
3. Switch to the second client and open Leads.
4. Open Settings → Clients.
5. Sign out, sign in as the restricted member, and open the switcher.

**Assertions**
- [ ] The switcher lists three brands with their contact emails.
- [ ] After switching, Leads shows only the second client's leads and the page title names that brand.
- [ ] Settings → Clients shows three cards with matching names and created dates.
- [ ] The restricted member sees no switcher at all (one client) and lands directly in that client's workspace.
- [ ] Nothing belonging to the first or third client is visible to the member at any point.

**Teardown:** Delete the three clients and their scoped rows; revoke the member's access grant.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| App shell header | A client switcher | High | Appears only at two or more clients; single-brand users see the header exactly as it is today |
| Settings → Clients | A list of client cards | Low | Same card pattern as the existing Team member list |
| Page title | Prefixed with the current brand | Low | Text only, no chrome, and only when a client is selected |

**Verdict:** Fits an existing surface

The list itself is just the data behind the switcher, and the switcher is one control in a header that already exists. The honest risk is not this endpoint but the scope it implies everywhere else; keeping the switcher invisible below two clients means a single-brand user never pays for a capability they do not use.
