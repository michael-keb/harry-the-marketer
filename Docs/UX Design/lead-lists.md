# UX Brief: Lead lists

**Job:** Keep reusable segments of people, then push them into a real campaign when ready.

**Lives on:** Leads → segments (lists) + campaign “Attach leads” flow.

## How it works

1. Create / rename / delete a list; import leads into it.
2. Tag lists; move people between lists when the segment changes.
3. **Push to campaign** only onto an existing campaign that can actually run (playbook + mailbox rules still apply at launch).
4. Success state points at Inbox / campaign leads — not a celebration screen — because volume hits the approval queue.

## Hard rules

- Never create a campaign from a name string during push.
- Suppression stays on during import/push.
- Same action from segment menu and from campaign attach.

## Do not build

- Lists as a separate top-level product.
- “Quick campaign from list” that skips playbook readiness.

**Specs:** [`../lead-lists/`](../lead-lists/) · 9 endpoints
