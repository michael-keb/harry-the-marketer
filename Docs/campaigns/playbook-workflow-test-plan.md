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
| 4 | Unsubscribe: A → U | Simulate **Unsubscribe** on the intro. | Lead finishes **Unsubscribed**. The address appears under Settings → Never contact. Re-attaching the lead to any campaign must not send to it. |
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
| 15 | Daily limit on the sandbox | Set the sandbox mailbox's daily limit to 2. Start three fresh leads. Tick. | Two intros go out, the third waits with *daily limit reached* on the campaign header, and goes the next day (or when you raise the limit and tick). |

## Pass criteria

- Every terminal node is reached by at least one lead: Won (1), Lost (5 and 11), Unsubscribed (4).
- Every labelled edge fires at least once: `interested` from A, F, Q and B; `question` from A and F; `not now`; `unsubscribe`; all three `no reply` timers.
- The Activity tab explains every transition with a `branched` event naming the edge.
- Nothing is sent to a Won, Lost, or Unsubscribed lead afterwards (tick a few more times and check the thread).
- Approval on holds every send; approval off sends on the next tick.

## Afterwards

- Restore `10m`, `45m`, `45m` in the playbook and save.
- Decide whether to fix the two design gaps the rehearsal exposes: `Q` has no
  timeout (case 8) and `N` never re-engages (case 3).
- Detach the sandbox mailbox and attach the real one before the campaign goes
  to real leads.
