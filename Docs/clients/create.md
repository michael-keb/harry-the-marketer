# Create Client

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/client/save` |
| **Category** | clients |
| **Source** | https://api.smartlead.ai/api-reference/clients/create |
| **Auth** | API key (query param `api_key`) |

Creates a separate, walled-off sub-account under your own account, so an agency can run outreach for one brand without its data touching another's.

## 1. Epic

**Agency client workspaces**

The epic lets one agency or consultant run Harry for several brands at once, each brand with its own leads, campaigns, mailboxes, inbox and reports, its own people, its own look, and its own allowance — while the agency keeps a single place to see them all. It matters because Harry's current Team model does the opposite by design: invite someone in Settings → Team and they share the one workspace, so an agency serving three clients today has no way to stop the third client's contact from reading the first client's inbox.

**Honest gap note:** Harry has no client concept at all. This epic is new build, not an adjustment. Everything below assumes a new `clients` table and a workspace scope threaded through the queries that currently scope on the owning user.

## 2. User story

**As an** agency owner using Harry for several brands, **I want** to create a client workspace with its own name, contact email and allowance, **so that** each brand's outreach is genuinely separate rather than separated by convention.

**Acceptance criteria**
- [ ] Given a `name` and a unique `email`, when a client is created, then a 200 returns `{ok: true, data: {id, name, email, created_at}}` and the new client appears in the agency's client list immediately.
- [ ] Given an `email` already used by another client or member, when creation is attempted, then a 422 names `email` as already in use and nothing is created.
- [ ] Given `permission` is supplied as an array such as `["campaigns", "email_accounts", "leads"]`, when the client is created, then only those areas are visible to that client's users, and an unknown permission string is rejected with 422 rather than silently ignored.
- [ ] Given `is_credit_assigned` is true, when `email_credits` and `lead_credits` are supplied, then those allowances are stored and shown on the client's card; given it is false, then the credit fields are ignored and the client draws on the agency pool.
- [ ] Given a `logo_url` or a base64 `logo`, when the client is created, then the branding is stored, and an unreachable URL or an oversized image is rejected with a field-level message rather than a broken image later.
- [ ] Given Smartlead's optional `password` field, when Harry implements this, then no password is ever accepted or stored — the client's people sign in through Auth0 exactly as members do today, and the API rejects a `password` field with 422 so nobody can build a habit of sending one.
- [ ] Given creation succeeds, when the agency looks at the activity trail, then one `events` row records who created the client, when, and with what permissions — with no credential material in it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email": "admin@acme.com", "name": "Acme Agency", "permission": ["campaigns","email_accounts","leads"], "is_credit_assigned": true, "email_credits": 10000, "lead_credits": 5000}` | 200, `data.id` present, `data.name` and `data.email` echoed, `created_at` set |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the form keeps its input and shows "Your session has expired" |
| TC-3 | Not found / wrong workspace | POST as a member who is not the agency owner | 403 for a member; a client id from another agency is invisible and returns 404 on any follow-up read |
| TC-4 | Validation failure | POST with `name` only | 422 with a field-level message naming `email` as required; the email input is marked |
| TC-5 | Rate limited | POST 20 creations in one second | 429 with `Retry-After`; the form disables Create and shows "Too many at once, try again in a moment" |
| TC-6 | Empty result set | Read the client list before any client exists | 200 with `data: []`; the agency view shows "No client workspaces yet" and one Create button |
| TC-7 | Duplicate email | Create the same email twice | Second attempt 422 naming `email`; exactly one client exists afterwards |
| TC-8 | Password rejected | POST with a `password` field | 422 naming `password` as not accepted, with the message pointing at Auth0 sign-in; nothing is stored |
| TC-9 | Bad permission string | POST with `permission: ["everything"]` | 422 naming the unknown permission and listing the valid ones |
| TC-10 | Oversized logo | POST a base64 `logo` above the size limit | 422 naming `logo` and stating the limit; no partial record is written |
| TC-11 | Credits without the flag | POST `email_credits: 10000` with `is_credit_assigned` false or absent | 200; credits are not applied and the response says the client draws on the agency pool |

## 4. Frontend user story

**As an** agency owner, **I want** a short form that creates a client workspace, **so that** onboarding a new brand takes one screen and no support ticket.

**Scope**
- Settings → Clients (a new section beside the existing Team section, visible only when the account has the agency capability): a list of client cards and a "New client" dialog with name, contact email, permissions as checkboxes, an optional logo, and an optional allowance.
- The permission checkboxes name Harry's real areas — Campaigns, Mailboxes, Leads, Inbox, Reports — not Smartlead's strings; the mapping happens on the server.
- Loading disables the submit and shows progress on the button; validation errors land on the field they belong to; a duplicate email is shown against the email field, not as a toast.
- No password field anywhere. The dialog explains in one line that the client's people sign in with their own email through the same Auth0 flow members use.
- Accessibility: a proper dialog with focus trapping, labelled inputs, errors tied to inputs by `aria-describedby`, and a full-width single-column layout on narrow screens.

**Definition of done**
- [ ] Creating a client returns to the list with the new card in place, no full reload.
- [ ] Every 422 field message renders against its field.
- [ ] The dialog cannot be submitted twice.
- [ ] The section is hidden entirely for accounts without the agency capability, not shown disabled.

## 5. Backend user story

**As a** Harry engineer, **I want** a client record and a workspace scope, **so that** every existing query can be told which brand's data it is allowed to see.

**Scope**
- Route: `POST /api/clients` in `server/routes.js`, owner-only, following the same body-validation and error shape as the existing settings routes. Smartlead reuses one `/client/save` path for create and update; Harry should keep create and update separate so the audit trail is unambiguous.
- Data model: new `clients` table (`id`, `owner_user_id`, `name`, `email`, `logo_url`, `permissions` JSON, `is_credit_assigned`, `email_credits`, `lead_credits`, `created_at`) plus a nullable `client_id` on `leads`, `campaigns`, `mailboxes` and `messages` in `server/db.js`, with a migration that leaves every existing row un-clienting so nothing changes for single-brand users.
- No password column, ever. Client users are ordinary Auth0 identities carrying a client scope; `server/auth.js` resolves the scope at session time.
- Rate limit creation on the settings bucket; 429 carries `Retry-After`. Email uniqueness is enforced by a database constraint, not just a check, so a race cannot create two.
- Logged to `events`: client created, by whom, with which permissions and allowance. Nothing credential-shaped is logged. Creation duration goes to `telemetry`.

**Definition of done**
- [ ] Migration is reversible and a no-op for existing single-brand workspaces.
- [ ] Every list query gains a client scope and is covered by a test proving cross-client reads return empty, not other brands' rows.
- [ ] A `password` field in the body returns 422.
- [ ] `events` shows the creation with no secret material.

## 6. End-to-end test ticket

**Title:** E2E — Create a client workspace

**Preconditions:** An agency-capable account with the agency capability on, no clients yet, and a second Auth0 test identity to act as the client's contact.

**Flow**
1. Sign in as the owner and open Settings → Clients.
2. Create a client named "Acme Agency" with contact `admin@acme.com`, permissions Campaigns and Leads only, and an allowance of 10,000 emails and 5,000 leads.
3. Attempt to create a second client with the same email.
4. Sign out and sign in as the client contact.
5. Back as the owner, open the activity trail.

**Assertions**
- [ ] After step 2 the client card appears with its name, email, two permission chips and its allowance.
- [ ] Step 3 fails with an error against the email field and no second card appears.
- [ ] The client contact sees only Campaigns and Leads, with Mailboxes, Inbox and Reports absent from navigation rather than present and blocked.
- [ ] The client contact sees no lead, campaign or message belonging to the agency's own workspace.
- [ ] The activity trail shows one creation entry naming the owner, the client and the permissions, and contains nothing password-shaped.

**Teardown:** Delete the client workspace and its scoped rows; remove the test Auth0 identity's session.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings | A Clients section beside Team, with cards and a create dialog | Medium | Hidden entirely unless the account is agency-capable, so the single-brand user never sees it |
| App shell | A client switcher in the header when more than one client exists | High | Only appears at two or more clients; renders as the current brand's name, one click to switch, nothing else |
| Every list page | Rows scoped to the current client | High | Scope is implied by the switcher, never a filter the user has to set; single-brand accounts see no change at all |

**Verdict:** New surface needed

There is nothing in Harry today to extend: Team deliberately shares one workspace, and a client is the opposite of that. The cost is contained by making the whole thing invisible below two clients — no switcher, no section, no scope language — so the ninety per cent of users running one brand see exactly the app they see now.
