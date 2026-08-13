# Production Test Checklist — audit-fixes-2026-08-12

Everything that needs testing before and after this branch goes live. Built from the
end-to-end audit + 4 remediation passes ([AUDIT-2026-08-12.md](./AUDIT-2026-08-12.md)).

**Legend:**
- `[auto]` — covered by the automated suites; re-running them is the test.
- `[local]` — verify by hand on a local dev run before deploying.
- `[prod]` — can only be verified on production, after deploy.
- `[blocker]` — do not send to real leads until this passes.

---

## 0. Automated gates (run first, on Node 22)

- [ ] `[auto]` Server suite green: `npm run test:server` → **1454 pass / 0 fail / 2 TODO**
      (the 2 TODOs are documented feature gaps; `agent-followup.test.js` is a
      time-of-day flake — re-run, don't fix)
- [ ] `[auto]` Web suite green: `npm run test:web` → **116/116**
- [ ] `[auto]` Build clean: `npm run build`
- [ ] `[local]` Server boots with no errors; boot log shows
      `[secrets] sealed legacy tokens: …` on first boot against an existing DB
      (and nothing on the second boot — sweep is idempotent)

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" && npm run test:server && npm run test:web && npm run build
```

---

## 1. Auth & sessions

- [ ] `[prod]` Login via Auth0 works end-to-end; `/api/health` shows `auth0: true`
- [ ] `[auto]` Logout revokes **all** sessions (session-epoch bump) — a copied cookie
      is dead after logout (`tests/secrets-sessions.test.js`)
- [ ] `[prod]` `POST /api/auth/dev-login` returns **404** in production — even with
      `DEV_LOGIN=1` present (hard refusal, auth.js:265)
- [ ] `[local]` Logging out on one browser signs out other browsers/devices too
      (deliberate side effect of epoch revocation — confirm it's acceptable UX)

## 2. Mailbox connections & token encryption

- [ ] `[prod]` Connect a Gmail mailbox via OAuth → lands on Connections as connected
- [ ] `[prod]` Connect an Outlook mailbox (if used) → same
- [ ] `[prod]` After connect, DB rows for `access_token`/`refresh_token` are sealed
      (`v1.…` prefix), not plaintext — check via a DB copy, never log the values
- [ ] `[auto]` Legacy plaintext tokens sealed on boot; fallback-key blobs re-sealed
      under the preferred key (`tests/secrets-sessions.test.js`)
- [ ] `[prod]` `TOKENS_ENCRYPTION_KEY` set in Render **before** the first mailbox
      connect — and treated as immutable from then on (GO-LIVE-CHECKLIST warning)
- [ ] `[prod]` Token refresh works: leave the mailbox >1h, send a test email — no
      reconnect prompt, no `[secrets]` errors in Render logs
- [ ] `[local]` `invalid_grant` (revoke access in Google account settings) flags the
      mailbox `needs_reconnect` rather than stranding leads in `error`

## 3. Sending engine — core safety `[blocker]`

- [ ] `[auto]` Quiet-hours floor 06:00–21:00 unbypassable; working windows, blackouts,
      start/end dates enforced (`tests/send-rules-defaults.test.js`)
- [ ] `[auto]` `at HH:MM` / `window` clocks in the past roll forward to the next
      occurrence — never fire immediately (`tests/step-timing.test.js`)
- [ ] `[auto]` No-reply edges honour their authored delays — a `no reply 7d → SMS`
      edge cannot fire at day 3 (`tests/intents-engine.test.js`)
- [ ] `[auto]` Per-lead lifetime ceilings: max 25 sends / 120 days finishes the lead;
      cross-tick no-reply loops are bounded
- [ ] `[auto]` Transient send failures back off and retry; only permanent failures go
      terminal; SMS is gated by its own quota, not the email mailbox's
- [ ] `[auto]` Suppression enforced at the single transport chokepoint — unsubscribed/
      bounced/blocked-domain leads cannot be emailed by any path
- [ ] `[local]` Launch a 2-step test campaign against your own inboxes: emails arrive,
      correct subject/footer, follow-up honours the wait, stops on reply

## 4. Bounce feed & send health `[blocker]`

- [ ] `[auto]` A DSN/MAILER-DAEMON reply marks the lead `bounced` and the message
      `bounced`; transient 4.x.x defers do NOT (`tests/bounce-feed.test.js`)
- [ ] `[prod]` Send to a guaranteed-bounce address (e.g. a made-up user on a real
      domain) → lead flips to bounced within one sync cycle; `/send-health` reflects
      it; the bounce brake reacts
- [ ] `[prod]` Warm-up auto-adjust visible on a fresh mailbox (low daily cap ramping)

## 5. Replies & inbox `[blocker]`

- [ ] `[prod]` Reply to a campaign email from the lead's inbox → appears in Harry's
      Inbox within ~5 min (sweep) or ~10s (Sync button)
- [ ] `[auto]` `LEAD_REPLIED` fires for active-campaign replies (engine path) — not
      just the sweep path
- [ ] `[auto]` Reply classification uses fresh text only — a quoted unsubscribe footer
      cannot opt a lead out
- [ ] `[auto]` Machine-inferred unsubscribes are parked for human confirmation; a
      human can reverse one; the machine can never act on it alone
- [ ] `[auto]` Inbound watermark + paging: replies not lost after >3-day downtime
- [ ] `[auto]` `POST /api/inbox/sync` rate-limited (30/min/session)
- [ ] `[prod]` Reply from a **second** workspace's connected copy of the same mailbox
      is not swallowed by the first (workspace-scoped dedupe) — only if you run
      multiple workspaces
- [ ] `[prod]` Forward with BCC: recipient sees only To/Cc — BCC not leaked on the wire

## 6. Unsubscribe & compliance `[blocker]`

- [ ] `[prod]` Unsubscribe link: GET shows a confirm button (no one-click-by-scanner),
      POST unsubscribes; List-Unsubscribe headers present (RFC 8058)
- [ ] `[auto]` Custom opt-out wording actually ships in the footer (was decorative)
- [ ] `[auto]` Plain-text campaigns send genuinely without an HTML alternative
- [ ] `[auto]` Stop-on-open / stop-on-click / treat-reply-as-stop are enforced
- [ ] `[auto]` Prospect-fetch import suppression-checks — cannot re-activate an opt-out
- [ ] `[prod]` Legal pages (privacy, terms) reachable from the marketing site

## 7. SMS channel `[blocker if SMS enabled]`

- [ ] `[prod]` `SMSFLOW_API_KEY` set in Render; `/api/health` shows `smsflow: true`
- [ ] `[prod]` Test SMS from Settings → Channels arrives; per-row test input works
- [ ] `[auto]` Opt-in required before any SMS; consent UI records it
- [ ] `[prod]` Reply STOP → lead opted out + confirmation SMS; START re-opts;
      HELP answers (SMSFlow webhook token verified in prod, not sandbox)
- [ ] `[auto]` SMS quiet hours + own daily cap enforced; email mailbox cap does not
      gate SMS
- [ ] `[auto]` AI-composed SMS is metered (spend cap) and purpose-guarded — the
      email→SMS no-reply switch cannot skip either (`tests/ai-spend.test.js`,
      `tests/purpose.test.js`)

## 8. Purpose guardrail (non-commercial plans)

- [ ] `[auto]` Launch gate refuses a non-commercial plan whose playbook step reads
      like a pitch, naming the step and sentence (`tests/purpose.test.js`)
- [ ] `[auto]` Post-compose backstop parks a pitchy email OR SMS as a draft +
      `needs_attention` — fails closed, never sends
- [ ] `[auto]` Currency variants caught: `$/£/€`, `AUD 500`, `"500 dollars"`,
      "my fee" / "I charge" paraphrases
- [ ] `[local]` UI: purpose picker on campaign Behaviour panel saves and round-trips;
      blocked compose shows the "reads like a pitch" notification with the quoted line
- [ ] `[local]` A `commercial` campaign is completely unaffected by the guardrail

## 9. AI spend cap

- [ ] `[auto]` Every paid path metered: research / compose / classify / SMS compose /
      plan / generate-playbook / preview / step-sample / qualify
      (`tests/ai-spend.test.js`)
- [ ] `[auto]` Exhausted allowance fails soft: research skipped, compose → template,
      classify → heuristic — sends keep flowing
- [ ] `[auto]` Concurrent ticks cannot exceed the cap (atomic check-and-charge);
      provider outages refund, model refusals don't
- [ ] `[local]` Monitoring shows "this month $X of $Y" and the exhausted notice
- [ ] `[prod]` `[blocker]` Stripe webhook writes `plan_id` as exactly
      `starter` / `growth` / `scale` — anything else silently gets the $5 trial
      ceiling. Verify on the first live subscription.

## 10. Billing (Stripe live)

- [ ] `[prod]` Live keys set (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`);
      payment links swapped from `buy.stripe.com/test_…` to live
- [ ] `[prod]` `/api/health` shows `billing: true`
- [ ] `[prod]` Real checkout with a real card → workspace provisioned on the right
      plan; webhook signature verified (raw-body)
- [ ] `[prod]` Cancel/past-due drops the workspace to the trial AI ceiling

## 11. Security & abuse

- [ ] `[auto]` `/api` rate limiter keys on verified session (forged cookies can't
      dodge it); tracking limiter scoped to `/t` only — SPA/API traffic never hits it
      (`tests/audit-security-fixes.test.js`)
- [ ] `[auto]` Webhook SSRF closed: IPv6-mapped literals, redirects, DNS-rebinding all
      re-checked against resolved IPs (`tests/parity-webhooks.test.js`)
- [ ] `[auto]` Webhook CRUD gated to owner/manager (members can't exfiltrate replies)
- [ ] `[auto]` Cross-tenant writes scoped by `user_id` (messages updates, manual-reply)
- [ ] `[prod]` CSP + HSTS headers present on the live site (check response headers)
- [ ] `[prod]` An unauthenticated request to `/api/*` gets 401, not data

## 12. Tracking & outbound webhooks

- [ ] `[auto]` Click redirect is signed — no open-redirect via `/t`
- [ ] `[prod]` Open + click tracking fire on a real send (check campaign stats)
- [ ] `[auto]` Outbound webhooks signed; tombstones + idempotency on delete;
      auto-pause counts events, not attempts
- [ ] `[prod]` A real subscribed webhook endpoint receives `LEAD_REPLIED` with a
      valid signature

## 13. Deployment & ops (the go-live run itself)

- [ ] `[prod]` `[blocker]` All env placeholders in Render filled: `STRIPE_*`,
      `SMSFLOW_*`, `MICROSOFT_*` (if used), `ANTHROPIC_API_KEY`,
      `TOKENS_ENCRYPTION_KEY`, `TRUST_PROXY`, `PRODUCTION_STRICT=1`
- [ ] `[prod]` Deploy is **manual**: merge to main does NOT auto-deploy —
      `render deploys create srv-d9rpmtgn74is73fb3kt0 --confirm`
- [ ] `[prod]` Post-deploy: `/api/health` → `ok`, `auth0: true`, `google: true`,
      plus `billing`/`smsflow` as configured; Render logs clean (no `[secrets]`
      errors, one-time seal-sweep line only on first boot)
- [ ] `[prod]` Strict-boot guard: missing required env fails the boot loudly
- [ ] `[prod]` Daily online backup ran (04:00 UTC) — check the backup dir after the
      first night
- [ ] `[prod]` `[blocker before real scale]` Off-site backup sync configured
      (backups currently share the 1GB app disk) + one rehearsed restore following
      BACKUP-RUNBOOK.md
- [ ] `[prod]` Google OAuth verification submitted (until approved: 100-test-user cap,
      Gmail tokens expire ~weekly → weekly manual reconnect)

## 14. UI smoke pass (15 minutes, on prod)

- [ ] Connections: mailbox list, status chips, reconnect button
- [ ] Campaigns: create → playbook editor → Behaviour panel (subject, purpose,
      opt-out wording, reply-handling) → launch gate messages → launch
- [ ] Approval flow: gated campaign shows draft, confirm modal (no silent
      auto-confirm), approve → sends
- [ ] Inbox: reply thread renders, classify chip, Sync button, forward/reply
- [ ] Monitoring: engine ticks, AI spend meter, telemetry populated
- [ ] Send controls / send health: caps, quiet hours, bounce list (and its
      failed-to-load state is honest if the API errors)
- [ ] Leads: import a small CSV, tags/notes/tasks, per-lead research button
      (respects AI budget message when exhausted)

---

## Suggested order of execution

1. §0 automated gates locally (10 min)
2. §1–§2 auth + mailbox on prod right after deploy (§13 health checks first)
3. §3–§6 one real end-to-end campaign against your own inboxes — this exercises
   engine, bounce, replies, unsubscribe in one pass
4. §7 SMS loop (if enabled), §8–§9 purpose + spend with a deliberately pitchy
   non-commercial test campaign
5. §10 one real Stripe checkout, then confirm the `plan_id` lands correctly (§9)
6. §11–§12 header/webhook spot checks, §14 UI smoke
7. §13 backups + restore drill within the first week
