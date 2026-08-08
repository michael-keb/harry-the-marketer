# UX Brief: Campaigns

**Job:** Turn a playbook into live outreach — attach mailboxes and leads, launch, steer, retire.

**Lives on:** Campaigns list + campaign detail (Mermaid playbook). Goals can create a linked draft.

## How it works

1. **New campaign** — name optional → land in the editor with a starter diagram.
2. Readiness strip shows what’s missing: playbook · mailbox · leads. Launch stays off until all three are done.
3. Attach mailboxes, attach leads (or a segment), set schedule/sequences/settings as later steps — not a create wizard.
4. Launch → drafts go to Inbox → Needs your OK. Nothing sends without approval.
5. Day-to-day: pause/resume leads, category, reply/forward (with confirm), duplicate, stop, delete.
6. Webhooks for that campaign sit under campaign settings, not a new destination.

## Hard rules

- Create is minimal (name only). Everything else is a separate step.
- Launch blocked until playbook valid + mailbox + leads.
- Suppression is unconditional; no “ignore unsubscribe” toggles.
- Status values: `START` / `PAUSED` / `STOPPED` (`ACTIVE` is wrong).
- No campaign created from a bare string name via list push.

## Do not build

- Multi-step create wizard.
- Implicit campaign creation from lead-list push.
- A compose screen that bypasses approval.

**Specs:** [`../campaigns/`](../campaigns/) · 42 endpoints
