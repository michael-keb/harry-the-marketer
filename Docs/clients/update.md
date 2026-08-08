# Update Client

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/client/save` |
| **Category** | clients |
| **Source** | https://api.smartlead.ai/api-reference/clients/update |
| **Auth** | API key (query param `api_key`) |

Changes an existing client sub-account — its name, contact email, branding, permissions or allowance — by sending its `id` back to the same endpoint that creates one.

## 1. Epic

**Agency client workspaces**

The epic lets one agency or consultant run Harry for several brands at once, each brand with its own leads, campaigns, mailboxes, inbox and reports, its own people, its own look, and its own allowance — while the agency keeps a single place to see them all. It matters because Harry's current Team model does the opposite by design: invite someone in Settings → Team and they share the one workspace, so an agency serving three clients today has no way to stop the third client's contact from reading the first client's inbox.

**Honest gap note:** Harry has no client concept at all. This epic is new build, not an adjustment. Everything below assumes a new `clients` table and a workspace scope threaded through the queries that currently scope on the owning user.

## 2. User story

**As an** agency owner, **I want** to change a client's name, contact, permissions and allowance after it exists, **so that** a brand renaming itself or buying more capacity does not mean recreating a workspace.

**Acceptance criteria**
- [ ] Given a body containing `id`, `email` and `name`, when the client is saved, then a 200 returns `{ok: true, data: {id, name, email}}` and the card updates in place with no page reload.
- [ ] Given `id` is present, when the request is sent, then it must be treated as an update and never fall through to creating a second client — a missing or unknown `id` returns 404 rather than quietly creating one.
- [ ] Given `permission` is reduced, when the change is saved, then any of that client's people currently signed in lose the removed areas on their next navigation, and the removal is written to the activity trail with who did it.
- [ ] Given `email_credits` or `lead_credits` is lowered below what the client has already used, when the change is saved, then it is accepted, the client is shown as over its allowance, and sending is paused for that client with a clear reason rather than silently failing mid-campaign.
- [ ] Given `email` is changed to one already in use, when the change is saved, then a 422 names `email` and nothing changes.
- [ ] Given Smartlead's optional `password` field, when Harry implements this, then a `password` in the body is rejected with 422 — client sign-in stays with Auth0 and Harry never holds a credential.
- [ ] Given only some fields are sent, when the change is saved, then untouched fields keep their values and the response reflects the merged record, not a half-blank one.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"id": 301, "email": "admin@acme.com", "name": "Acme Agency Updated", "email_credits": 20000}` | 200, `data.name` is the new name; the card updates in place |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the edit dialog keeps its input |
| TC-3 | Not found / wrong workspace | POST with an `id` belonging to another agency, then a non-existent `id` | 404 both times; nothing is created and no name is echoed back |
| TC-4 | Validation failure | POST `{"id": 301}` with no `email` or `name` | 422 with field-level messages on both; the dialog marks both inputs |
| TC-5 | Rate limited | Save 20 times in one second | 429 with `Retry-After`; Save disables briefly and the last saved state is kept |
| TC-6 | Empty result set | Save with a body identical to the stored record | 200 with an unchanged record and no activity-trail entry for a no-op change |
| TC-7 | Missing id | POST a full body with no `id` | Harry returns 422 naming `id`; it never creates a duplicate client the way one shared save path could |
| TC-8 | Duplicate email | Change client A's email to client B's | 422 naming `email`; both clients keep their original addresses |
| TC-9 | Permission removal | Remove `email_accounts` from a client whose contact is signed in | On their next navigation Mailboxes is gone from their nav; an activity-trail entry names the owner and the removed area |
| TC-10 | Allowance below usage | Set `email_credits` to 100 on a client that has sent 900 | 200; the client shows "Over allowance" and its campaigns pause with a stated reason, not a silent send failure |
| TC-11 | Password rejected | POST a `password` field | 422 naming `password`; nothing stored, nothing logged |

## 4. Frontend user story

**As an** agency owner, **I want** to edit a client from its card, **so that** changing a brand's details is the same two clicks as changing anything else in Settings.

**Scope**
- Settings → Clients: an Edit action on each client card opening the same dialog used to create one, prefilled. The only difference is the title and the presence of a "Danger" area for allowance changes that would put the client over its limit.
- Permission checkboxes are the same Harry-named areas as the create dialog; removing one shows a plain-language confirmation naming who will lose what.
- Loading disables Save with progress on the button; 422 messages land on their fields; a no-op save closes without pretending anything happened.
- Accessibility: focus returns to the card's Edit button on close, errors are tied to inputs by `aria-describedby`, and the confirmation for permission removal is a dialog with a labelled description, not a bare browser confirm.

**Definition of done**
- [ ] The create and edit dialogs are one component with one set of tests.
- [ ] Removing a permission requires an explicit confirmation naming the affected area.
- [ ] An over-allowance save shows the consequence before it is committed.
- [ ] The card updates in place with no list refetch.

## 5. Backend user story

**As a** Harry engineer, **I want** update to be its own route rather than a shared save, **so that** an update can never be mistaken for a create and the audit trail stays unambiguous.

**Scope**
- Route: `PATCH /api/clients/:id` in `server/routes.js`, owner-only, replacing Smartlead's overloaded `POST /client/save`. A body carrying an `id` on the create route returns 422 pointing at the update route.
- Data model: none new beyond the `clients` table from the create story. Partial updates merge; unspecified fields are untouched.
- Email uniqueness is enforced by the same database constraint as create. Permission changes take effect on the next session refresh, so `server/auth.js` must reread the client scope rather than trust a cached one.
- Rate limited on the settings bucket. Logged to `events`: which fields changed, old and new values for permissions and allowance, and who changed them — with no credential material. An allowance breach writes one `events` row and pauses the client's queue via the existing pacing path in `server/pacing.js`.

**Definition of done**
- [ ] A create body containing `id` is rejected, proved by a test.
- [ ] Partial update merges correctly and is covered by a test that sends one field.
- [ ] Permission removal is reflected within one session refresh.
- [ ] An over-allowance client's campaigns pause with a reason visible on the campaign page.

## 6. End-to-end test ticket

**Title:** E2E — Edit a client workspace

**Preconditions:** An agency account with two clients; client A has Campaigns, Mailboxes and Leads permissions, a contact who can sign in, an allowance of 1,000 emails and 900 already sent.

**Flow**
1. Sign in as the owner and open Settings → Clients.
2. Edit client A: rename it and remove the Mailboxes permission, confirming the warning.
3. Lower client A's email allowance to 100 and save.
4. Attempt to change client A's contact email to client B's.
5. Sign in as client A's contact.

**Assertions**
- [ ] The card shows the new name immediately with no list refetch.
- [ ] Client A's contact no longer sees Mailboxes in navigation.
- [ ] Client A shows "Over allowance" and its running campaign says it is paused and why.
- [ ] Step 4 fails with an error on the email field and both clients keep their addresses.
- [ ] The activity trail records the rename, the permission removal and the allowance change, each naming the owner, and contains nothing password-shaped.

**Teardown:** Restore client A's permissions and allowance, or delete both clients and their scoped rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Clients | An Edit action on each card reusing the create dialog | Low | One dialog, two titles; nothing new to learn after creating a client once |
| Campaign detail | A paused banner when the client is over its allowance | Low | Reuses the existing "why is this campaign holding" banner from `server/pacing.js` |
| App shell | The switcher reflects a renamed client | Low | Data-only change |

**Verdict:** Fits an existing surface

Everything here rides on the surface the create story already pays for. The one genuinely new piece of UI is the over-allowance state, and that reuses the banner Harry already shows when a campaign is holding, so a paused client reads like every other pause rather than a new kind of failure.
