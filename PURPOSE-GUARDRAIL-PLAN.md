# Purpose guardrail — plan

The smallest thing on the build list, and the one everything else in the
positioning rests on. See `BUILD-BRIEF.md` for why, and
`Docs/UX Design/graduate-outreach.md` for what the user sees.

---

## The rule

**A message the product writes may not offer, price, or promote a service.**

That single sentence is what keeps all three asks — an assessment, work
experience, a role — outside the Spam Act's definition of a commercial
electronic message. The Act catches a message where *one of the purposes* is
commercial, so one stray line about freelance availability converts an entire
plan. The rule has to be enforced, not asserted.

## Purpose lives on the plan

A new column, `campaigns.purpose`, one of:

| Purpose | The ask | Compliance load |
|---|---|---|
| `assessment` | study your operations for my course | header-only unsubscribe |
| `experience` | a placement | header-only unsubscribe |
| `role` | a job | header-only unsubscribe |
| `commercial` | anything that sells | visible footer, full load, no exceptions |

No default at creation — the author picks. Existing rows migrate to
`commercial`, which is both the safe answer and the correct one for the operator
tier already using the product.

The guardrail runs on the first three. Under `commercial` it is off, because
there is nothing to protect.

## Two enforcement points, because there are two composers

`composeEmail` ([server/ai.js:137](server/ai.js:137)) falls back to
`templateCompose` whenever the API key is missing or the call fails — and the
template path emits the playbook's `instruction` almost verbatim. That
instruction is written by the user. Constraining the model prompt therefore
covers only half the paths.

**1. Playbook validation.** `server/playbook.js` rejects a plan whose node
instructions read as commercial, before it can launch. A plan under a
non-commercial purpose cannot contain a `Send:` node that says *pitch my
freelance ops work*. This is where a template-path plan is actually made safe.

**2. Output check.** Between `composeEmail` returning and `createDraft` /
the send in [server/engine.js:179](server/engine.js:179). Runs on every composed
message regardless of `via: 'ai'` or `via: 'template'`. This is the backstop.

Both call the same checker so they cannot drift — the same lesson
`server/gates.js` already encodes for send controls.

## The check

Deterministic first, model second.

**Deterministic** — a phrase and pattern list: currency symbols, *per hour*,
*rate card*, *my services*, *hire me*, *quote*, *retainer*, *package*,
*available for freelance*, *day rate*. Cheap, always runs, catches the obvious,
and works with no API key. A hit is a block.

**Model** — one cheap `callModel` pass with `op: 'purpose'`, only when the
deterministic pass is clean and only on the AI path. Schema:
`{ commercial: boolean, sentence: string }`, where `sentence` quotes the
offending line verbatim so it can be shown to the human.

If the model is unavailable, the deterministic check stands alone and the
message proceeds. That is a deliberate fail-open, and it is safe because the
template path can only emit an instruction that already passed playbook
validation. Every fall-through writes telemetry.

## One rewrite, then the human

1. Check trips. Compose again, once, with the offending sentence named in the
   prompt: *"This line offers a service and must not appear: …"*
2. Check the rewrite. If it passes, carry on as normal.
3. If it trips twice, the draft parks for the human with the sentence marked —
   whether or not the workspace requires approval. It is never sent, and never
   silently dropped.

A blocked draft is a `logEvent` of type `purpose_blocked` carrying the sentence,
so the activity trail explains itself.

## What the user reads

*"This reads like a pitch — it offers a service, and this plan is a training
ask. The line is: …"*

Never *CEM*, never *classification*, never *compliance*. The user is a graduate
under time pressure, not a compliance officer.

## Compliance load follows purpose

Under `commercial`, `withOptOutFooter` ([server/tracking.js:29](server/tracking.js:29))
stays exactly as it is. Under the other three, the visible plain-text footer
comes off and only the `List-Unsubscribe` header goes out — which also needs the
missing `List-Unsubscribe-Post: List-Unsubscribe=One-Click` in
[server/google.js:78](server/google.js:78), and the unsubscribe endpoint moved
off GET so link scanners stop unsubscribing live leads.

That header/footer split is the visible payoff for building this, and it should
land in the same change.

## Edge cases

- **`refine` outranks `instruction`, and the guardrail outranks `refine`.** A
  user note saying *mention I charge $80/hr* does not get a pass.
- **`node_examples`.** Approved sample copy is a model the composer follows, so
  a pitch approved as a sample propagates to every lead. Check on approval of
  the sample, not only at send.
- **`consentLink` wording** already says *never as a contract, never as a
  condition of talking*. Consistent; leave it.
- **`meetingLink`** is not commercial. Proposing a call is not selling.
- **Manual replies** typed by a human in the Inbox are out of scope. The
  guardrail governs what the product writes, not what the person says. If they
  want to pitch in their own words, in their own thread, that is theirs to do —
  and it is exactly where the conversion is supposed to happen.

## Tests

- Deterministic hit blocks on the template path with no API key
- Model hit blocks, rewrite passes, draft proceeds
- Model hit twice parks the draft with the sentence attached, unsent
- `commercial` purpose skips the check entirely
- A plan with a commercial node instruction cannot launch under `assessment`
- `refine` containing a rate does not bypass
- A sample approved with a pitch is rejected at approval
- Footer present under `commercial`, absent under the other three, header present in all four
- Model unavailable: deterministic still runs, telemetry written

## Not in scope

Rewriting the honesty rules — the purpose rule sits alongside them
([server/ai.js:122](server/ai.js:122)), it does not replace them. Nor the
`commercial` tier's own copy, which is the operator product and unchanged.
