# Playbook DSL — what the graph needs to carry

## Where we are

The playbook grammar today ([server/playbook.js](./server/playbook.js)) understands exactly two
things:

- **Node labels** — `Send: <free text instruction>`, `Wait: <duration>`, `Start`, terminals, decisions
- **Edge labels** — `reply: <intent>`, `reply`, `no reply 3d`, `after 2h`

That's the whole vocabulary. Every other decision the engine makes is either hard-coded or absent:

| Behaviour | Where it lives today |
|---|---|
| When an email actually goes out | Immediately on the next tick — no send window, no jitter |
| How fast we reply to a reply | Instantly, next tick (~the giveaway that it's automated) |
| Daily volume | `mailboxes.daily_limit`, one global number per mailbox |
| Attachments | Do not exist — no schema, no send path, no syntax |
| Tone / length / language | Buried in the free-text instruction, per node |
| Branch conditions | Reply intent and elapsed time only |
| Loop safety | None — `N --> A2 --> ... --> N` can cycle forever |

So the question isn't only "what variables do we want" — it's "where do they attach", because the
diagram has to stay valid Mermaid that renders in the live preview.

## Recommended syntax

Three places for configuration, each earning its keep:

**1. Node modifiers — inline, semicolon-separated, after the instruction**

```
A[Send: short intro email; delay 2h-6h; attach case-study.pdf]
F[Send: follow-up; window mon-fri 9-16; tone brief]
```

Safe with the current parser (it reads to the closing `]`) and Mermaid renders it fine. Keeps the
per-step config visible in the picture, which is the whole premise of the product. Cost: long labels
make wide boxes — mitigate by keeping modifier names short.

**2. Edge conditions — extend the existing label grammar**

```
A -- reply: interested --> B
A -- opened, no reply 4d --> F
A -- if: title ~ "VP|Head" --> X
A -- 50% --> B1
```

**3. Campaign defaults — a `%%` config header**

```
%% config: timezone lead; window mon-fri 8-18; daily 40; warmup 10+5/day; reply-delay 20m-3h
```

Mermaid treats `%%` as a comment and ignores it, so the diagram stays clean. Campaign-wide settings
(send windows, caps, warmup) aren't per-node and shouldn't bloat every box. Node modifiers override
the header.

> **One grammar, four consumers.** The parser, the validator, the "Generate with AI" prompt, and the
> Syntax help panel must all read from a single spec. Today the AI generator can only emit what it
> was prompted with; every keyword added below is dead unless it lands in that prompt too. Define the
> grammar as data (a keyword table) and generate the AI prompt and the help text from it.

---

## The variable surface

### Tier 1 — needed for the product to feel human and not get the mailbox burned

**Timing realism**
- `delay 20m-3h` — randomised pause before acting on a detected reply. The single biggest tell that
  a human isn't on the other end is a reply that lands 4 seconds after theirs.
- `window mon-fri 9-17` — only send inside business hours.
- **Whose hours?** Lead timezone vs mailbox timezone. Needs `leads.timezone` (inferrable from country
  or company domain) plus a `timezone lead|mailbox|Australia/Sydney` setting.
- **Jitter on every send** — 200 leads must not all fire at 09:00:00. Spread across the window.
- `not-before 2026-09-01` / campaign start and end dates.
- **Blackout dates** — public holidays, your own leave, the Christmas dead zone.
- **Minimum thread gap** — a floor on how close two emails to the same person can be, regardless of
  what the graph says. Protects against a badly drawn loop hammering someone.

**Volume and deliverability**
- **Warmup ramp** — a new mailbox at 40/day gets flagged. `warmup 10+5/day` = start at 10, add 5 a day.
- **Per-domain throttle** — don't hit six people at the same company on the same day.
- **Bounce circuit breaker** — auto-pause the campaign above a bounce or complaint rate.
- **Suppression list** — global do-not-contact, enforced before any send.
- **Cross-campaign dedupe** — the same person queued in two campaigns should not get two sequences.
- **Mailbox rotation** — spread volume across several connected mailboxes.

**Loop safety** (this one is a live bug, not a feature)
- `max-sends 6` per lead, `max-days 45` per lead, max visits per node. The default playbook's
  `N --> A2` re-engage path can already cycle; nothing stops it.

### Tier 2 — content control

**Attachments** — needs schema (`assets` table), storage, an upload UI, and a send path change:
- `attach case-study.pdf` on a node
- Conditional attachment — only on the `reply: question` branch
- Gmail's 25MB ceiling; and a deliverability caveat worth surfacing in the UI: **attachments on a
  first cold email measurably hurt inbox placement.** Better default is a link; make attaching a
  deliberate act on later nodes.

**Message shape**
- `tone brief|warm|formal`, `length short|medium`
- `lang en|de` — locale per lead
- `subject new` — break out of the thread and start a fresh subject line (re-engage steps often want this)
- `cc`, `bcc`, `reply-to` — e.g. cc an account exec at handoff
- `signature full|minimal`, `track off` (some recipients' gateways flag tracked links)
- `meeting-link` insertion — already threaded through `composeEmail`, should be a node-level toggle

### Tier 3 — richer branching

Right now a branch can only be "what did they say" or "how long has it been". Add:

- **Lead attributes** — `if: title ~ "VP|Head"`, `if: company_size > 200`. Route by segment inside
  one playbook instead of cloning campaigns.
- **Engagement signals** — `opened`, `clicked`, `opened 3x`. [server/tracking.js](./server/tracking.js)
  already issues tracking tokens; the graph can't read them.
- **Lead score thresholds** — the `lead_scores` table exists and is unused by the engine.
- **Reply metadata** — bounced, auto-reply/OOO (partly handled in `routeReply`), replied-from-a-
  different-address, forwarded-to-a-colleague. That last one is a strong buying signal and currently
  invisible.
- **Sentiment or confidence** — `reply: interested (confidence > 0.8)`, else route to a human.
- **A/B split** — `A -- 50% --> B1` / `A -- 50% --> B2`, with variant recorded on the message so
  reporting can pick a winner.

### Tier 4 — human in the loop

The engine is fully autonomous today; there is no way to draw "check with me first".

- **Approval gate** — `P[Approve: hold for my review]` parks the lead, notifies, sends on approval.
- **Notify** — `N[Notify: slack #sales]` without stopping.
- **Handoff** — `H[Handoff: assign to a human, stop automating]`. Distinct from a terminal: the
  campaign ends for that lead but it isn't won or lost.
- **Low-confidence escape** — when the classifier isn't sure, route to `needs_attention` rather than
  guessing. The state already exists; the graph can't target it.

### Tier 5 — operational

- **Retry policy** on send failure; exponential backoff on Gmail 429s
- **Token expiry** should pause the campaign, not error every lead (7-day test-user expiry makes this
  routine, not exceptional)
- **Versioning** — editing a running campaign's diagram changes the program under leads mid-flight.
  Needs either version pinning per lead or an explicit "migrate leads to the new graph" step.
- **Dry run** — walk N leads through the graph and show what *would* send, without sending.

---

## Sequencing

1. **Loop safety + reply delay + send window.** The first is a bug; the other two are what stop the
   product reading as a bot. Small, self-contained, no schema change beyond campaign settings.
2. **Warmup, per-domain throttle, suppression list.** Protects the asset that everything else depends
   on — the mailbox's reputation.
3. **Grammar refactor.** Extract the keyword table, drive parser + validator + AI prompt + help panel
   from it. Do this *before* the long tail of keywords, or four things drift apart.
4. **Attachments.** Schema, storage, upload, send path. Biggest single chunk of work here.
5. **Attribute and engagement branching.** Unlocks `lead_scores` and `tracking.js`, both already built
   and currently inert.
6. **Human-in-the-loop nodes.**

## Open questions

- **Does config in the diagram hurt the diagram?** The pitch is that the picture *is* the campaign. A
  node reading `Send: intro; delay 2h-6h; window mon-fri 9-17; attach deck.pdf; tone brief` is no
  longer a picture you can read at a glance. Options: show modifiers as a badge count in the preview
  and reveal on hover; or accept a per-node settings drawer and give up on total purity.
- **Where do timezones come from?** Nothing on `leads` records one. Guessing from an email domain is
  unreliable. Might need enrichment, or an explicit column with a campaign-level fallback.
- **What happens to in-flight leads when the graph is edited?** Currently: undefined behaviour.
  Node ids can vanish under a waiting lead — the engine has an error path for it, which is a symptom
  rather than a design.
