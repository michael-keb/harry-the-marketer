# UX Brief: Lead notes

**Job:** Capture what a human knows that the email thread does not — shared, internal, attributable.

**Lives on:** Inbox thread notes panel + Leads → lead detail (same component). **New panel**, not a new page.

## How it works

1. From a thread (or lead detail), write a short note — always obvious this is internal, not a reply.
2. Note saves against that campaign + lead pairing; shows author and time.
3. Whole workspace can read it; activity trail logs “note added” without copying the body.
4. Composer may use the note as context; it still cannot invent beyond it; draft still needs OK.

## Hard rules

- Visually distinct from the reply box — nobody mistakes a note for outbound mail.
- Plain text only; length counter before save.
- Empty → “No notes yet” with composer focused, not a blank void.

## Do not build

- Notes nav item or Notes CRM module.
- Notes that email the prospect.
- Dumping note bodies into the activity trail.

**Specs:** [`../lead-notes/`](../lead-notes/) · 2 endpoints · **New surface (panel)**
