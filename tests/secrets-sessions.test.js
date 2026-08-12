// Secrets at rest + session revocation — remaining SECURITY items from AUDIT-2026-08-12.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-secrets-'))
process.env.NODE_ENV = 'test'
process.env.DEV_LOGIN = '1'
process.env.AI_MODE = 'off'
process.env.TOKENS_ENCRYPTION_KEY = 'test-tokens-key-for-unit-suite-only'

const express = (await import('express')).default
const { sealSecret, openSecret, isSealed, withOpenTokens } = await import('../server/secrets.js')
const { authRouter, setSession, currentUser } = await import('../server/auth.js')
const { db } = await import('../server/db.js')

function cookieParser(req, _res, next) {
  const header = req.headers.cookie || ''
  req.cookies = Object.fromEntries(
    header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=')
      return i === -1 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]
    }),
  )
  next()
}

test('sealSecret round-trips and plaintext legacy rows still open', () => {
  const sealed = sealSecret('refresh-token-abc')
  assert.equal(isSealed(sealed), true)
  assert.notEqual(sealed, 'refresh-token-abc')
  assert.equal(openSecret(sealed), 'refresh-token-abc')
  // Legacy plaintext is returned unchanged (lazy migration).
  assert.equal(openSecret('already-plain'), 'already-plain')
  assert.equal(openSecret(''), '')
})

test('withOpenTokens opens sealed mailbox columns', () => {
  const row = withOpenTokens({
    id: 1,
    access_token: sealSecret('access'),
    refresh_token: sealSecret('refresh'),
  })
  assert.equal(row.access_token, 'access')
  assert.equal(row.refresh_token, 'refresh')
})

test('logout bumps session_epoch and invalidates the stolen cookie', async () => {
  const info = db.prepare(
    "INSERT INTO users (sub, email, name) VALUES ('dev:revoked@test.local', 'revoked@test.local', 'Revoked')"
  ).run()
  const uid = Number(info.lastInsertRowid)

  const app = express()
  app.use(cookieParser)
  app.use(authRouter)
  app.get('/whoami', (req, res) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'not_authenticated' })
    res.json({ id: user.id, epoch: user.session_epoch })
  })

  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()

  // Mint a session the same way login does.
  let cookie = ''
  {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'revoked@test.local' }),
    })
    assert.equal(res.status, 200)
    cookie = String(res.headers.getSetCookie?.()?.[0] || res.headers.get('set-cookie') || '')
      .split(';')[0]
    assert.match(cookie, /^htm_session=/)
  }

  const before = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { cookie } })
  assert.equal(before.status, 200)

  const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  })
  assert.equal(logout.status, 200)

  // Same cookie value still HMAC-verifies, but the epoch no longer matches.
  const after = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { cookie } })
  assert.equal(after.status, 401)

  const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(uid)
  assert.ok(Number(row.session_epoch) >= 1)

  // Silence unused setSession import warning path — used by login.
  void setSession
  await new Promise((r) => server.close(r))
})
