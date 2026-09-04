# Campaign Playbook — What Happens Today vs What Will Happen After the Fixes

A plain-language map of how a lead moves through a campaign playbook, showing
the six problems we found and how each one will behave once fixed.
**Red = broken today. Green = how it will work after the fix.** Everything
else stays exactly as it is.

## The six problems, in one sentence each

1. **The "switch to SMS" step can fire days too early.** A lead who was
   supposed to get an email follow-up on day 3 and an SMS on day 7 can get the
   SMS on day 3 — and never get the email at all.
2. **Your corrections don't stick.** When you re-label a reply the AI misread
   (say it called "ok thanks" an unsubscribe), the AI can quietly overrule you
   on the next pass and route the lead its own way.
3. **Send-time windows get skipped on repeat visits.** If a playbook loops a
   lead back to a step with a "send between 9:00–11:00" window, the second
   visit ignores the window and sends immediately.
4. **Adding an email step to an SMS-only campaign breaks it.** The editor lets
   you save it, and every lead who reaches that step gets stuck with a cryptic
   computer error instead of a clear message.
5. **Some playbook shapes make leads wait forever, silently.** No email, no
   error, no alert — the lead just sits there and nobody is told.
6. **Two quick replies can move a lead twice.** If someone sends two messages
   close together, the playbook can branch once for each — in the wrong order.

---

## Today: how a lead moves through the playbook

```mermaid
flowchart TD
    A[An email or SMS goes out] --> B[Lead waits at this step]
    B --> C{Did they reply?}

    C -- "Yes" --> D[AI reads the reply<br/>and picks what it means]
    D --> P2[/"PROBLEM 2<br/>If you corrected the AI's reading,<br/>your correction can be overruled"/]:::bug
    P2 --> E[Lead moves down the<br/>matching branch]
    D --> P6[/"PROBLEM 6<br/>Two quick replies can move<br/>the lead twice, newest first"/]:::bug

    C -- "No — waiting on a timer" --> F{Has the follow-up<br/>timer run out?}
    F -- "Not yet" --> B
    F -- "Yes" --> P1[/"PROBLEM 1<br/>The SMS-switch step can jump<br/>the queue and fire days early"/]:::bug
    P1 --> G[Lead moves to the<br/>follow-up step]

    B --> P5[/"PROBLEM 5<br/>A few playbook shapes leave the<br/>lead stuck here forever —<br/>silently, with no alert"/]:::bug

    G --> H{Is the next step<br/>a send?}
    H -- "Yes" --> P3[/"PROBLEM 3<br/>If the lead has been at this step<br/>before, its send-time window<br/>is ignored — sends right away"/]:::bug
    P3 --> P4[/"PROBLEM 4<br/>Email step inside an SMS-only<br/>campaign: lead gets stuck with<br/>a cryptic error"/]:::bug
    P4 --> A

    classDef bug fill:#8a1f1f,stroke:#d64545,color:#ffffff
```

---

## After the fixes: the same journey, working properly

```mermaid
flowchart TD
    A[An email or SMS goes out] --> B[Lead waits at this step]
    B --> C{Did they reply?}

    C -- "Yes" --> D[AI reads the reply<br/>and picks what it means]
    D --> F2[/"FIX 2<br/>Your correction always wins —<br/>the AI never overrules a person"/]:::fix
    F2 --> E[Lead moves down the<br/>matching branch]
    D --> F6[/"FIX 6<br/>Replies handled oldest-first —<br/>one conversation, one move"/]:::fix

    C -- "No — waiting on a timer" --> F{Has the follow-up<br/>timer run out?}
    F -- "Not yet" --> B
    F -- "Yes" --> F1[/"FIX 1<br/>Every step waits for its own<br/>timer — the SMS switch can<br/>never jump the queue"/]:::fix
    F1 --> G[Lead moves to the<br/>follow-up step]

    B --> F5[/"FIX 5<br/>Stuck-forever shapes are refused<br/>when you save the playbook, and<br/>a stuck lead un-sticks itself"/]:::fix

    G --> H{Is the next step<br/>a send?}
    H -- "Yes" --> F3[/"FIX 3<br/>The send-time window is honoured<br/>every visit, not just the first"/]:::fix
    F3 --> F4[/"FIX 4<br/>The editor refuses an email step<br/>in an SMS-only campaign — and if<br/>one slips through, you get a plain<br/>explanation, not a computer error"/]:::fix
    F4 --> A

    classDef fix fill:#1f5c33,stroke:#3fa864,color:#ffffff
```

---

## What does NOT change

The audit confirmed all of this works correctly today, and the fixes leave it
alone:

- Editing a playbook never disturbs a lead already mid-wait.
- Runaway loops are stopped (a lead can never be emailed endlessly).
- Unsubscribes always win over every other rule.
- The AI can *suggest* someone wants to unsubscribe but can never act on it —
  only a person or the recipient's own click can.
- A conversation always keeps the same sender address, and mailbox rotation
  spreads volume properly.
- Temporary failures (a Gmail hiccup, a network blip) retry on their own.

## Suggested order of work

| Order | Fix | Why this order |
|-------|-----|----------------|
| 1st | #2 corrections stick, #6 one reply = one move | Tiny changes, protect the human's work first |
| 2nd | #1 SMS switch can't jump the queue | The worst thing a real lead could experience |
| 3rd | #3 windows honoured every visit | Timing correctness |
| 4th | #4 email-step-in-SMS-campaign refused | Stops a stranding error at the door |
| 5th | #5 stuck-forever shapes refused / self-heal | Broadest change (editor + engine) |

## For developers — where each fix lands

| # | Fix | Files |
|---|-----|-------|
| 1 | Only fire edges whose own timer elapsed; if none are due, re-schedule instead of firing early | `server/engine.js` (`pickNoReplyEdge`, `processWaiting`) |
| 2 | Make `parseDbTime` handle ISO timestamps (returns NaN today, killing the human-override guard) | `server/engine.js:38` |
| 3 | Invalidate the sticky step slot when a step fires, so a revisit rolls a fresh in-window time | `server/step-timing.js` |
| 4 | Re-check channel-mode vs send-node channels on every playbook save; null-guard the mailbox in the engine's email branch | `server/parity/campaigns.js`, `server/engine.js` |
| 5 | Parser rejects labeled edges off wait/start nodes and decisions before any send; engine self-heals an empty wait clock and falls back to enrolment time for timers | `server/playbook.js`, `server/engine.js` |
| 6 | Classify unprocessed replies oldest-first | `server/engine.js:1302` |

Full technical detail: [AUDIT-CAMPAIGN-GRAPH-2026-09-04.md](./AUDIT-CAMPAIGN-GRAPH-2026-09-04.md).
Hands-on regression rehearsals for #1, #2, #6: cases 16–18 in the
[playbook workflow test plan](./campaigns/playbook-workflow-test-plan.md).
