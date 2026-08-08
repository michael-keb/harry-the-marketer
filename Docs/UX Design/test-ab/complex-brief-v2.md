# Complex Brief v2 — Prospect Fetch Under Pressure

**Scenario:** Goal owner finds prospects, hits a credit wall mid-fetch, reviews results, and pushes to an existing campaign — with duplicates and suppressions handled visibly.

**Purpose:** A/B token test — WYRE first, wait 2 min, HTML second. Isolated from v1 agency-launch brief.

**Actor:** Maya Chen (campaign owner)  
**Version:** 2.0 · 2026-08-08

---

## Problem & goal

**Problem:** Maya needs 500 verified contacts for *Enterprise Q1* but must not burn credits blindly, fetch unusable rows, or push into a campaign that isn't ready.

**Goal:** Narrow the audience, fetch real emails, review out bad fits, push 488 leads to *Q1 Cold Outreach* — with every skip and failure visible.

---

## Trigger

Maya opens **Leads → Find prospects** from goal *Enterprise Q1* (ICP pre-filled).

---

## Journey (with failures)

1. Preview loads — **~840,000 matches** → UI warns "too broad."
2. Maya adds country, industry, seniority → **~12,400 matches** → preview sample looks right.
3. Clicks **Get email addresses** (500 credits) → confirm modal.
4. **Fetch fails:** HTTP 200, `success: false`, insufficient credits (480 available).
5. UI shows last good preview + credit failure banner — not a blank screen.
6. Maya trims fetch to **100** → fetch succeeds.
7. **Review contacts** — removes 12 (wrong title / bad deliverability).
8. **Push to list** → segment *Enterprise Q1* updated (88 net new).
9. **Push to campaign** → selects existing *Q1 Cold Outreach* (no implicit create).
10. **3 duplicates skipped** — toast lists emails; 85 attach.
11. Readiness reminder: campaign still needs mailbox before launch.

---

## Screens (7)

| # | Screen | Must show |
|---|---|---|
| 1 | Find prospects — too broad | ~840k count, fetch discouraged |
| 2 | Find prospects — narrowed | ~12.4k count, sample table, masked preview emails |
| 3 | Fetch failed — insufficient credits | 500 requested vs 480 available; preview stays visible |
| 4 | Fetch succeeded — review queue | 100 fetched, 12 flagged for removal |
| 5 | Push to segment confirm | 88 net new after review |
| 6 | Push to campaign | Pick existing campaign only; 3 duplicates listed |
| 7 | Campaign readiness nudge | Leads attached ✓ · mailbox still missing |

---

## Exceptions (visible, not hidden)

| Exception | UI |
|---|---|
| Credit failure on fetch | Banner + keep preview; no fake success |
| Preview email ≠ real email | Column labelled "Preview — not sendable" |
| Duplicate on campaign push | Named in toast; count in success state |
| Suppressed lead | Row greyed in review; cannot select |
| Campaign not launch-ready | Success ends on nudge, not fake "done" |

---

## Hard rules

- Cursor paging only ("Show more") — no page numbers.
- Fetch is the spend step — always confirmed.
- No campaign created from a string name on push.
- Suppression unconditional.

---

## Out of scope

- Buying credits in-app
- Auto-review by AI
- Bulk fetch >500 without warning

---

## Acceptance

- [ ] Credit failure does not clear the preview
- [ ] Review removes rows before any push
- [ ] Duplicate skips name the emails
- [ ] Final state points to mailbox gap, not celebration
