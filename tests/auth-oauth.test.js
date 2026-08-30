// Auth0 start + callback. Sign-up was bouncing because (1) "Sign up with Google"
// never sent connection=google-oauth2, and (2) CSRF state lived in memory and
// died on a Render restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-auth-oauth-'))
process.env.NODE_ENV = 'test'
process.env.DEV_LOGIN = '0'
process.env.AI_MODE = 'off'

const { env } = await import('../server/env.js')
env.AUTH0_DOMAIN = 'example.auth0.com'
env.AUTH0_CLIENT_ID = 'test-client'
env.AUTH0_CLIENT_SECRET = 'test-secret'
env.AUTH0_AUDIENCE = 'https://harrythemarketer.com/api'
env.APP_URL = 'https://harrythemarketer.com'

const { authRouter } = await import('../server/auth.js')
const { db } = await import('../server/db.js')

function listen() {
  const app = express()
  app.use(authRouter)
  const server = http.createServer(app)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

test('login redirects to Google via Auth0, not the hosted email form', async () => {
  const { url, close } = await listen()
  try {
    const res = await fetch(`${url}/api/auth/login?screen_hint=signup&next=/app`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    const loc = new URL(res.headers.get('location'))
    assert.equal(loc.hostname, 'example.auth0.com')
    assert.equal(loc.pathname, '/authorize')
    assert.equal(loc.searchParams.get('connection'), 'google-oauth2')
    assert.equal(loc.searchParams.get('screen_hint'), 'signup')
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://harrythemarketer.com/api/auth/callback')
    const state = loc.searchParams.get('state')
    assert.ok(state)
    const row = db.prepare('SELECT next, intent, plan, expiry FROM oauth_states WHERE state = ?').get(state)
    assert.ok(row)
    assert.equal(row.next, '/app')
    assert.equal(row.intent, 'signup')
    assert.ok(row.expiry > Date.now())
  } finally {
    await close()
  }
})

test('signup start stores intent and plan so errors can return to signup', async () => {
  const { url, close } = await listen()
  try {
    const res = await fetch(`${url}/api/auth/login?screen_hint=signup&plan=starter&next=/app`, { redirect: 'manual' })
    const state = new URL(res.headers.get('location')).searchParams.get('state')
    const row = db.prepare('SELECT intent, plan FROM oauth_states WHERE state = ?').get(state)
    assert.equal(row.intent, 'signup')
    assert.equal(row.plan, 'starter')
  } finally {
    await close()
  }
})

test('callback without a stored state asks the visitor to try again', async () => {
  const { url, close } = await listen()
  try {
    const res = await fetch(`${url}/api/auth/callback?code=x&state=missing`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    const loc = new URL(res.headers.get('location'), url)
    assert.equal(loc.pathname, '/login')
    assert.equal(loc.searchParams.get('error'), 'timeout')
  } finally {
    await close()
  }
})

test('a cancelled Google signup returns to signup, not Welcome back', async () => {
  const { url, close } = await listen()
  try {
    const start = await fetch(`${url}/api/auth/login?screen_hint=signup&plan=growth`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    const res = await fetch(
      `${url}/api/auth/callback?error=access_denied&error_description=${encodeURIComponent('Auth0 token exchange failed')}&state=${state}`,
      { redirect: 'manual' },
    )
    assert.equal(res.status, 302)
    const loc = new URL(res.headers.get('location'), url)
    assert.equal(loc.pathname, '/signup')
    assert.equal(loc.searchParams.get('error'), 'cancelled')
    assert.equal(loc.searchParams.get('plan'), 'growth')
    assert.doesNotMatch(loc.search, /Auth0|token exchange|server logs/i)
  } finally {
    await close()
  }
})

test('a failed token exchange after signup start stays on signup', async () => {
  const { url, close } = await listen()
  try {
    const start = await fetch(`${url}/api/auth/login?screen_hint=signup`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    const res = await fetch(`${url}/api/auth/callback?code=not-a-real-code&state=${state}`, { redirect: 'manual' })
    const loc = new URL(res.headers.get('location'), url)
    assert.equal(loc.pathname, '/signup')
    assert.equal(loc.searchParams.get('error'), 'oauth_failed')
  } finally {
    await close()
  }
})

test('callback consumes state so a restart cannot replay it', async () => {
  const { url, close } = await listen()
  try {
    const start = await fetch(`${url}/api/auth/login`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    assert.ok(db.prepare('SELECT state FROM oauth_states WHERE state = ?').get(state))

    const first = await fetch(`${url}/api/auth/callback?code=not-a-real-code&state=${state}`, { redirect: 'manual' })
    assert.equal(first.status, 302)
    assert.equal(db.prepare('SELECT state FROM oauth_states WHERE state = ?').get(state), undefined)

    const replay = await fetch(`${url}/api/auth/callback?code=not-a-real-code&state=${state}`, { redirect: 'manual' })
    const loc = new URL(replay.headers.get('location'), url)
    assert.equal(loc.searchParams.get('error'), 'timeout')
  } finally {
    await close()
  }
})
