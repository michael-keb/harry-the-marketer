# Harry The Marketer — Go-live checklist

**Goal:** `gmskf0xb5` — Harry The Marketer Up and running  
**Deadline:** 2026-09-05  
**Production URL (proposed):** https://harrythemarketer.com

Run `npm run smoke:prod` after each deploy. Use `SMOKE_STRICT=1` on production.

---

## 1. Production smoke test passes

| Step | Command / evidence | Owner |
|---|---|---|
| Core user journey works in production | Sign in → create sandbox mailbox → campaign → approve draft → simulate reply | Eng |
| No obvious broken links or dead pages | `BASE=https://harrythemarketer.com npm run smoke:prod` | Eng |

**Automated:** `npm run smoke:prod` (health, legal pages, plans API, auth config)

---

## 2. Auth0 production login round-trip

| Step | Evidence | Blocked on |
|---|---|---|
| Sign in with Auth0 on production URL | Login → `/app` dashboard | Michael: Auth0 secrets in Render + callback URLs |
| Dev login disabled in production | `/api/health` → `devLogin: false` | `DEV_LOGIN=0` in render.yaml ✓ |

**Auth0 callback URLs to register:**

- `https://harrythemarketer.com/api/auth/callback`
- Logout: `https://harrythemarketer.com/` and `https://harrythemarketer.com/login`

---

## 3. Production env and secrets locked

| Variable | Production value | In repo |
|---|---|---|
| `APP_URL` | `https://harrythemarketer.com` | render.yaml ✓ |
| `TRUST_PROXY` | `1` | render.yaml ✓ |
| `DATA_DIR` | `/var/data` | render.yaml ✓ |
| `DEV_LOGIN` | `0` | render.yaml ✓ |
| `PRODUCTION_STRICT` | `1` (recommended after secrets set) | optional |
| Auth0, Google, OpenAI/Anthropic | Render dashboard only | sync: false ✓ |

**Boot check:** server warns (or exits with `PRODUCTION_STRICT=1`) if misconfigured.

---

## 4. Public hostname and HTTPS live

| Step | Evidence | Blocked on |
|---|---|---|
| DNS points at Harry host | CNAME → Render service | Michael: hostname decision |
| HTTPS cert green | Browser padlock on `/api/health` | Render custom domain |

---

## 5. OAuth callbacks registered for production

| Provider | Redirect URI |
|---|---|
| Auth0 | `https://harrythemarketer.com/api/auth/callback` |
| Google | `https://harrythemarketer.com/api/google/callback` |

See [GOOGLE-OAUTH-VERIFICATION.md](./GOOGLE-OAUTH-VERIFICATION.md) for consent screen rename and test users.

---

## 6. Persistent data disk and backup path

| Step | Evidence |
|---|---|
| SQLite survives redeploy | Render disk `harry-data` at `/var/data` (render.yaml ✓) |
| Restore/backup runbook exists | [BACKUP-RUNBOOK.md](./BACKUP-RUNBOOK.md) ✓ |

**Backup command:** `DATA_DIR=/var/data npm run backup:db`

---

## 7. Gmail mailbox connects in production

| Step | Evidence | Blocked on |
|---|---|---|
| Connect real Gmail on production | Mailboxes → Connect Gmail | Google test users or verification |
| Test users cover operator mailboxes | OAuth succeeds for listed emails | Google console |

---

## 8. Legal pages with real operator details

| Variable | render.yaml default |
|---|---|
| `LEGAL_ENTITY_NAME` | Elnakeeb Pty Ltd ✓ |
| `LEGAL_JURISDICTION` | New South Wales, Australia ✓ |
| `/privacy`, `/terms` reachable | smoke test ✓ |

Confirm entity details with Michael if different from render.yaml.

---

## 9. Live approval-to-send-to-reply path

| Step | Evidence |
|---|---|
| Approve draft and send from production mailbox | Inbox → Needs your OK → Send |
| Reply lands in Inbox and engine routes | Gmail reply or sandbox simulate |

Use sandbox first on production; Gmail after Google OAuth is unblocked.

---

## 10. Stripe live checkout for Harry plan

| Step | Evidence | Blocked on |
|---|---|---|
| Live Payment Link matches published plan price | Settings → Billing or `/api/billing/checkout` | Michael: Stripe keys + Payment Links |
| Test purchase completes and can be refunded | Stripe dashboard receipt + refund | Live keys |

**Env vars:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_LINK_STARTER` (and growth/scale as needed)

**Webhook URL:** `https://harrythemarketer.com/api/billing/webhook`

---

## 11. Paid signup provisions a workspace

| Step | Evidence |
|---|---|
| Buy → receipt → access path defined | [PROVISIONING-RUNBOOK.md](./PROVISIONING-RUNBOOK.md) ✓ |
| One real paid user can sign in and use Harry | Webhook sets `plan_id` on user; `/api/auth/me` shows billing |

**Flow:** Sign up (Auth0) → open Payment Link → pay → webhook provisions plan → user continues in `/app`.

---

## 12. Launch checklist monitoring and handover

| Step | Evidence |
|---|---|
| Monitoring/alerts watching production host | `/app/monitoring` + Render health checks |
| Go/no-go logged and operator runbook handed over | Sign-off below |

**Ops dashboard:** `https://harrythemarketer.com/app/monitoring`

---

## Go / no-go sign-off

| Check | Pass | Date | Notes |
|---|---|---|---|
| Smoke test (`SMOKE_STRICT=1`) | ☐ | | |
| Auth0 login round-trip | ☐ | | |
| Legal pages live | ☐ | | |
| Backup taken and restore tested | ☐ | | |
| Stripe test purchase + refund | ☐ | | |
| Gmail connect (test user) | ☐ | | |
| Approval → send → reply | ☐ | | |

**Decision:** ☐ Go  ☐ No-go  
**Signed:** _______________  **Date:** _______________
