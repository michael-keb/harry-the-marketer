# Playbook workflow test plan

A hands-on rehearsal of every branch in the intro → follow-up → call playbook,
run entirely on a sandbox mailbox so nothing goes on the wire. Written for the
campaign shown in the Playbook tab:

```
flowchart TD
    S([Start]) --> A[Send: short intro …]
    A -- reply: interested --> B[Send: thanks — propose a 15-minute call …]
    A -- reply: question --> Q[Send: answer their question directly …]
    A -- reply: not now --> N[Wait: 30d]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 10m --> F[Send: one-line friendly nudge …]
    F -- reply: interested --> B
    F -- reply: question --> Q
    F -- no reply 45m --> L([Lost: no response])
    Q -- reply: interested --> B
    B -- reply: interested --> W([Won: call booked])
    B -- no reply 45m --> L
```

## How the rehearsal machinery works

- **Sandbox mailbox.** Connections → Email → Add mailbox → Sandbox. It records
  sends locally, ignores sending hours and the gap between sends, and is the
  only kind of mailbox that offers *Simulate a reply*. The daily limit still
  applies.
- **Engine tick.** The engine runs every 20 seconds. *Run engine now* on the
  campaign header forces one. Simulating a reply also triggers a tick.
- **Durations accept seconds.** `no reply 30s` is valid. Anything under ~20s
  lands on the next tick. For the rehearsal, shorten the three timers and
  restore them afterwards:

  | In the playbook | For the rehearsal |
  |---|---|
  | `A -- no reply 10m --> F` | `no reply 30s` |
  | `F -- no reply 45m --> L` | `no reply 40s` |
  | `B -- no reply 45m --> L` | `no reply 40s` |

- **Reply classification.** With an AI key set the model picks the intent.
  Without one (the dashboard says *template mode*) keyword rules apply, and the
  canned replies in the Simulate dialog are written to hit them:

  | Canned reply | Intent | Edge taken from A |
  |---|---|---|
  | Interested | interested | → B |
  | Question (contains `?`) | question | → Q |
  | Not now | not now | → N (Wait 30d) |
  | Unsubscribe | unsubscribe | → U |
  | Not interested | not interested | *no edge* — lead parks as **needs attention** |

- **Sandbox timing is not production timing.** A real mailbox enforces a
  randomised gap of at least 45s between sends (`MIN_GAP_MS`, server/pacing.js)
  and its daily cap spreads a large cohort over days — 165 leads at 50/day means
  the last intro leaves on day 4, and each lead's `no reply` clock starts from
  *its own* send, not from Start. Second-scale timers only behave on the
  sandbox; treat every rehearsal duration as "sandbox-only shorthand".
- **Approval.** Decided on the campaign's Settings tab. With it **on**, every
  send stops in Inbox → *Needs your OK* until you approve; with it **off** the
  send leaves on the next tick. Run the suite with it off, then re-run one case
  with it on (case 9).
- **Where to look after each step.**
  - Leads tab → open the lead: current step and state (active / waiting /
    needs attention / finished, with outcome).
  - Activity tab: `sent`, `reply`, `branched`, `awaiting_approval`,
    `needs_attention`, `finished` events with the edge that fired.
  - Inbox: the thread, with the simulated reply and the agent's next email.
  - Schedule tab: when the next send is projected.

## Setup (once)

1. Connections → Email → Add mailbox → **Sandbox**.
2. Campaign → Sending from: attach the sandbox mailbox.
3. Campaign → Settings: approval **off** for the first pass. Leave hours as
   they are; the sandbox ignores them.
4. Playbook tab: shorten the three timers as above. Save. The page should still
   say *Playbook is valid*; the warning about `Q` is expected (see case 8).
5. Leads tab: at least six leads, one per branch below. Sandbox addresses are
   fine (`alex@example.test` etc.). Leads that reach Won, Lost, or Unsubscribed
   are finished; to reuse one, remove it from the campaign and re-attach it, or
   duplicate the campaign (Manage → Duplicate) for a clean copy.
6. Press **Start**.

## Cases

Each case starts from a fresh lead at A. "Wait for the timer" means wait the
rehearsal duration plus one tick (about a minute at most).

| # | Path | Steps | Expected |
|---|---|---|---|
| 1 | Happy path: A → B → W | Tick. Lead gets the intro. Simulate **Interested**. Tick. Simulate **Interested** again on the B email. | Lead finishes **Won: call booked**. Activity shows `sent A`, `reply`, `branched A → B`, `sent B`, `reply`, `branched B → W`, `finished won`. Inbox thread has intro, reply, proposal, reply. |
| 2 | Question first: A → Q → B → W | Simulate **Question** on the intro. Tick. Simulate **Interested** on the Q email. Simulate **Interested** on B. | Lead goes A → Q → B → Won. The Q email answers the question, then proposes a call. |
| 3 | Not now: A → N | Simulate **Not now** on the intro. | Lead state **waiting** at N with a wait-until 30 days out. Nothing else is sent. (N has no outgoing edge, so after 30 days the engine finishes the lead as *completed*; if you want re-engagement, add `N --> A2[Send: …]`.) |
| 4 | Unsubscribe: A → U | Simulate **Unsubscribe** on the intro. | The machine never opts someone out on its own reading: the lead parks as **needs attention** ("reads like an unsubscribe — confirm it"). Confirm it from the Inbox; only then does the lead finish **Unsubscribed** and the address appear under Settings → Never contact. Re-attaching the lead to any campaign must not send to it. |
| 5 | Silent lead: A → F → L | Send nothing back. Wait for the A timer. Wait for the F timer. | After the first timer: `branched A → F`, nudge sent, thread has two outbound emails. After the second: lead finishes **Lost: no response**. |
| 6 | Late interest: A → F → B → W | Let the A timer fire. Simulate **Interested** on the nudge. Simulate **Interested** on B. | F → B → Won. Confirms replies to the follow-up route the same as replies to the intro. |
| 7 | Question on the nudge: A → F → Q → B | Let the A timer fire. Simulate **Question** on the nudge. Simulate **Interested** on Q. | F → Q → B. Then either finish with Interested (Won) or let the B timer fire (Lost). |
| 8 | Q with no reply (the warning) | Reach Q (case 2 or 7). Send nothing back. Wait well past every timer. | Lead stays **waiting** at Q forever. This is the warning on the Playbook tab; fix it with `Q -- no reply 45m --> L` and re-run to see the lead go Lost instead. |
| 9 | Approval gate | Settings → approval **on**. Fresh lead. Tick. | No email leaves. Inbox → *Needs your OK* holds the intro; Dashboard *Needs you* counts it. Edit the subject, approve. Next tick sends **that** draft (your edit is in the sent email), and the A timer starts from the send, not from the approval. Turn approval off again. |
| 10 | Unmatched intent | Simulate **Not interested** on the intro. | No edge matches, so the lead parks as **needs attention** with the intent recorded. Dashboard *Needs you → Decisions* lists it. Resume it from the lead drawer to confirm it can be moved on by hand. |
| 11 | Proposal ignored: B → L | Reach B (case 1, stop before the second reply). Send nothing. Wait for the B timer. | Lead finishes **Lost: no response** from B, not from F. |
| 12 | Timer restarts on each send | Reach F. Note the projected time on the Schedule tab. | The F → L timer counts from when the nudge was sent, not from the intro. The projected Lost time is nudge-sent-time plus the F timer. |
| 13 | Two leads, independent clocks | Start two leads a minute apart. Reply to one, ignore the other. | Each lead follows its own branch and its own timers; the reply on one never moves the other. |
| 14 | Restart after Start/Stop | Mid-case 5, press **Stop**, wait past a timer, press **Start**. | Nothing sends while stopped. On Start the lead resumes where it was; a timer that expired while stopped fires on the first tick. |
| 15 | Daily limit on the sandbox | Set the sandbox mailbox's daily limit to **3**. Start three fresh leads. Tick. | Two intros go out — the last ~30% of the day's allowance is **reserved for follow-ups**, so a limit of 3 allows 2 fresh approaches. The third waits with the reserve named on the campaign header, and goes when you raise the limit and tick (or the next day). |
| 16 | Two replies before one tick | Reach A. Simulate **Question**, then immediately simulate **Interested**, before the next tick. Tick a few times. | The lead branches on the **older** reply first (Question → Q), then on the newer one at whatever node it has reached. No stale reply re-branches the lead out of order. |
| 17 | Hand-corrected intent sticks | Reach A, simulate a reply the rules will misread (or any reply), then reclassify the intent by hand from the lead drawer before the tick classifies it. Tick a few times. | The lead follows **your** intent's edge and stays there; no later tick re-runs the classifier and re-routes it. |
| 18 | Ladder never fires out of order | Give one node two timers, `no reply 30s --> F` and `no reply 2m --> G`. Send nothing. | The 30s edge fires first, always. G is only ever reached via its own elapsed 2m — never at 30s. If adaptive timing shifts due times before the freeze elapses, the lead re-freezes rather than firing an undue edge. Also: if the campaign's Behaviour reply-timeout is set, it **replaces both durations** — leave it unset when the playbook authors a ladder. |
| 19 | Edit the playbook mid-wait | Reach F with the timer running. **Pause the campaign** (a running sequence is edit-locked), edit an unrelated part of the playbook, save, resume. Then pause again, delete F, save, resume. | The first save must not move the lead — `wait_until` froze when it entered F. The second save parks the lead as **needs attention** ("the step no longer exists"), never silently restarts or resends. |
| 20 | Two mailboxes rotate | Attach a second sandbox mailbox. Start four fresh leads. Tick until all intros are out, then drive one lead to a follow-up. | Intros spread across both mailboxes by remaining daily capacity. Every follow-up in a thread leaves from the **same** mailbox that sent the intro — a conversation never changes sender. |

## Pass criteria

- Every terminal node is reached by at least one lead: Won (1), Lost (5 and 11), Unsubscribed (4).
- Every labelled edge fires at least once: `interested` from A, F, Q and B; `question` from A and F; `not now`; `unsubscribe`; all three `no reply` timers.
- The Activity tab explains every transition with a `branched` event naming the edge.
- Nothing is sent to a Won, Lost, or Unsubscribed lead afterwards (tick a few more times and check the thread).
- Approval on holds every send; approval off sends on the next tick.
- A hand-corrected intent survives later ticks (case 17), and no lead is ever
  branched twice for one human interaction (case 16).

## Afterwards

- Restore `10m`, `45m`, `45m` in the playbook and save.
- Decide whether to fix the two design gaps the rehearsal exposes: `Q` has no
  timeout (case 8) and `N` never re-engages (case 3).
- Detach the sandbox mailbox and attach the real one before the campaign goes
  to real leads.
- Before a real cohort: check Behaviour's reply-timeout override is **unset**
  if the playbook authors a no-reply ladder (it replaces every rung with one
  duration), and do the throughput arithmetic — cohort size ÷ daily cap gives
  the date the last intro leaves, and every timer counts from that lead's own
  send.
