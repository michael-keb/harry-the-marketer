// Public marketing site plumbing: SEO documents, the branded assets the site and
// legal pages reference, and the small public API the site itself calls.
//
// Everything here is reachable without a session — it is the front door.
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { env, ROOT } from './env.js'
import { db } from './db.js'
import { recordTelemetry } from './telemetry.js'
import { rateLimit } from './security.js'
import { BRAND, SITEMAP_ROUTES, PLANS, ANNUAL_DISCOUNT_NOTE } from '../shared/site-content.js'
import { injectSeo, robotsTxt, sitemapXml, isKnownSpaPath } from '../shared/seo.js'

const DIST = path.join(ROOT, 'web', 'dist')
const INDEX_HTML = path.join(DIST, 'index.html')

// Prefer the configured public URL; fall back to the request's own origin so a
// deployment with APP_URL unset still emits usable canonical/OG tags.
export function originFor(req) {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '')
  const proto = (env.TRUST_PROXY && req.headers['x-forwarded-proto']) || req.protocol || 'http'
  const host = (env.TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host
  return `${String(proto).split(',')[0]}://${host}`
}

// A 1200x630 Open Graph card, drawn rather than shipped as a binary.
// Note: X and LinkedIn do not rasterise SVG — drop a PNG at web/public/og-image.png
// and it is preferred automatically (see ogImagePath below).
const OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0b1622"/>
  <g stroke="#16222f" stroke-width="1">
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 56}" x2="1200" y2="${i * 56}"/>`).join('')}
  </g>
  <g transform="translate(88,150)">
    <path d="M0 0v210M120 0v210M0 105h56" stroke="#2fd79b" stroke-width="14" stroke-linecap="round" fill="none"/>
    <path d="M56 105l64-46M56 105l64 46" stroke="#0f9d6e" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
  <text x="88" y="452" font-family="Avenir Next, Segoe UI, Helvetica, Arial, sans-serif" font-size="66" font-weight="700" fill="#ffffff">Harry The <tspan fill="#2fd79b">Marketer</tspan></text>
  <text x="88" y="516" font-family="Avenir Next, Segoe UI, Helvetica, Arial, sans-serif" font-size="34" fill="#93a9be">Outreach campaigns you can draw.</text>
  <text x="88" y="562" font-family="SF Mono, ui-monospace, Menlo, monospace" font-size="24" fill="#2fd79b">A -- reply: interested --&gt; B</text>
</svg>`

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0b1622"/>
  <path d="M9 7v18M23 7v18M9 16h5" stroke="#2fd79b" stroke-width="2.8" stroke-linecap="round" fill="none"/>
  <path d="M14 16l9-5.5M14 16l9 5.5" stroke="#0f9d6e" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`

// Use a real PNG for social cards when the operator supplies one.
function ogImagePath() {
  for (const candidate of ['og-image.png', 'og-image.jpg']) {
    if (fs.existsSync(path.join(DIST, candidate)) || fs.existsSync(path.join(ROOT, 'web', 'public', candidate))) {
      return `/${candidate}`
    }
  }
  return '/og-image.svg'
}

// ---- SPA shell with per-route SEO -------------------------------------------

let cached = { mtime: 0, html: '' }

function readIndexHtml() {
  const stat = fs.statSync(INDEX_HTML)
  if (stat.mtimeMs !== cached.mtime) {
    cached = { mtime: stat.mtimeMs, html: fs.readFileSync(INDEX_HTML, 'utf8') }
  }
  return cached.html
}

export function renderSpa(req, res) {
  try {
    // staticGzip sets these when a .gz sibling exists. If we reached the SPA
    // fallback anyway, the body is fresh HTML — a stale Content-Encoding here
    // would tell the browser to gunzip plain text.
    res.removeHeader('Content-Encoding')
    res.removeHeader('Content-Type')

    const html = injectSeo(readIndexHtml(), req.path, {
      origin: originFor(req),
      ogImage: ogImagePath(),
      forceNoindex: env.SITE_NOINDEX,
      nonce: res.locals.cspNonce,
    })
    // The shell must never be cached — its <meta> varies per route.
    res.set('Cache-Control', 'no-cache, must-revalidate')
    // Serving the 404 page under a 200 is a soft 404: search engines index the
    // "not found" page and the browser records a successful navigation. The
    // shell is identical either way; only the status differs.
    if (!isKnownSpaPath(req.path)) res.status(404)
    res.type('html').send(html)
  } catch (err) {
    console.error('[site] failed to render SPA shell:', err.message)
    res.status(500).type('html').send('<h1>Application unavailable</h1><p>The built frontend is missing. Run <code>npm run build</code>.</p>')
  }
}

export const spaBuildExists = () => fs.existsSync(INDEX_HTML)

// ---- router -----------------------------------------------------------------

export const siteRouter = express.Router()

siteRouter.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(robotsTxt({ origin: originFor(req), noindex: env.SITE_NOINDEX }))
})

siteRouter.get('/sitemap.xml', (req, res) => {
  const lastmod = new Date().toISOString().slice(0, 10)
  res.type('application/xml').send(sitemapXml(SITEMAP_ROUTES, { origin: originFor(req), lastmod }))
})

siteRouter.get('/og-image.svg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(OG_SVG)
})

siteRouter.get('/favicon.svg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(FAVICON_SVG)
})

// ---- public API -------------------------------------------------------------
//
// Mounted at /api/public — outside the authenticated router in routes.js.

export const publicApi = express.Router()
publicApi.use(express.json({ limit: '64kb' }))

// Pricing is served from the same module the site renders from, so an API
// consumer and the page can never disagree.
publicApi.get('/plans', (_req, res) => {
  res.json({
    annualNote: ANNUAL_DISCOUNT_NOTE,
    plans: PLANS.map(({ id, name, monthly, annual, tagline, features, limits, featured }) => ({
      id, name, monthly, annual, tagline, features, limits, featured: Boolean(featured),
    })),
  })
})

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const TOPICS = new Set(['general', 'sales', 'scale', 'security', 'support', 'privacy'])

// 5 submissions per IP per hour — enough for a real person, useless for a bot.
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: 'contact' })

publicApi.post('/contact', contactLimiter, (req, res) => {
  const body = req.body || {}

  // Honeypot: a field hidden from humans. Silently accept so bots stop retrying.
  if (String(body.company_website || '').trim()) {
    return res.json({ ok: true })
  }

  const name = String(body.name || '').trim().slice(0, 120)
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200)
  const company = String(body.company || '').trim().slice(0, 160)
  const topic = TOPICS.has(body.topic) ? body.topic : 'general'
  const message = String(body.message || '').trim().slice(0, 5000)

  if (!name) return res.status(400).json({ error: 'Please tell us your name' })
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
  if (message.length < 10) return res.status(400).json({ error: 'Please add a little more detail (10 characters or more)' })

  try {
    db.prepare(
      'INSERT INTO site_contacts (name, email, company, topic, message, source_ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, email, company, topic, message, String(req.ip || '').slice(0, 64))
  } catch (err) {
    console.error('[site] contact insert failed:', err.message)
    return res.status(500).json({ error: 'We could not record that — please email us directly' })
  }

  recordTelemetry('site', { op: 'contact', ok: true, detail: `${topic} · ${email}` })
  console.log(`[site] contact enquiry (${topic}) from ${email}`)
  res.json({ ok: true, replyTo: BRAND.supportEmail })
})
