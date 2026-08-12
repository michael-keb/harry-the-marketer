// Infrastructure/security hardening from the 2026-08-12 audit.
//
// Two of the four fixes carry a behavioural test here; the other two (scoping
// the tracking limiter to /t, and the unhandledRejection/uncaughtException
// handlers) are covered as far as a unit test usefully can be.
//
//   1. The tracking rate limiter was mounted with no path, so EVERY request —
//      API, SPA shell, static asset — counted into the 300/min 'track' bucket.
//      An office behind one NAT tripped a limit meant only for the open pixel
//      and click/unsubscribe endpoints. It is now scoped to the /t prefix.
//
//   2. The /api limiter keyed on the RAW htm_session cookie, before any
//      verification. A forged random cookie per request got its own 600/min
//      bucket, defeating the ceiling and growing the bucket Map without bound.
//      It now keys on the VERIFIED session identity and falls back to the
//      caller's address for anonymous traffic.
//
//   4. POST /api/auth/dev-login signs anyone in as any email. In production it
//      was only a soft warning unless PRODUCTION_STRICT=1. It now refuses
//      outright (404, as if the route did not exist) whenever
//      NODE_ENV=production, regardless of PRODUCTION_STRICT or DEV_LOGIN.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-audit-sec-'))
process.env.NODE_ENV = 'test'
process.env.DEV_LOGIN = '1'
process.env.AI_MODE = 'off'

const express = (await import('express')).default
const { env } = await import('../server/env.js')
const { rateLimit, resetRateLimits } = await import('../server/security.js')
const { authRouter, sessionUid } = await import('../server/auth.js')
const { db } = await import('../server/db.js')

function cookieParser(req, _res, next) {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  next()
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const servers = []
test.after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))))

// ---- Fix 1: the tracking limiter is scoped to /t, not app-wide --------------

test('the tracking rate limiter counts only its own prefix, never every request', async () => {
  resetRateLimits()
  // Mount exactly as index.js does: the limiter on /t, the handler at root.
  const app = express()
  app.use('/t', rateLimit({ windowMs: 60_000, max: 2, key: 'track-scope-test' }))
  app.get(/.*/, (_req, res) => res.json({ ok: true }))
  const server = await listen(app)
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`

  // A non-tracking path (an SPA route, a static asset, an API call) never
  // touches the track bucket — ten in a row, all fine.
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${base}/app/campaigns`)
    assert.equal(res.status, 200, 'a non-/t request must not consume the track bucket')
  }

  // The tracking prefix itself is still capped: max=2, so the third 429s.
  assert.equal((await fetch(`${base}/t/o/abc.gif`)).status, 200)
  assert.equal((await fetch(`${base}/t/o/def.gif`)).status, 200)
  assert.equal((await fetch(`${base}/t/o/ghi.gif`)).status, 429, 'the /t prefix is still rate limited')
})

// ---- Fix 2: /api limiter keys on the verified session, not the raw cookie ---

// One app, wired like the real /api mount, for both Fix-2 tests.
const apiApp = express()
apiApp.use(cookieParser)
apiApp.use('/api', rateLimit({ windowMs: 60_000, max: 5, key: 'api-keying-test', by: (req) => sessionUid(req) }))
apiApp.get('/api/ping', (_req, res) => res.json({ ok: true }))
const apiServer = await listen(apiApp)
servers.push(apiServer)
const apiBase = `http://127.0.0.1:${apiServer.address().port}`

// A genuine, HMAC-signed session cookie, minted through the real dev-login route.
const authApp = express()
authApp.use(cookieParser)
authApp.use(authRouter)
const authServer = await listen(authApp)
servers.push(authServer)
const authBase = `http://127.0.0.1:${authServer.address().port}`
const login = await fetch(`${authBase}/api/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'sec@audit.test' }),
})
const validCookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
assert.ok(validCookie, 'minted a real session cookie for the positive case')

test('a forged / rotating htm_session cookie does not mint a fresh bucket per request', async () => {
  resetRateLimits()
  // Every request carries a DIFFERENT forged cookie value from the same address.
  // Under the old code (key = raw cookie) each got its own 600/min bucket and
  // nothing ever 429'd. Now they all fail verification and fall through to the
  // single address bucket, so with max=5 the sixth request is refused.
  const statuses = []
  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${apiBase}/api/ping`, {
      headers: { cookie: `htm_session=forged-${i}-${Math.random().toString(36).slice(2)}` },
    })
    statuses.push(res.status)
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], 'the first five share one bucket')
  assert.equal(statuses[5], 429, 'the sixth forged request is throttled — one shared bucket, not seven')
  assert.equal(statuses[6], 429, 'and so is the seventh')
})

test('a verified session is keyed on its identity, unaffected by forged traffic on its IP', async () => {
  resetRateLimits()
  // Exhaust the shared anonymous/address bucket with forged cookies.
  for (let i = 0; i < 6; i++) {
    await fetch(`${apiBase}/api/ping`, { headers: { cookie: `htm_session=forged-${i}` } })
  }
  const anon = await fetch(`${apiBase}/api/ping`, { headers: { cookie: 'htm_session=forged-again' } })
  assert.equal(anon.status, 429, 'anonymous/forged traffic is capped on the shared address bucket')

  // The real user, from the same loopback address, has their own bucket.
  const real = await fetch(`${apiBase}/api/ping`, { headers: { cookie: validCookie } })
  assert.equal(real.status, 200, 'a verified session is not throttled by forged traffic sharing its IP')
})

// ---- Fix 4: dev-login refuses outright in production ------------------------

test('dev-login is refused as a 404 in production, regardless of DEV_LOGIN / PRODUCTION_STRICT', async () => {
  const savedNodeEnv = env.NODE_ENV
  const savedStrict = env.PRODUCTION_STRICT
  env.NODE_ENV = 'production' // isProduction() reads env.NODE_ENV live
  env.PRODUCTION_STRICT = false // NOT strict — the old soft-warning path
  try {
    const res = await fetch(`${authBase}/api/auth/dev-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@evil.test' }),
    })
    assert.equal(res.status, 404, 'the route behaves as if it does not exist in production')
    const setCookie = res.headers.getSetCookie?.() || []
    assert.ok(!setCookie.some((c) => c.startsWith('htm_session')), 'no session cookie is issued')
    const created = db.prepare('SELECT id FROM users WHERE email = ?').get('attacker@evil.test')
    assert.equal(created, undefined, 'and no account was created for the attacker email')
  } finally {
    env.NODE_ENV = savedNodeEnv
    env.PRODUCTION_STRICT = savedStrict
  }
})

test('dev-login still works outside production', async () => {
  // The guard must not break the legitimate non-production use.
  const res = await fetch(`${authBase}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ok@audit.test' }),
  })
  assert.equal(res.status, 200, 'dev-login signs in normally when NODE_ENV is not production')
  const setCookie = res.headers.getSetCookie?.() || []
  assert.ok(setCookie.some((c) => c.startsWith('htm_session')), 'and a session is issued')
})
