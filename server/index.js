import express from 'express'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { env, ROOT, auth0Configured, googleConfigured, twilioEnvConfigured, smsflowEnvConfigured, devLoginEnabled, isProduction } from './env.js'
import { authRouter, sessionUid } from './auth.js'
import { billingRouter, handleBillingWebhook } from './billingRoutes.js'
import { billingConfigured } from './billing.js'
import { googleRouter } from './google.js'
import { microsoftRouter } from './microsoft.js'
import { twilioRouter, smsflowRouter } from './channels/webhook.js'
import { legalRouter } from './legal.js'
import { trackingRouter } from './tracking.js'
import { consentRouter } from './consent.js'
import { siteRouter, publicApi, renderSpa, spaBuildExists } from './site.js'
import { securityHeaders, compression, staticGzip, rateLimit } from './security.js'
import { api } from './routes.js'
import { startEngine, stopEngine } from './engine.js'
import { onEvent, db } from './db.js'
import { sealLegacyTokens } from './secrets.js'
import { fireWebhooks, normalizeEventType } from './parity/webhooks.js'
import { notify } from './alerts.js'

const app = express()
app.disable('x-powered-by')

// Behind a reverse proxy / PaaS, req.ip and req.protocol must come from the
// forwarded headers or rate limiting and HSTS both key off the proxy instead.
if (env.TRUST_PROXY) app.set('trust proxy', 1)

app.use(securityHeaders)
app.use(compression)

// Tiny cookie parser — enough for our single session cookie.
app.use((req, res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) {
    for (const pair of header.split(';')) {
      const idx = pair.indexOf('=')
      if (idx > 0) req.cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim())
    }
  }
  next()
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    auth0: auth0Configured(),
    google: googleConfigured(),
    twilio: twilioEnvConfigured(),
    smsflow: smsflowEnvConfigured(),
    devLogin: devLoginEnabled(),
    billing: billingConfigured(),
    appUrl: env.APP_URL,
    dataDir: Boolean(process.env.DATA_DIR),
  })
})

// Stripe webhook must read raw bytes — register before any JSON body parser.
app.use(async (req, res, next) => {
  if (await handleBillingWebhook(req, res)) return
  next()
})

app.use(siteRouter) // public: robots.txt, sitemap.xml, favicon, OG image
app.use(legalRouter) // public: /privacy /terms /acceptable-use /dpa /sub-processors /cookies
app.use('/api/public', publicApi) // public: /plans, /contact
app.use(authRouter)
app.use(billingRouter)
app.use(googleRouter)
app.use(microsoftRouter)
app.use('/api/hooks/twilio', rateLimit({ windowMs: 60_000, max: 120, key: 'twilio' }), twilioRouter)
app.use('/api/hooks/smsflow', rateLimit({ windowMs: 60_000, max: 120, key: 'smsflow' }), smsflowRouter)
// Public and hit by every recipient's mail client — capped so a scanner loop
// or a scripted sweep cannot hammer SQLite through unauthenticated endpoints.
// The limiter is scoped to the tracking prefix, not mounted app-wide: mounted
// without a path it counted EVERY request (API, SPA, static asset) into the
// 300/min 'track' bucket, so an office behind one NAT tripped a limit meant
// only for the open pixel and click/unsubscribe endpoints.
app.use('/t', rateLimit({ windowMs: 60_000, max: 300, key: 'track' }))
app.use(trackingRouter) // public: open pixel, click redirects, unsubscribe (all under /t/)
// public: the agreement page recipients sign — server-rendered, no JS needed
app.use('/agree', rateLimit({ windowMs: 60_000, max: 60, key: 'consent' }), consentRouter)
// Every one of the 210 endpoint specs in Docs/ carries a rate-limit test case,
// and until now the limiter was applied to the consent page and the SPA shell
// but never to the API itself — so all 210 of those cases were unmeetable.
//
// Keyed on the session rather than the address: an agency behind one office IP
// is many people, and throttling them as one is the kind of limit that gets
// switched off in production and never switched back on. Anonymous callers
// still fall back to the address. The ceiling is deliberately generous — this
// is a brake on runaway loops and scraping, not on ordinary use, and the
// engine does not pass through here at all.
//
// The key is the VERIFIED session identity, not the raw htm_session cookie: a
// forged or rotating cookie fails HMAC verification and falls through to the
// caller's address, so it cannot mint a fresh 600/min bucket per request and
// defeat the ceiling (nor grow the bucket Map without bound).
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 600,
  key: 'api',
  by: (req) => sessionUid(req),
  message: 'Too many requests — please wait a moment and try again',
}), api)

// Any /api path not claimed above is a 404 in JSON, never the SPA shell.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }))

// The app used to live at the site root. Anything bookmarked from that era
// still works.
const LEGACY_APP_PATHS = ['/goals', '/campaigns', '/inbox', '/leads', '/reports', '/monitoring', '/mailboxes', '/connections', '/settings']
for (const legacy of LEGACY_APP_PATHS) {
  app.get([legacy, `${legacy}/*`], (req, res) => {
    const query = req.originalUrl.slice(req.path.length)
    res.redirect(301, `/app${req.path}${query}`)
  })
}

// Production: serve the built SPA. In dev, Vite serves the frontend and proxies
// /api (and the public site routes) here.
if (spaBuildExists()) {
  const dist = path.join(ROOT, 'web', 'dist')
  // Serve the pre-compressed .gz sibling when the client accepts gzip.
  app.use(staticGzip(dist, { existsSync, extname: path.extname }))
  // Hashed bundle filenames are safe to cache forever; everything else is not.
  app.use(
    express.static(dist, {
      index: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        // express.static streams files; our compression must not wrap a pipe.
        res.locals.skipCompression = true
        if (/[.-][a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp)(?:\.gz)?$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600')
        }
      },
    })
  )
  // SPA fallback, with per-route SEO tags injected into the shell.
  app.get(/^(?!\/api\/).*/, rateLimit({ windowMs: 60_000, max: 300, key: 'spa' }), renderSpa)
} else if (isProduction()) {
  console.warn('[server] web/dist is missing — run `npm run build` before `npm start`')
}

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err)
  if (res.headersSent) return next(err)
  const wantsJson = req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json'
  if (wantsJson) return res.status(500).json({ error: 'Internal server error — check server logs' })
  res.status(500).type('html').send('<h1>Something went wrong</h1><p>Please try again shortly.</p>')
})

// ---- outbound webhooks -------------------------------------------------------

// Every domain event already passes through `logEvent`, so subscribing once
// here is what makes the webhook registry actually deliver — and makes a new
// event type deliverable the day it is added rather than the day someone
// remembers to call the dispatcher from a fortieth call site.
//
// `fireWebhooks` never throws and never rejects (it records failures and backs
// off internally), so this is fire-and-forget on purpose: a slow or dead
// customer endpoint must not hold up the engine tick that produced the event.
onEvent(({ workspaceId, campaignId, leadId, type, detail }) => {
  if (!normalizeEventType(type)) return // not a published event; nothing to send
  void fireWebhooks(workspaceId, type, {
    campaign_id: campaignId,
    lead_id: leadId,
    detail,
  })
})

// ---- chat alerts -------------------------------------------------------------

// Slack/Teams pings previously came from exactly two files, so none of the
// operational events the parity work introduced ever reached anyone: a mailbox
// could be suspended, a webhook endpoint could auto-pause after five straight
// failures, and the first you would know is when the numbers looked wrong.
//
// Subscribing to `logEvent` rather than editing each call site keeps the list
// of what is worth interrupting someone for in one readable place. Everything
// else stays in the activity trail, which is where most events belong: an
// alert that fires for everything is an alert nobody reads.
const ALERT_ON = {
  mailbox_suspended: { title: 'Mailbox suspended', link: '/app/connections' },
  webhook_paused: { title: 'Webhook endpoint paused', link: '/app/settings/alerts' },
  client_over_allowance: { title: 'Client over their allowance', link: '/app/settings/team' },
  campaign_paused: { title: 'Campaign paused', link: '/app/campaigns' },
  deliverability_test_stopped: { title: 'Placement test stopped', link: '/app/monitoring' },
  send_refused: { title: 'A send was refused', link: '/app/inbox' },
  prospect_fetch_refused: { title: 'Prospect fetch refused', link: '/app/leads' },
}

onEvent(({ workspaceId, type, detail }) => {
  const alert = ALERT_ON[type]
  if (!alert) return
  notify(workspaceId, { title: alert.title, text: detail || '', link: alert.link })
})

// ---- startup ----------------------------------------------------------------

// Loud, specific warnings beat a silently misconfigured production deployment.
if (isProduction()) {
  const problems = []
  if (!auth0Configured()) problems.push('AUTH0_* is not configured — real sign-in is unavailable')
  if (devLoginEnabled()) problems.push('DEV_LOGIN is active in production — anyone can sign in as any email')
  if (!env.APP_URL || env.APP_URL.includes('localhost')) problems.push('APP_URL still points at localhost — OAuth callbacks, tracking links, and canonical URLs will be wrong')
  if (!env.LEGAL_ENTITY_NAME || !env.LEGAL_JURISDICTION) problems.push('LEGAL_ENTITY_NAME / LEGAL_JURISDICTION are unset — the legal pages will say "to be confirmed"')
  if (!env.DATA_DIR) problems.push('DATA_DIR is unset — SQLite will live on ephemeral disk and be wiped on redeploy')
  if (!env.TRUST_PROXY) problems.push('TRUST_PROXY is unset — rate limits and client IP will be wrong behind Render')
  for (const p of problems) {
    if (env.PRODUCTION_STRICT) {
      console.error(`[server] FATAL: ${p}`)
    } else {
      console.warn(`[server] WARNING: ${p}`)
    }
  }
  if (env.PRODUCTION_STRICT && problems.length) {
    console.error('[server] PRODUCTION_STRICT=1 — refusing to start with the above problems')
    process.exit(1)
  }
}

const server = app.listen(env.PORT, () => {
  console.log(`[server] API listening on http://localhost:${env.PORT}`)
  console.log(`[server] auth0=${auth0Configured() ? 'configured' : 'NOT configured (dev login active)'} google=${googleConfigured() ? 'configured' : 'NOT configured (sandbox mailboxes only)'}`)
  // Seal any plaintext OAuth/Twilio tokens left from before at-rest encryption,
  // and re-seal any that only open under a fallback key after a key rotation.
  try { sealLegacyTokens() } catch (err) {
    console.error('[server] sealLegacyTokens failed:', err?.message || err)
  }
  startEngine()
})

// On Node 22 an unhandled promise rejection (or uncaught exception) terminates
// the process by default. A single fire-and-forget path that rejects — an
// outbound webhook, an alert ping, a stray await — would take the whole server
// down with it. Convert the crash into a diagnosable log line instead: log with
// enough detail to find the culprit, and keep serving. Genuine fatal signals
// still shut down cleanly below.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] unhandledRejection (logged, not fatal):', reason instanceof Error ? reason.stack || reason.message : reason, promise)
})
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (logged, not fatal):', err?.stack || err)
})

// Finish in-flight requests and stop the engine cleanly on a deploy signal.
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} received — shutting down`)
    stopEngine()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
