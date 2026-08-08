# UX Brief: Utilities

**Job:** Controls that sit outside a playbook — mainly the global domain block list. One-off send is internal only.

**Lives on:** Settings (block list). Send-single-email has **no compose UI**.

## How it works

1. Settings → see/edit domains Harry will never email.
2. List fills mostly from unsubscribes/bounces; user adds the few they care about.
3. Blocked domains show as a quiet chip where suppression already surfaces — not a new badge system.
4. `send-single-email` is a shared internal function for callers that must park a draft when approvals are on — never a free compose screen.

## Hard rules

- No compose UI for one-off send (that would bypass “nothing sends without OK”).
- Block list is readable and editable; not invisible magic only.

## Do not build

- A Utilities nav dump.
- One-off email composer.
- Duplicate suppression UIs per campaign.

**Specs:** [`../utilities/`](../utilities/) · 2 endpoints
