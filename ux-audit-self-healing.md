# Harry The Marketer — Self-Healing UX Audit

**Date:** 30 August 2026  
**Framework:** [v2 mermaid self healing ux.md](./v2%20mermaid%20self%20healing%20ux.md)  
**Method:** Eight parallel code audits covering every product surface (marketing/auth, dashboard/goals, campaigns, inbox, leads, reports, monitoring/connections, settings/shell), triaged against the H1–H20 gap taxonomy.  
**Status:** OPEN — precision-weighted error above closure threshold.

---

## What this audit is

This is an end-to-end UX audit of Harry The Marketer, run against the **Self-Healing UX** framework. That framework treats UX quality like a brain doing predictive coding:

1. **L0 — Evidence** — Collect screenshots of every screen in every state (empty, loading, error, success, edge). A state you cannot show is a state you cannot audit.
2. **L1 — Predictions** — Define what the customer should feel at each moment (orient, decide, act, wait, recover, celebrate) and what “done” means.
3. **L2 — Cortical columns** — Eight parallel scans: Attention, Voice, Taste, Action-Echo, Error-Experience, State/Continuity, Trust, Accessibility.
4. **L3 — Salience hub** — Classify gaps using locked H-codes (H1–H20), triage by confidence × severity.
5. **L4–L5 — Fix and close** — One primary fix at a time; closure only when the customer *feels* finished.

This audit was run from **source code** (React components, HTML prototypes, server routes). No live screenshot bundle was captured. That limits confidence on visual hierarchy and contrast — flagged throughout as **H18** (incomplete evidence).

---

## What it means (executive summary)

Harry has unusually strong **voice, send safety, and honest error copy** for a B2B outbound tool. The Needs You approval flow, campaign launch blockers, send confirmation modals, and settings readability patterns are best-in-class within the codebase.

But the product has **one systemic defect and three recurring failure modes** that keep it from passing the framework’s closure test:

| Category | Verdict |
|----------|---------|
| **Voice & honesty** | Strong — calm, customer-owned language on marketing and most in-app surfaces |
| **Send safety** | Strong — confirmations, blockers, review drawers before anything goes out |
| **Scope honesty** | **Critical failure** — Client Lens implies filtering; several surfaces stay workspace-wide |
| **Interruption recovery** | **Critical failure** — compose text, job state, and partial loads don’t survive real use |
| **Waiting narration** | **Weak** — long async jobs and background sync are too silent |
| **Prototype parity** | **Drift** — 28 HTML prototypes exist; many no longer match shipped React |

**In plain terms:** The product is trustworthy in the moments it was designed for (approve a send, block a bad launch), but **breaks trust at the seams** — when an agency user switches clients, when someone is interrupted mid-reply, or when analytics mix time ranges without saying so.

---

## The one thing that matters most

### Client Lens lies about what you're looking at

When an agency user selects a client in the sidebar, the UI says campaigns, leads, and mailboxes are filtered. In reality:

- **Dashboard KPIs** — workspace-wide (no `clientId` on `/api/dashboard`)
- **Needs You queue** — workspace-wide (drafts, tasks, reminders not lens-aware)
- **Goals** — workspace-wide
- **Reports & Monitoring** — workspace-wide (correctly disclosed in Client Lens copy)

**Effect:** User believes they're on Client A, sees Client B's approvals, parked leads, and numbers, and concludes the product is broken.

**H-codes:** H12 (trust gap), H1 (orientation failure)  
**Severity:** Critical — product-architecture level, not polish

**What needs to be done:**

- [x] **Option A (preferred):** Filter Dashboard, Needs You, and Goals API + UI by active `clientId` when a client is selected. *Done 2026-08-30 for Dashboard (KPIs, chart, parked leads) and all Needs You sources (drafts, tasks, reminders) — `/api/dashboard`, `/api/drafts`, `/api/tasks`, `/api/reminders` now honour `clientId` and are in `LENS_AWARE`. Goals has no `client_id` path (goals carry only a nullable `campaign_id`, and goal-created campaigns are unassigned), so it got the Option B banner instead; promoting it to Option A needs a schema addition.*
- [x] **Option B (minimum):** Persistent banner on every affected surface. *Done for Goals; Dashboard's Activity panel (inherently workspace-wide — workspace events have no campaign/lead) carries its own caption, driven by the server's `scope` field.*
- [x] Extend Client Lens disclosure to name Dashboard, Needs You, and Goals explicitly. *Done — sidebar copy now names all of them.*
- [x] Add acceptance test: select client → Dashboard counts match that client's campaigns/leads only. *Done — `tests/client-lens-dashboard.test.js` (server, incl. cross-workspace leak check) and the new cases in `web/src/__tests__/ClientLens.test.jsx`.*

---

## Three recurring failure modes

### 1. Interruption is not resumption (H15)

The product handles happy-path flows well but punishes real-world use.

| Surface | What breaks |
|---------|-------------|
| **Inbox** | Reply composer text in local `useState` — switch thread, refresh, mobile back → typed work gone |
| **Leads** | Drawer, selection, segment, Find Emails job — not in URL; refresh loses context |
| **Needs You** | Partial load shows rows while approvals still loading — looks "done" when it isn't |
| **Find Emails** | Sheet dismissible mid-job; no global job indicator or auto-resume |

**What needs to be done:**

- [x] Persist Inbox reply composer per thread (localStorage or server draft). *Done 2026-08-30 — `harry.replyDrafts` in localStorage, keyed per thread, capped at 50, cleared only on a successful send; covers email and SMS composers. Tests: `web/src/inbox/Composer.test.jsx`.*
- [ ] Add `?lead=` deep link for Leads drawer; persist segment/selection where practical.
- [x] Needs You: banner *"Still checking approvals, tasks, reminders…"* when any source is `loading`. *Done 2026-08-30 — banner names the outstanding sources, the All pill shows `N+` while any source is pending, and the live region announces completion. Tests: `web/src/dashboard/NeedsYou.test.jsx`.*
- [ ] Find Emails: disable Cancel while busy; global job pill; auto `reread(jobId)` on reopen.
- [ ] Draft edit mode: warn before switching drafts if dirty.

---

### 2. Waiting without narration (H5 / H6)

Spinners where the framework demands story.

| Surface | Gap |
|---------|-----|
| **Goals build** | "Planning with the agent…" for 30+ seconds; steps only appear after success |
| **Inbox sync** | 10s background sync silent; failures swallowed |
| **Find Emails** | Up to 500 leads, no batch progress, closable sheet |
| **Deliverability tests** | Status chip only until drawer opened |
| **OAuth signup** | Google link with no "Redirecting…" guard |
| **Goal achieved** | Badge only — no release moment |

**What needs to be done:**

- [ ] Goals: stepped progress panel during build (match server `steps`); inline error on failure, not toast-only.
- [ ] Inbox: visible sync status + failure toast; optional "last synced" timestamp.
- [ ] Find Emails: batch progress, "safe to leave" copy, non-dismissible in-flight state.
- [ ] Deliverability: list-row progress for active tests.
- [ ] Auth: loading state on OAuth link click.
- [ ] Goals achieved: Notice block + suggested next action.

---

### 3. Scope / time honesty at fear peaks (H12 / H9)

Numbers and states that don't mean what they look like.

| Surface | Gap |
|---------|-----|
| **Reports Overview** | Ranged headline numbers beside all-time funnel and learning — no guardrail |
| **Dashboard → Reports** | All-time KPI tiles link to ranged analytics — numbers may not reconcile |
| **Campaign drill-down** | Three time windows on one tab |
| **Leads segment** | Segment selected but table shows all leads — banner explains but visual selection implies filter |
| **Campaign send failures** | `lastError` in tiny text on Sending tab; header still says "Running" |

**What needs to be done:**

- [x] Reports Overview: persistent scope strip — *"Headline & contact mix: [range] · Funnel & learning: all time"*. *Done 2026-08-30 — strip above the panels plus an "All time — ignores the range picker" marker on the funnel and Learning panel headers.*
- [ ] Dashboard KPI tooltips or labels clarifying all-time vs ranged when linking to Reports.
- [ ] Campaign drill-down: visual time-scope label per panel.
- [ ] Leads segment mode: distinct table chrome when segment selected for actions only.
- [ ] Campaign detail: "Sending health" strip in header when Running — synthesizes hold reason, mailbox errors, pending OK count.

---

## Critical gaps by journey

### Marketing & Auth

| Gap | H-code | Action |
|-----|--------|--------|
| Signup OAuth errors redirect to Login ("Welcome back"), not Signup | H1, H7, H11 | **Done** — OAuth state stores `intent`; errors return to `/signup?error=` |
| API down blocks entire marketing site (can't read /security during outage) | H7, H12 | **Done** — `/api/auth/me` failure only walls `/app` |
| Mobile signup strips trust panel (5 points → 3 bullets) | H12 | **Done** — full five-point panel stacks under the form |
| Google OAuth tap has no loading state | H5, H6 | **Done** — "Redirecting to Google…" + disable after click |
| Auth errors leak system jargon (Auth0, server logs) | H4, H7 | **Done** — codes mapped in `shared/auth-errors.js` |

---

### Dashboard & Goals

| Gap | H-code | Action |
|-----|--------|--------|
| Client lens + workspace-wide data (see above) | H1, H12 | **Done** — dashboard + Needs You sources filter by lens; Goals gets a banner |
| Partial Needs You load without "still checking" banner | H6, H18 | **Done** — banner names pending sources; counts show `N+` until all answer |
| H1 "Dashboard" outranks Needs You queue typographically | H2, H3 | Promote Needs You headline or demote page title |
| Goal build long silence | H5, H6 | Stepped progress |
| Goal achieved = badge, no release | H13, H20 | Celebration + next step |

**Preserve:** Needs You honest counts, review drawer, LiveRegion, row-level 422 errors, poll pause during read.

---

### Campaigns

| Gap | H-code | Action |
|-----|--------|--------|
| No launch confirmation modal (prototype had one) | H12 | **Done** — Start/Resume opens a pre-start summary: leads, senders, send window, approval mode |
| "Run engine now" as primary header button | H2, H3, H4 | **Done** — moved to Manage tab as a ghost button with a "runs automatically every 20s" note |
| Campaign webhooks missing (prototype exists) | H18 | Ship campaign-scoped webhooks panel |
| Send failures buried in Sending tab microcopy | H7, H12 | Campaign-level sending health strip |
| Start success = toast only | H5, H20 | Post-start panel: started at, next send, pending OK count |

**Preserve:** LaunchChecklist blockers, destructive confirms, stranded-leads warning, test-send guards.

---

### Inbox

| Gap | H-code | Action |
|-----|--------|--------|
| Reply composer not persisted | H15 | **Done** — per-thread localStorage drafts, cleared only on successful send |
| Background sync invisible | H5, H6 | Sync status + failure toast |
| Triage buried in collapsed disclosure below composer | H2, H3 | Surface assignee/intent above fold or open by default on unread |
| Notes/tasks/reminders save with no toast | H5 | Inline echo on secondary saves |
| Native `confirm()` for approve-all / decline | H11 | Branded Confirm modal |

**Preserve:** URL-as-memory (folder, thread, draft, filters), send trust chain, bulk undo, approval queue auto-advance.

---

### Leads

| Gap | H-code | Action |
|-----|--------|--------|
| Detail drawer not routable (`?lead=`) | H1, H15 | Deep link + breadcrumb in drawer |
| Workspace import = toast only; segment import = full summary | H14 | Same `ImportSummary` for both |
| Labels not visible in People table | H1, H2 | Labels column or chips |
| Find Emails sheet closable mid-job | H6, H15 | Non-dismissible in-flight + job persistence |
| First label hidden when workspace has zero labels | H14 | Show "+ Label" on detail always |

**Preserve:** Field-level errors, Find Emails honesty, bulk label undo, differentiated empty states.

---

### Reports

| Gap | H-code | Action |
|-----|--------|--------|
| Overview mixes ranged and all-time without guardrail | H12, H1 | **Done** — scope strip above the panels + "All time" markers on funnel/Learning |
| Weak zero-data CTAs (plain text vs EmptyState + action) | H14 | Unify empty pattern with widen range / launch campaign links |
| Tab-level orientation weak (H1 always "Reports") | H1 | Dynamic subtitle or tab name in heading |
| Stale data = tiny "may be out of date" badge | H12 | Timestamp + stronger stale treatment |
| Campaign drill-down three time models | H9 | Visual scope labels per panel |

**Preserve:** RangeCaption, graded rates, timezone disclosure, maturing-days shading, accessibility tables.

---

### Monitoring & Connections

| Gap | H-code | Action |
|-----|--------|--------|
| Order completion weak vs `order-done.html` prototype | H13, H20 | Completion panel: reference, pending vs complete, CTAs → Orders + Fleet |
| Active placement tests: no list-level progress | H6 | Row + drawer header progress line |
| Monitoring incidents read-only, no fix links | H7, H2 | One primary action per incident → mailbox/test/connections |
| Unverified deliverability data undercuts trust at read time | H12 | Per-panel confirmed vs best-effort badges |
| Create test exposes `sequenceStepId` jargon | H4 | Campaign Send step picker from playbook |

**Preserve:** Honesty primitives, purchase safety (no card in Harry, idempotency), warm-up cap clarity.

---

### Settings & Shell

| Gap | H-code | Action |
|-----|--------|--------|
| H1 always "Settings" on every sub-area | H1 | H1 = area name; "Settings" as breadcrumb |
| Command palette hidden on mobile (sidebar only) | H17, H2 | Search icon in mobile top bar |
| Palette names ≠ tab names (Webhooks → Alerts, etc.) | H11 | Align labels; add Billing + Account commands |
| Send toggles require Edit despite "instant" intent | H2 | Ungate instant toggles or drop instant pretense |
| Account/Integrations leak env var names | H4 | Customer-facing copy only |

**Preserve:** Readout/EditableSection, API key + webhook trust patterns, command palette a11y tests.

---

## Strengths to preserve (do not regress)

1. **Needs You approval flow** — honest counts, review drawer, paused poll, LiveRegion, row-level errors
2. **Send trust chain** — named confirmation modals for reply, forward, approve, test-send
3. **Campaign safety** — LaunchChecklist, stranded-leads warning, delete type-name, duplicate scope
4. **Honesty primitives** — null as `—`, stale markers, pending ≠ zero, unverified contract disclosure
5. **Settings readability** — audit-before-edit, once-only secrets, block list preservation
6. **Marketing voice** — Security, Pricing, About copy (desktop signup aside)
7. **Inbox URL state** — folder, thread, draft, filters survive refresh

---

## Meta-finding: H18 blocks closure

Every audit pass hit the same L0 gate: **no screenshot bundle per tab × state**.

Additionally, **28 HTML prototypes** in `Docs/UX Design/HTML Prototype/` are largely stale vs shipped React:

| Prototype intent | Shipped reality |
|------------------|-----------------|
| Action Center page | Merged into Dashboard Needs You |
| Mailboxes nav | Connections → Fleet |
| Launch confirmation modal | One-click Start |
| `order-done.html` | Inline "Order recorded" in SenderFlow |
| Campaign webhooks page | Not implemented in React |
| Full-page lead detail + breadcrumb | Drawer overlay, no URL |

**What needs to be done:**

- [ ] Run L0 screenshot pass: every route × {empty, loading, error, success, edge} × {desktop, mobile}
- [ ] Archive or update HTML prototypes to match shipped IA, or mark as historical
- [ ] Re-triage H2, H3, H10, H17 findings after visual evidence exists

---

## Recommended fix order

One primary fix in flight per surface (L4 gate). Fix in this order:

### P0 — Trust architecture (do first)

1. ~~Client lens scope honesty (filter or banner everywhere)~~ **Done 2026-08-30**
2. ~~Inbox composer persistence~~ **Done 2026-08-30**
3. ~~Needs You partial-load banner~~ **Done 2026-08-30**
4. ~~Reports Overview scope strip~~ **Done 2026-08-30**
5. ~~Campaign launch confirmation modal + demote "Run engine now"~~ **Done 2026-08-30**

### P1 — Recovery & narration

6. Signup error routing to Signup (not Login) — **done**
7. Find Emails non-dismissible in-flight + job persistence
8. Inbox sync visibility + failure toast
9. Goals build progress + achieved release moment
10. Auth API-down shouldn't block static marketing pages

### P2 — Orientation & parity

11. Leads `?lead=` deep links + import summary parity
12. Settings per-area H1 + palette label alignment + mobile search
13. Order completion release (match `order-done.html` intent)
14. Campaign sending health strip + campaign webhooks
15. Deliverability test progress + incident action links

### P3 — Polish & evidence

16. Labels column on Leads People table
17. Leads segment visual distinction
18. Unified empty states on Reports
19. Replace native `confirm()` seams (Goals archive, Inbox approve-all)
20. Full screenshot bundle for H18 closure

---

## Closure criteria (from framework)

The audit exits OPEN until **all** are true:

- [ ] Gap checklist has zero open P0/P1 rows
- [ ] Client lens, interruption recovery, and scope honesty defects resolved or explicitly accepted with owner sign-off
- [ ] Screenshot bundle covers every state in the H18 ledger
- [ ] Two consecutive audit runs on unchanged product produce structurally identical findings
- [ ] Adversarial pass (distracted train test, screenshot-to-support) passes on top 5 journeys
- [ ] Owner signs off felt completion — not just task success, but customer *feels* finished

---

## Adversarial scenario (the screenshot that goes to support)

**Persona:** Agency user on Client Acme, Monday morning, phone on train.

1. Opens Dashboard — sees 3 items in Needs You, clears them
2. Checks KPIs — they're another client's numbers (no warning)
3. Goes to Inbox, starts reply, notification interrupts — reply gone
4. Checks Reports for "last week" — funnel shows all-time pipeline
5. Screenshots and emails: *"Your product showed me the wrong client's data and ate my reply"*

That screenshot does not defend itself. Fixing the P0 list above addresses this exact support ticket.

---

## Related files

- [v2 mermaid self healing ux.md](./v2%20mermaid%20self%20healing%20ux.md) — audit framework (brain architecture)
- `Docs/UX Design/HTML Prototype/` — 28 wireform pages (mostly stale vs shipped)
- `web/src/` — shipped React product

---

*Generated from eight parallel Self-Healing UX audits, 30 August 2026.*
