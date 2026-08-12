import crypto from 'node:crypto'
import express from 'express'
import { db, sessionSecret, logEvent, resolveWorkspace } from './db.js'
import { env, auth0Configured, devLoginEnabled, isProduction } from './env.js'
import { rateLimit } from './security.js'
import { composeBusinessContext, parseProfile } from '../shared/profile.js'
import { isSupportedWebhook } from './alerts.js'
import { billingStatus } from './billing.js'

const SECRET = sessionSecret()
const COOKIE = 'htm_session'
const WEEK = 7 * 24 * 3600 * 1000

// Where a successful sign-in lands. The marketing site owns '/'.
export const APP_HOME = '/app'

// Only ever redirect to our own paths — never to a caller-supplied origin.
// '//evil.com' and '/\evil.com' are browser-protocol-relative URLs, not paths.
export function safeNext(value, fallback = APP_HOME) {
  const next = String(value || '')
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (next.startsWith('/api/')) return fallback
  return next
}

// ---- signed cookie sessions -------------------------------------------------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}

function verify(token) {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!payload.uid || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function setSession(res, userId) {
  const token = sign({ uid: userId, exp: Date.now() + WEEK })
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: WEEK,
    path: '/',
    // Never send the session over plain HTTP once we are actually deployed.
    secure: isProduction(),
  })
}

export function currentUser(req) {
  const payload = verify(req.cookies?.[COOKIE])
  if (!payload) return null
  return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) || null
}

// The verified session's user id, or null. Used to key rate limiters on a
// caller we can actually attribute: a forged or rotating cookie fails the HMAC
// check and yields null, so the limiter falls back to the caller's address
// rather than minting a fresh bucket per request. Does not touch the database —
// cheap enough to run on every request.
export function sessionUid(req) {
  const payload = verify(req.cookies?.[COOKIE])
  return payload ? payload.uid : null
}

// Middleware for API routes: 401 JSON when not signed in.
export function requireUser(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'not_authenticated' })
  req.user = user
  next()
}

// Middleware: resolve the workspace this user operates in (their own, or the
// team workspace they were invited to). All data access is keyed to req.wsId.
export function workspace(req, res, next) {
  const ws = resolveWorkspace(req.user)
  req.wsId = ws.wsId
  req.wsRole = ws.role
  req.wsOwnerEmail = ws.ownerEmail
  next()
}

function upsertUser({ sub, email, name = '', picture = '' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const canonical = normalizedEmail
    ? db.prepare('SELECT * FROM users WHERE lower(email) = ? ORDER BY id LIMIT 1').get(normalizedEmail)
    : null

  const existing = db.prepare('SELECT * FROM users WHERE sub = ?').get(sub)
  if (existing) {
    const userId = canonical?.id ?? existing.id
    db.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?')
      .run(normalizedEmail || existing.email, name || existing.name, picture || existing.picture, userId)
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  }
  if (canonical) {
    db.prepare('UPDATE users SET name = ?, picture = ? WHERE id = ?')
      .run(name || canonical.name, picture || canonical.picture, canonical.id)
    return db.prepare('SELECT * FROM users WHERE id = ?').get(canonical.id)
  }
  const info = db.prepare('INSERT INTO users (sub, email, name, picture) VALUES (?, ?, ?, ?)')
    .run(sub, normalizedEmail || email, name, picture)
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)
  logEvent(user.id, { type: 'signup', detail: normalizedEmail || email })
  return user
}

// ---- routes -----------------------------------------------------------------

export const authRouter = express.Router()

// Frontend asks: how do I log in here, and who am I?
authRouter.get('/api/auth/config', (req, res) => {
  res.json({ auth0: auth0Configured(), devLogin: devLoginEnabled() })
})

authRouter.get('/api/auth/me', (req, res) => {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'not_authenticated' })
  const ws = resolveWorkspace(user)
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ws.wsId)
  res.json({
    id: user.id, email: user.email, name: user.name, picture: user.picture,
    businessContext: owner?.business_context ?? '',
    meetingLink: owner?.meeting_link ?? '',
    profile: parseProfile(owner?.profile),
    requireApproval: Boolean(owner?.require_approval),
    sending: {
      paced: Boolean(owner?.paced),
      from: owner?.send_from || '08:30',
      to: owner?.send_to || '17:30',
      days: owner?.send_days || 'weekdays',
      timezone: owner?.send_timezone || '',
    },
    alertWebhook: owner?.alert_webhook ?? '',
    consentTerms: owner?.consent_terms ?? '',
    sheet: { id: owner?.sheet_id ?? '', url: owner?.sheet_url ?? '', syncedAt: owner?.sheet_synced_at ?? '' },
    workspace: { role: ws.role, ownerEmail: ws.ownerEmail, shared: ws.wsId !== user.id },
    billing: billingStatus(owner || user),
  })
})

// Auth0 authorization-code flow (no SDK; plain OIDC).
const pendingStates = new Map() // state -> { expiry, next }

// `screen_hint=signup` opens Auth0's signup tab — this is what makes /signup a
// genuinely different destination from /login rather than the same form twice.
authRouter.get('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 30, key: 'auth-start' }), (req, res) => {
  const next = safeNext(req.query.next)
  if (!auth0Configured()) {
    return res.redirect(`/login?error=auth0_not_configured&next=${encodeURIComponent(next)}`)
  }
  const state = crypto.randomBytes(16).toString('hex')
  pendingStates.set(state, { expiry: Date.now() + 10 * 60 * 1000, next })
  const url = new URL(`https://${env.AUTH0_DOMAIN}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', env.AUTH0_CLIENT_ID)
  url.searchParams.set('redirect_uri', `${env.APP_URL}/api/auth/callback`)
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('state', state)
  // Audience + first-party API "Allow Skipping User Consent" skips the Authorize App screen.
  if (env.AUTH0_AUDIENCE) url.searchParams.set('audience', env.AUTH0_AUDIENCE)
  if (req.query.screen_hint === 'signup') url.searchParams.set('screen_hint', 'signup')
  res.redirect(url.toString())
})

authRouter.get('/api/auth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: desc } = req.query
    if (error) return res.redirect(`/login?error=${encodeURIComponent(desc || error)}`)
    const pending = pendingStates.get(state)
    pendingStates.delete(state)
    for (const [s, p] of pendingStates) if (p.expiry < Date.now()) pendingStates.delete(s)
    if (!pending || pending.expiry < Date.now()) return res.redirect('/login?error=invalid_state')

    const tokenRes = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: env.AUTH0_CLIENT_ID,
        client_secret: env.AUTH0_CLIENT_SECRET,
        code,
        redirect_uri: `${env.APP_URL}/api/auth/callback`,
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`)
    const tokens = await tokenRes.json()

    // Prefer ID token claims (always present with openid). userinfo can fail when the
    // access token is an API JWT rather than an opaque /userinfo token.
    let profile = null
    if (tokens.id_token) {
      try {
        const payload = tokens.id_token.split('.')[1]
        profile = JSON.parse(Buffer.from(payload, 'base64url').toString())
      } catch {
        profile = null
      }
    }
    if (!profile?.sub) {
      const userRes = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (!userRes.ok) throw new Error(`userinfo failed: ${await userRes.text()}`)
      profile = await userRes.json()
    }

    // upsertUser merges accounts by email address, so the email claim is an
    // identity assertion, not decoration. An unverified claim from a second
    // Auth0 connection (social login, a database connection without email
    // verification) would let anyone who *types* victim@example.com land in
    // the victim's workspace. A profile carrying an email must have proven it.
    if (profile.email && profile.email_verified === false) {
      console.warn('[auth] refused login with unverified email claim:', profile.email)
      return res.redirect(`/login?error=${encodeURIComponent('Verify your email address first — check your inbox for the confirmation link')}`)
    }

    const user = upsertUser({
      sub: profile.sub,
      email: profile.email || `${profile.sub}@no-email.auth0`,
      name: profile.name || profile.nickname || '',
      picture: profile.picture || '',
    })
    setSession(res, user.id)
    res.redirect(safeNext(pending.next))
  } catch (err) {
    console.error('[auth] callback error', err)
    res.redirect(`/login?error=${encodeURIComponent('Login failed — check server logs and Auth0 settings')}`)
  }
})

// Dev login: only when Auth0 is not configured (or DEV_LOGIN explicitly enabled).
authRouter.post(
  '/api/auth/dev-login',
  rateLimit({ windowMs: 15 * 60_000, max: 20, key: 'dev-login', message: 'Too many sign-in attempts — wait a few minutes' }),
  express.json(),
  (req, res) => {
    // In production this route must not exist. Signing anyone in as any email is
    // a total account takeover; a soft warning gated on PRODUCTION_STRICT was not
    // enough, so refuse outright — as if the route were never registered —
    // regardless of PRODUCTION_STRICT or DEV_LOGIN.
    if (isProduction()) return res.status(404).json({ error: 'Unknown endpoint' })
    if (!devLoginEnabled()) return res.status(403).json({ error: 'dev_login_disabled' })
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
    const name = String(req.body?.name || '').trim()
    const existing = db.prepare('SELECT id FROM users WHERE sub = ?').get(`dev:${email}`)
    const user = upsertUser({ sub: `dev:${email}`, email, name })
    setSession(res, user.id)
    res.json({ ok: true, created: !existing, redirect: safeNext(req.body?.next) })
  }
)

authRouter.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' })
  // Sign-out returns to the marketing site, not the login form — a signed-out
  // visitor is a visitor again.
  if (auth0Configured()) {
    const url = new URL(`https://${env.AUTH0_DOMAIN}/v2/logout`)
    url.searchParams.set('client_id', env.AUTH0_CLIENT_ID)
    url.searchParams.set('returnTo', `${env.APP_URL}/`)
    return res.json({ ok: true, redirect: url.toString() })
  }
  res.json({ ok: true, redirect: '/' })
})

// Everything the agent is briefed with lives on the workspace owner, so the
// whole team (and any coach reviewing sends) works from one answer.
// `/api/settings/business-context` is the old path and still works.
authRouter.put(['/api/settings', '/api/settings/business-context'], express.json(), requireUser, workspace, (req, res) => {
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const body = req.body || {}
  const link = body.meetingLink !== undefined ? String(body.meetingLink).trim() : owner.meeting_link
  if (link && !/^https?:\/\/\S+$/.test(link)) return res.status(400).json({ error: 'Meeting link must be a full URL (https://...)' })

  const hook = body.alertWebhook !== undefined ? String(body.alertWebhook).trim() : owner.alert_webhook
  if (hook && !isSupportedWebhook(hook)) {
    return res.status(400).json({ error: "That doesn't look like a Slack or Teams webhook URL — it should start with https:// and come from your channel's incoming-webhook setup" })
  }

  // The guided answers are the source of truth; the briefing string every
  // prompt already reads is composed from them. A workspace that only ever
  // typed free text keeps it until it answers a question.
  let profileJson = owner.profile
  let context = body.businessContext !== undefined ? String(body.businessContext) : owner.business_context
  if (body.profile !== undefined && body.profile && typeof body.profile === 'object') {
    const clean = {}
    for (const [key, value] of Object.entries(body.profile)) clean[key] = String(value ?? '').slice(0, 4000)
    profileJson = JSON.stringify(clean)
    const composed = composeBusinessContext(clean)
    if (composed) context = composed
  }

  // Sending rhythm. The timezone is captured from the browser rather than asked
  // for — nobody should have to pick their own timezone from a list of 400.
  const s = body.sending || {}
  const time = (value, fallback) => (/^\d{1,2}:\d{2}$/.test(String(value || '')) ? String(value) : fallback)
  const from = time(s.from, owner.send_from || '08:30')
  const to = time(s.to, owner.send_to || '17:30')
  const minutes = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1])
  if (minutes(to) <= minutes(from)) {
    return res.status(400).json({ error: 'Sending hours must end after they start' })
  }

  db.prepare(
    `UPDATE users SET business_context = ?, meeting_link = ?, profile = ?, alert_webhook = ?,
                      require_approval = ?, consent_terms = ?,
                      paced = ?, send_from = ?, send_to = ?, send_days = ?, send_timezone = ? WHERE id = ?`
  ).run(
    context, link, profileJson, hook,
    body.requireApproval === undefined ? owner.require_approval : (body.requireApproval ? 1 : 0),
    body.consentTerms !== undefined ? String(body.consentTerms).slice(0, 8000) : owner.consent_terms,
    s.paced === undefined ? owner.paced : (s.paced ? 1 : 0),
    from, to,
    s.days === 'everyday' ? 'everyday' : s.days === 'weekdays' ? 'weekdays' : (owner.send_days || 'weekdays'),
    s.timezone !== undefined ? String(s.timezone).slice(0, 64) : owner.send_timezone,
    req.wsId
  )
  res.json({ ok: true })
})
