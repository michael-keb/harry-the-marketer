# Handoff — working protocol for the next agent

Read this before touching the repo. It exists so the follow-up **audit is fast and
trustworthy**: clean diffs, green tests, no secrets, and a changelog that states intent.
Context: an end-to-end audit + remediation just landed on branch
`audit-fixes-2026-08-12` — see [Docs/AUDIT-2026-08-12.md](./Docs/AUDIT-2026-08-12.md) for
what was fixed and what still needs a human.

## The non-negotiables

1. **Use Node 22, never the machine default (18).** Prefix everything:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
   ```
   On Node 18 `better-sqlite3` won't load and Vite won't build — it looks like the whole
   app is broken when it isn't. `.nvmrc` says 22; `package.json` engines say `>=20.19`.

2. **Green tests are the definition of done.** Before every commit:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
   npm run test:server && npm run test:web
   ```
   "Green" means **0 fail**. Three known items are NOT yours to fix and must not trigger
   churn:
   - the two `# TODO` server tests (`Docs/leads/get-by-campaign.md` state filter;
     `Docs/leads/activities.md` per-lead timelines) — documented feature gaps.
   - `tests/agent-followup.test.js` warm-up gate — a pre-existing **time-of-day flake**
     (passes outside recipient quiet hours). If it's red, re-run; don't "fix" it.

3. **No secrets in the repo, ever.** The big remaining items (Stripe live keys, Twilio
   prod, Google OAuth verification) are **dashboard/credential actions, not code**. Only
   touch `render.yaml` / `.env.example` as `sync:false` **placeholders** and record what
   you did in a runbook. Never paste a real `sk_...`, `whsec_...`, Twilio auth token, or
   OAuth client secret into any file. A real credential in a diff is an automatic audit
   fail.

4. **Never merge to `main` and never deploy.** Work on a branch; the human runs the
   manual Render deploy.

## How to work so the audit is cheap

- **Branch off `audit-fixes-2026-08-12`** (or off `main` once it merges). One logical
  change per commit, with a real message. No 2,000-line squash commits that mix concerns.
- **Write a changelog for every change** — the format the audit expects:
  > *file:function → what changed, why, and the test added.*
  Put anything touching a **safety invariant** or a **DB migration** at the TOP so it gets
  audited first.
- **Match existing patterns; don't re-architect.** This codebase has strong conventions:
  - every parity route scopes by `user_id` via `owned` / `ownedAll` (`server/parity/http.js`);
  - suppression goes through **one** transport chokepoint (`server/mailer.js`) — no bypass param;
  - the send decision is one resolver with a fixed six-tier order (`server/gates.js`);
  - quiet-hours has an unbypassable 06:00–21:00 floor (`server/send-rules.js`).
  Follow them. If you think one needs changing, flag it — don't silently work around it.
- **Every new behaviour ships with a test.** No behaviour change is "done" without one.

## Highest-risk areas — flag these loudly

Call these out at the top of your changelog; they get audited first:

- **Safety invariants:** suppression, unsubscribe handling, the bounce feed
  (`server/mailer.js` `classifyBounce`/`markBounce`), quiet-hours, gate ordering. A person
  can reverse a machine-inferred unsubscribe; the machine may never act on a reply as an
  opt-out on its own.
- **DB migrations** (`server/db.js`, `server/parity/schema.js`): must be **idempotent**,
  **preserve every constraint** (FK cascade + CHECK — `PRAGMA table_info` can't see those;
  rewrite the real DDL, see `migrateOutlookProvider`), and ship a test.
- **Anything autonomous that sends email/SMS to real leads.** When in doubt, fail closed
  (defer/hold), never fail open (send).

## Scope: which "rest" are you doing?

- **External / ops finalization** (Stripe, Twilio, Google OAuth verification, off-site
  backups + a rehearsed restore, deploy): these are mostly **not repo work**. Do them in
  the dashboards, use placeholders in config, and document each in a runbook so the audit
  can confirm them against `/api/health` and the go-live checklist.
- **Feature build** (the unbuilt items the audit named — PRODUCT.md workspace-mode spine,
  the purpose guardrail in `PURPOSE-GUARDRAIL-PLAN.md`, the AI spend cap): each feature
  lands behind **a test and a short design note** so the audit has something concrete to
  check against.

## Don't

- Don't chase the 2 TODO tests or the `agent-followup` flake.
- Don't rewrite `Docs/AUDIT-2026-08-12.md` — **append** to it (it's the running ledger).
- Don't commit `tmp/` or `.cursor/` (git-ignored — they held screenshots with real emails).
- Don't add real secrets, merge to main, or deploy.

## Quick reference

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # always
npm run test:server        # node --test tests/*.test.js
npm run test:web           # vitest
npm run build              # vite + postbuild gzip
node --test tests/<one>.test.js   # a single file while iterating
```
