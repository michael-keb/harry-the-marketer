# UX Brief: Clients

**Job:** Agency runs several brands with walled data — each brand’s leads, campaigns, mailboxes, inbox, and reports stay separate.

**Lives on:** Settings → Clients *(new section, agency-capable accounts only)* + header client switcher when ≥2 clients.

## How it works

1. Owner opens Settings → Clients (hidden for single-brand accounts).
2. New client: name, contact email, permission checkboxes (Harry areas), optional logo/allowance. **No password field** — Auth0 only.
3. Client card appears; switcher shows current brand name, one click to switch.
4. Every list page is scoped to the current client — scope is implied by the switcher, never a filter to set.
5. Client users only see permitted nav areas; other brands’ rows never appear.

## Hard rules

- Invisible below two clients: no switcher, no section, no scope language for single-brand users.
- Reject `password` always.
- Permissions map to Harry areas (Campaigns, Mailboxes, Leads, Inbox, Reports), not vendor strings.

## Do not build

- Clients as a top-level app.
- Per-page “client filter” controls.
- Separate credential system.

**Specs:** [`../clients/`](../clients/) · 4 endpoints · **New surface**
