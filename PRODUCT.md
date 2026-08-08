# Product definition

A hustling platform: multi-channel outreach built on a relationship graph, for
people who need to land something real and have no sales team behind them.

Two customers, one engine, two skins:

| | Graduate | Operator |
|---|---|---|
| Who | A student or recent graduate landing a case-study client, a first client, or work | A founder or operator running their own outreach |
| Price | $39/month | Higher tiers |
| State | Often ST1–ST2 — survival mode or search burnout | ST4 — bandwidth available |
| Lands on | Today | Campaigns |
| Vocabulary | People, plans, proof | Leads, campaigns, pipeline |

The skin is a `mode` on the workspace. The graph, playbooks, approvals, pacing
and the queue are shared. Nothing forks.

---

## The spine

Five things are the product. Everything else supports them.

1. **The graph** — people and ties, each tie carrying provenance ("same cohort",
   "my coach knows them", "worked there 2019") and strength.
2. **The router** — *who can open this door?* Ranks routes to a target by tie
   strength, not by fit score. Cold is present, last, and honest about it.
3. **The multi-channel playbook** — the Mermaid diagram, extended with channel
   node types: `Email:`, `LinkedIn:`, `Comment:`, `Connect:`, `Call:`, `Intro:`,
   `Meet:`.
4. **The mixed queue** — one list, two kinds of item: **approve** (an email, one
   click) and **do** (a LinkedIn message, drafted, you send it). Always one
   controllable next action.
5. **The proof** — signed agreements, named businesses, dated outcomes. The
   artefact the user walks away with. This is what $39 buys.

---

## Built and staying

Shared by both skins, no changes needed.

- **Engine** — ticks every 20s, sends at send nodes, waits, pulls replies,
  classifies intent, follows the matching edge, honours timeouts and terminal
  outcomes
- **Approval gate** — composes, parks the draft, waits for a human; approve,
  edit or decline; declining stops that person, predictably
- **Honesty rules** — the composer must say who is writing and what is being
  asked in the first two sentences, invent nothing, and close with an easy no
- **Plain-text opt-out** on every send, plus `List-Unsubscribe`
- **The agreement** — server-rendered `/agree/:token`, name typed, dated,
  wording stored as shown; adapts to the ask via the profile
- **Sending rhythm** — working hours and days, randomised spacing, warm-up ramp,
  timezone taken from the browser; deterministic, not `Math.random`
- **Smart follow-up timing** — waits tuned by opens, clicks and out-of-office,
  bounded, per-person offset, reason written to the activity trail
- **Gmail mailbox** (send + read) and **sandbox mailboxes** for testing
- **Slack and Teams alerts** — one webhook URL, service auto-detected
- **Google Sheet sync** — one button, `drive.file` scope only, one-way
- **Coach or teammate review** — invite by email, they can approve sends
- **Auth**, security headers, rate limiting, legal pages, public site

## Built, needs rewriting

| Surface | Change | Why |
|---|---|---|
| Dashboard | → **Today**. One sentence, one button, one goal number. Six KPI tiles go. | F5: a burnt-out user needs one controllable move, not six counters |
| Leads | → **People**. Ties replace lists. | The graph is the product |
| Campaigns | → **Plans**. Diagram stays, vocabulary goes. | F3: "campaign" is sales smell |
| Reports | → **Proof**. Evidence collected, not rates achieved. | Open rate is vanity here |
| Guided briefing | Five paragraph questions → one question, rest progressive | F4: a taxed brain has under a minute |
| Inbox tabs | "Needs your OK" → **"Needs you"** (mixed approve/do) | Multi-channel |

## Built, moving to the operator tier

Correct for an operator, wrong at $39 — and in two cases actively harmful.

- **Monitoring** — health checks and graded success factors. Hidden entirely in
  graduate mode. A red "reply rate 2.1%, target 5%" feeds the self-efficacy
  spiral in someone already ghosted by employers.
- **Benchmarks and grading anywhere** — same reason.
- **Multiple mailboxes and fleet management** — one real mailbox is the model.
- **ICP and AI qualification language** — kept as machinery, hidden as vocabulary.
- **Lead lists and segments** — the graph replaces them.

## To build, in order

1. **Spend cap** — blocking. `server/engine.js` researches every lead before its
   first email with no budget. At the current lead ceiling that is ~$300 of AI on
   a $39 plan. Per-workspace monthly allowance, spent only on people actually
   approached, meter in Monitoring not in the user's face.
2. **Workspace mode** — `graduate | operator`. Drives nav, vocabulary, defaults.
3. **People and ties** — provenance and strength on every tie. Replaces leads.
4. **The router** — path-finding over the graph, ranked by tie strength.
5. **Channel node types + the mixed queue** — parser extension in
   `server/playbook.js`, plus approve-versus-do in one list.
6. **Cohort seeding** — the institution's own graph, platform-side. Without it a
   first-generation international student opens the router to an empty state,
   which is an F5 failure and an F2 injury at once.
7. **Proof screen and export** — the artefact, portable.
8. **Contribute-first branch** — comment and connect nodes, offered not enforced.

## Non-negotiables

- **Nothing sends without the user's OK.** Approving means *yes, send this* — the
  rhythm still picks the minute.
- **Never automate or store LinkedIn credentials.** Assisted-manual only. For a
  graduate a banned account is more career damage than this product could repay.
- **No grading, no benchmarks, no leaderboards in graduate mode.** Ever.
- **Suppression is unconditional.** No ignore-unsubscribe setting exists.
- **Every touch stands alone.** Never "I saw you didn't reply on LinkedIn."
- **No campaign is created implicitly.** A plan needs a valid diagram and a mailbox.
- **Design for ST2.** It degrades gracefully upward; the reverse never holds.
- **Warm before cold** — offered by ordering, never enforced by a gate. A visa
  clock does not wait for a reciprocity ramp.

## Channels

| Channel | Mechanism | Cost |
|---|---|---|
| Email | Automated, built | Free |
| LinkedIn message | Assisted — drafted, user sends | Free |
| Comment / content | Assisted — drafted | Free |
| Connection request | Assisted — drafted note | Free |
| Warm introduction | A routing decision, not a channel | Free |
| SMS and calls | Metered provider, operator tier | Per message |
| Events, in person | Prep card plus follow-up node | Free |

## Open questions

- **Tier shape** — one $39 plan with a monthly AI allowance and no seat or
  contact limits, or keep the $39 → team ladder. The current ladder meters
  mailboxes and lead counts, which is the wrong axis: AI research is what costs
  money.
- **Free tier — settled: there is no free plan.** A free tier that shipped the
  template composer produced visibly robotic email and taught the user the
  product does not work; a free tier with real AI on a small allowance is a cost
  nobody sized. Entry is now a free trial of a paid plan, which puts real AI in
  front of the user from the first send. Open part: the trial length, and whether
  it takes a card.
- **Term pricing** — a graduate with no financial buffer faces a monthly
  cancellation decision every month. A term-length price may fit the cashflow
  better.
- **Response rates for a student ask are unmeasured.** "Can I study your
  operations for my assessment, findings free, an hour of your time" is a
  fundamentally different email from a sales pitch — low cost, time-bounded, no
  commercial risk. It should convert better than the 1–3% cold B2B benchmark.
  Nobody has a validated figure. Measure it in the first term rather than
  assuming one.
