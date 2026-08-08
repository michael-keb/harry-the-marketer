# Prototype — the graduate skin

Open `index.html` in a browser. No build, no server, no dependencies beyond the
Tailwind CDN. Nothing here talks to the API; every number is fixture data.

It exists to settle layout and language before any of it is built, and it uses
the same design tokens as `web/src/index.css` and the same `card` / `btn-primary`
/ `input` class names as the real app — so markup lifts into React unchanged.

## The five pages

| Page | Replaces | The decision it is making |
|---|---|---|
| **Today** | Dashboard | One sentence, one button, one goal number. Six KPI tiles are gone. |
| **Needs you** | Inbox | One queue, two kinds of item: **approve** an email, or **do** a LinkedIn message. |
| **People** | Leads | "How you know them" is a first-class column. Ties, not lists. |
| **Who can open this door?** | — | New. Routes to a target ranked by tie strength. Cold is present and last. |
| **Proof** | Reports | Signed agreements and real conversations. No rates, no benchmarks. |
| **Setup** | Settings | One question. Everything else behind "Add more detail". |

`Who can open this door?` has no nav item on purpose — it is reached from a
person, via **Find a path**.

## What the pages are deliberately not doing

- **No new navigation item anywhere.** Five entries, and the router lives inside
  People rather than earning its own.
- **No grading.** No reply rate, no open rate, no "target 5% or more", no
  leaderboard. Those feed the exact spiral this user is already in.
- **No sales vocabulary.** No leads, campaigns, pipeline, ICP or prospects.
- **Cold is offered, never gated.** The contribute-first path is presented as the
  better option with a reason attached, and "Just ask directly" sits beside it —
  a visa clock does not wait for a reciprocity ramp.
- **Harry never signs in to LinkedIn.** Those items say so on the card, in the
  place where someone would otherwise wonder why it is not automatic.

## Still to draw

- The Replies tab of Needs you (the existing Inbox thread view, relabelled)
- Adding a person and recording how you know them
- The empty state for a graduate whose graph has not been seeded yet — the
  hardest screen in the product, and the one where cohort seeding earns its keep
- The operator skin, which keeps Campaigns, Monitoring and the full nav

See `../PRODUCT.md` for what all of this is for.
