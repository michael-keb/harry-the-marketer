# Logo brief — Harry The Marketer

## 1. Why we need a logo now

Two drivers, one of them a hard dependency:

1. **Google OAuth verification.** The consent screen users see when they click **Connect Gmail**
   currently shows no app logo. Submitting for verification with sensitive Gmail scopes is smoother
   with a real mark — but note the trade-off in §6: uploading a logo triggers Google's brand
   verification review, which adds time. We want the asset ready and correct on the first submission.
2. **Product identity.** The app shell and login screen render the name as a plain text wordmark.
   There is no icon for the favicon, the sidebar, or anywhere the product is referenced externally.

## 2. What the product actually is

Harry The Marketer is a lead-generation platform where **campaign playbooks are Mermaid diagrams
executed by an AI agent against the live email chain**. A user draws a branching flowchart — send,
wait, branch on reply intent, follow up — connects a Gmail mailbox, and the engine runs it: composing
and sending real email, reading replies, classifying intent, and advancing each lead down the
branch it earned.

The three ideas that matter, in priority order:

1. **Agency** — something is *running* on your behalf, continuously, without you in the loop.
2. **Branching** — the logic is a diagram with decision points, not a linear drip sequence.
3. **Correspondence** — the substrate is real email in a real inbox, not an abstract "channel".

## 3. Positioning

| | |
|---|---|
| **Audience** | Founders and ops/growth leads at small B2B teams running their own outreach. Technical enough to read a flowchart; not designers. |
| **Competitive set** | Instantly, Lemlist, Apollo, Smartlead — a category with loud, saturated, gradient-heavy branding. |
| **Where we sit** | Quieter and more instrumental. This is a tool that shows its working, not a growth-hack brand. |
| **Personality** | Composed, precise, a little dry. Competent operator, not a hustle mascot. |
| **Explicitly not** | Cute, playful, or cartoonish. "Harry" is a name, not a character we are illustrating. |

The name deserves a note. "Harry The Marketer" is deliberately humble — it names the agent doing the
work rather than the platform. The mark should honour that understatement. It should not try to make
the product sound like enterprise infrastructure, and it should not draw a face.

## 4. Existing identity to build on

These are already in the product and are **fixed inputs**, not suggestions:

| Token | Value | Role |
|---|---|---|
| `--color-ink-950` | `#0b1120` | App background — the mark's default ground |
| `--color-ink-900` | `#101828` | Surfaces / cards |
| `--color-ink-700` | `#253046` | Borders |
| `--color-accent-500` | `#17a583` | Primary action — the brand teal |
| `--color-accent-400` | `#45c4a8` | Hover / highlight |
| `--color-accent-300` | `#7dd8c5` | Light accent on dark |
| Type | "Avenir Next", "Segoe UI", system sans | UI typeface |
| Mono | "SF Mono", ui-monospace | Code and diagram labels |

Current wordmark treatment, in `web/src/App.jsx` and `web/src/pages/Login.jsx`:

> Harry the **Marketer** — with "Marketer" set in `accent-400` (`#45c4a8`)

Note the casing inconsistency to resolve: the UI renders "Harry the Marketer" (lowercase *the*)
while the legal name, now set in `server/legal.js` as `APP_LEGAL_NAME`, is **"Harry The Marketer"**.
The legal name is what the Google consent screen must match exactly. **Pick one casing and apply it
everywhere** — recommend "Harry The Marketer" throughout, since changing the legal name means
re-editing the consent screen.

## 5. What the mark has to do

**Primary job:** be legible and recognisable as a **32×32 px favicon on a dark background**. That is
the size it will be seen at most often. Everything else is secondary. If a concept only works at
200px, it has failed.

**Secondary jobs, in order:**
- Read correctly as a square avatar on Google's consent screen (light background, ~120px)
- Sit in the app sidebar at ~24–28px next to the wordmark
- Survive being rendered in a single flat colour (favicons, email footers, monochrome contexts)

## 6. Hard constraints — Google OAuth consent screen

These are non-negotiable; the asset is rejected otherwise.

- **Square aspect ratio**, minimum **120×120 px** (supply 512×512 to be safe)
- **PNG, JPG or BMP**, under **1 MB**
- Must render legibly on a **light background** — Google's consent screen is white, our app is near-black.
  This is the single most common failure mode: a mark designed only for `#0b1120` disappears on white.
- No text in the icon. Google shows the app name beside it; a wordmark inside the square reads as noise.
- Must not imply Google endorsement, and must not use Google's colours or any Gmail/envelope styling
  that could be mistaken for a Google product mark. **Be careful here** — the obvious "envelope"
  metaphor is exactly the thing most likely to trip this.

> **Timeline warning:** adding a logo to the consent screen moves the app into Google's brand
> verification queue, which can add days to weeks on top of the sensitive-scope review. If shipping
> the connect flow to more testers is urgent, ship without the logo first and add it at the
> production verification stage. See [GOOGLE-OAUTH-VERIFICATION.md](./GOOGLE-OAUTH-VERIFICATION.md).

## 7. Deliverables

| Asset | Spec | Used by |
|---|---|---|
| Primary mark | SVG, square artboard, on-dark | App sidebar, docs |
| Light-background variant | SVG | Google consent screen, light contexts |
| Monochrome variant | SVG, single flat colour | Email footers, print, fallbacks |
| Consent screen icon | PNG 512×512, light-safe, <1 MB | Google Cloud Console upload |
| Favicon set | 32×32, 16×16 ICO + SVG | `web/index.html` |
| Lockup | Mark + wordmark, horizontal | Login screen, README |
| Usage notes | Clear space, minimum sizes, don'ts | Whoever touches it next |

## 8. Concept directions

Three starting points. Not prescriptive — a fourth idea that beats them is welcome.

**A. The branch node.** The decision point from a Mermaid flowchart, reduced to its essentials: one
path in, two paths out. Speaks directly to what makes the product different from a linear drip tool.
Risk: generic "flowchart" iconography is well-trodden; needs a specific, memorable geometry to avoid
looking like a default diagramming app icon.

**B. The monogram with a branch.** An **H** whose crossbar splits and diverges — the letterform *is*
the decision point. Ties the agent's name to the mechanic. Strong at favicon size because letterforms
survive scaling better than diagrams. Risk: the split must be obvious at 32px without shredding the H.

**C. The thread.** A single continuous line that departs, waits, turns on a reply, and continues —
the email chain drawn as one unbroken stroke. Most distinctive of the three and best captures
"running continuously on your behalf". Risk: hardest to hold together at small sizes; likely needs a
simplified variant below 24px.

Direction **B** is the recommended starting point — best odds at favicon size, and it solves the
"no text in the icon" constraint by making the letterform do the work.

## 9. Avoid

- Envelopes, paper planes, @ symbols, megaphones, rockets, upward-trending arrows
- Anything resembling Gmail's mark or Google's colour palette (see §6 — this is a rejection risk)
- Gradients as the load-bearing idea — they collapse in monochrome and at small sizes
- A human face, character, or mascot named "Harry"
- Detail that vanishes below 32px: thin strokes, small counters, more than two colours

## 10. How we'll judge it

1. **Favicon test** — rendered at 32px on `#0b1120`, is it distinguishable from the other tabs in a
   crowded browser window?
2. **White test** — does the light variant hold up on Google's consent screen without a container?
3. **Flatten test** — filled in one colour, does the idea survive?
4. **Blind test** — shown to someone who doesn't know the product, does it read as a *tool that runs
   something*, rather than a generic SaaS or a mail client?
5. **Consistency test** — beside the existing teal-on-ink UI, does it look like the same product?

Concept 1 and 2 are pass/fail. A concept that only wins on 4 is not worth the review time.

## 11. Process

1. Three concepts as flat black-on-white SVGs — no colour, no gradients, sized at 32px for review
2. Pick one; refine through the five tests in §10
3. Apply colour; produce the on-dark, on-light and monochrome variants
4. Export the full asset set in §7
5. Wire the favicon into `web/index.html` and the lockup into the login screen
6. Upload the 512×512 PNG to the consent screen — **only when we're ready to accept the verification
   delay in §6**
