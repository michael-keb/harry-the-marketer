# Build brief — outreach positioning and what it changes

What the deliverability research in `Docs/Research/` actually applies to, the
positioning that falls out of it, and the revised build order. Companion to
`PRODUCT.md`, which it amends rather than replaces.

---

## The volume gate

Five research documents sit in `Docs/Research/`. Four of them assume a
high-volume sender: Postmaster Tools ingestion, SNDS, feedback loops, dedicated
IPs, bandit-driven throttling, a universal reputation score.

Almost none of it reaches Harry's users, and the reason is arithmetic.

| Signal | Needs | Harry's user has |
|---|---|---|
| Google Postmaster Tools | ~100–200 Gmail recipients/day, lags 24–48h | one mailbox, 10 → 30/day |
| Microsoft SNDS | ~100/day to Microsoft consumer domains, IP-based | no dedicated IP |
| Bulk-sender mandates | 5,000/day | never reached |
| SPF, DKIM, PTR, TLS | a sending domain to configure | Gmail supplies all four by construction |

The deliverability-telemetry platform is a different company. What survives the
volume filter is **consent, list hygiene, and one metric that has to go.**

## The three asks

Harry serves three requests, not one. They differ where it counts.

| | Assessment | Work experience | A role |
|---|---|---|---|
| The ask | study your operations for my course | a placement | a job |
| Commercial electronic message | no | no | no |
| Recipient | business address | business address | a named individual |
| Data held | business contact | business contact | personal information |
| Binding constraint | reply rate | reply rate | ~50 employers, each spent once |
| Main risk | purpose drift into services | same | bounces on guessed addresses |

A job application is not a commercial electronic message, and neither is asking
to study a business for coursework — neither offers to supply goods or services.
The Spam Act catches a message where *one of the purposes* is commercial, and
that is the whole exposure: one sentence about freelance availability converts
any of the three into a CEM.

## The positioning

**A training and relationship-building exercise. Never a service.** Responsibility
defaults to the candidate, not the institution.

One rule, enforced in one place, across all three asks. It keeps every version
out of CEM territory, and it is the honest description of what a student or
fresh graduate is actually offering. The default agreement wording in
`server/consent.js` already says *nothing is binding and there is no cost* — the
artefact and the positioning already agree.

**The boundary it implies.** If the ask is a training exercise at no cost, the
conversion to paid work cannot happen inside the product. The moment Harry
drafts the pitch, *one of the purposes* applies and the framing collapses. So
the product stops at the relationship: it gets the graduate in the room, records
what was agreed, and hands off. The human converts it later, off-platform, in
their own words.

This caps the ask. "Study your operations for free" and "$39 buys you proof you
can sell with" cannot sit in the same email — only in the same sequence, with a
person in between.

**Where candidate-default responsibility does not reach.** It is correct for
self-serve. It does nothing at a university: if two hundred students email the
same fifty businesses and one rings the Dean, the harm lands on the institution
whatever the terms say, and procurement reads a tool that disclaims everything
as a reason to decline. Governance is most of what an institution is buying.

### Settled by the positioning

- Spam Act classification across all three asks
- Consent provenance drops from legal defence to hygiene
- The visible unsubscribe footer goes; the header stays
- No services pitch means no commercial profiling of individuals

### Untouched by it

- Bounces, and the fact that they land on the user's real Gmail
- Apple MPP and the EU position on tracking pixels
- Cohort saturation
- Named individuals' personal information, which a training framing does not launder

---

## To build, in order

Amends the list in `PRODUCT.md`. Insertions marked ✚.

**0. Spend cap** — unchanged, still blocking. `server/engine.js` researches every
lead with no budget; at the current ceiling that is ~$300 of AI on a $39 plan.
Everything below assumes it lands first.

**1. ✚ The cheap group.** Four small items that turn the positioning from a claim
into something the product enforces. Days each, not weeks.

- **Purpose guardrail in the composer.** The keystone. Sits beside the honesty
  rules that already exist: the message may not offer, price or promote a
  service. A plan that trips it is treated as commercial and takes the full
  compliance load, with no override.
- **Delete the open pixel** (`server/tracking.js`), and open rate as a graded
  success factor in Monitoring. Apple MPP makes it noise, the CNIL position
  makes it a liability, and Google states it does not track opens. Pure deletion.
- **Unsubscribe: header only** on non-commercial sends. The visible footer is the
  loudest tell that a personal email is automated. Fix the RFC 8058 gap in the
  same pass — `server/google.js` sends no `List-Unsubscribe-Post`, and the GET
  endpoint means link scanners silently unsubscribe live leads.
- **Address verification before first send.** Largest of the four. Job seekers
  guess addresses and it is their real Gmail carrying the bounces. MX plus SMTP
  probe; hold catch-alls rather than guessing.

**2. Workspace mode** — `graduate | operator`. Unchanged, with one addition: when
AI qualification is touched, score the employer and the role, never the person.
Scoring a named hiring manager is profiling personal information whatever the UI
calls it.

**3. People and ties** — unchanged.

**4. The router** — unchanged in position, larger in weight. For a job search a
cold email and a warm intro are not the same act at different conversion rates.

**5. Cohort seeding ✚ with saturation control** — one feature, not two.
`server/touches.js` caps per-person and per-company inside a workspace and sees
nothing across two hundred student workspaces. Seeding a cohort graph without
cross-workspace caps is how one saturated employer burns an institution's name
for every future intake. The coordinator view belongs here: coverage only —
which employers are being approached and how heavily — never per-student
performance.

**6. ✚ Reshape send controls to the real constraint.** The current model assumes
a volume problem. A graduate with fifty addressable employers has a scarcity
problem, and each target is spent permanently.

- Promote per-target budget above the daily cap as the primary lever
- Cap sequences at two touches
- Size the addressable list up front and say the number out loud — Today's job
- Deadline-aware planning: work backwards from the assessment due date or the
  grad-program window and say early whether the arithmetic works

**7. Channel node types and the mixed queue** — unchanged.

**8. Proof screen and export** — unchanged for the assessment ask. For a job
search there is no artefact: the outcome is the job. Same screen, different job —
a readable record of who was spoken to, what came of it, what is still live.

**9. Contribute-first branch** — unchanged.

## Not building

- **Postmaster Tools and SNDS ingestion.** Neither populates below ~100/day.
- **A sender reputation score.** A separate company, with an unsolved
  ground-truth problem and a dependency on proprietary spam-trap networks.
- **Warm-up pools, reciprocal engagement, mailbox rotation.** Google forced GMass
  to shut its warm-up system in January 2023 or lose Gmail API access. A banned
  account is career damage this product could not repay.
- **Open rate, anywhere.**

If the operator tier arrives, the only deliverability signal that works at low
volume is **DMARC RUA** — receivers send it daily regardless of send volume. A
sending-domain auth check at mailbox-connect is worth it alongside. Both are
gated behind operators on their own domains; neither is worth building until
that tier exists.

## Non-negotiables — additions

To be read with the list in `PRODUCT.md`.

- **No message offers, prices or promotes a service.** Enforced in the composer,
  not asserted in marketing.
- **Conversion to paid work happens off-platform.** The product stops at the
  relationship.
- **Score the employer, never the person.**
- **A coordinator sees coverage, never performance.** The institutional view must
  not become the grading surface graduate mode forbids.

## Open questions

- **Institutional governance versus graduate-mode privacy.** Coverage-only is the
  proposed resolution; it has not been tested against what a university actually
  asks for in procurement.
- **Whether the institutional channel is being pursued at all.** Items 5 and the
  coordinator view are sized very differently depending on the answer.
- **Verification: build or buy.** An SMTP-probe pipeline is a maintenance
  commitment; a vendor API is per-address cost on a $39 plan already carrying an
  AI allowance.
- **Response rates remain unmeasured.** A no-cost, time-bounded, non-commercial
  ask should beat the 1–3% cold B2B benchmark. Nobody has a validated figure.
  Measure it in the first term.

---

*Legal positions here are drawn from the research in `Docs/Research/` and are not
legal advice; those documents say the same. Australian counsel should review the
CEM classification before it is relied on commercially.*
