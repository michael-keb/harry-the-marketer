// Test harness for the parity modules.
//
// Each module exports `register(api)` and expects the same two things the real
// router guarantees: `req.user` and `req.wsId`. This mounts one module (or all
// of them) on a throwaway Express app with a stub session, so a test can drive
// real HTTP against real SQLite without Auth0, without Google, and without the
// engine ticking underneath it.
//
// Call `setup()` BEFORE importing anything from ../server, because server/db.js
// opens the database at import time and reads DATA_DIR from the environment.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'

// Point the app at a fresh database and switch the AI layer to its
// deterministic fallbacks. Must run before the first ../server import.
export function setup(label = 'parity') {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `htm-${label}-`))
  process.env.AI_MODE = 'off'
  process.env.NODE_ENV = 'test'
  return process.env.DATA_DIR
}

// Create a workspace owner and, optionally, a second workspace to prove that
// cross-workspace ids 404. Nearly every spec has a test case for that.
export function seedUser(db, email = 'owner@example.com') {
  db.prepare('INSERT INTO users (sub, email, name) VALUES (?, ?, ?)')
    .run(`dev:${email}`, email, email.split('@')[0])
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email)
}

// Mount `register` on a bare app acting as the given user. Returns a client
// whose methods resolve to { status, body } so assertions read cleanly.
export async function mount(register, user) {
  const app = express()
  const api = express.Router()
  api.use(express.json({ limit: '5mb' }))
  api.use((req, _res, next) => {
    req.user = user
    req.wsId = user.id
    req.wsRole = 'owner'
    req.wsOwnerEmail = user.email
    next()
  })

  // Accepts either one register function or an array of them.
  for (const fn of [].concat(register)) fn(api)
  app.use('/api', api)

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  // `npm test` runs fifteen files in parallel, each with its own listener on an
  // ephemeral port. Under that load a connection is occasionally refused or
  // reset before the server accepts it — a transport failure, not a response.
  // Retrying once turns that into the answer the test was asking for instead of
  // a mystery assertion failure an hour later.
  //
  // Only transport errors are retried. An HTTP status is an answer, however
  // unwelcome, and retrying one would hide real non-idempotency.
  const send = async (method, url, body) => {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(base + url, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await res.text()
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
        return { status: res.status, body: parsed }
      } catch (err) {
        lastError = err
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
      }
    }
    throw new Error(`${method} ${url} could not reach the test server: ${lastError?.message || lastError}`)
  }

  return {
    base,
    get: (url) => send('GET', url),
    post: (url, body = {}) => send('POST', url, body),
    put: (url, body = {}) => send('PUT', url, body),
    patch: (url, body = {}) => send('PATCH', url, body),
    del: (url, body) => send('DELETE', url, body),
    close: () => new Promise((r) => server.close(r)),
  }
}

// A second workspace's user, for the isolation test every category needs.
export function seedOtherWorkspace(db, email = 'stranger@example.com') {
  return seedUser(db, email)
}

// Minimal fixtures the modules lean on. Kept here so one change to the core
// schema does not mean editing fourteen test files.
export function seedLead(db, wsId, email = 'lead@acme.test', extra = {}) {
  db.prepare('INSERT INTO leads (user_id, email, first_name, last_name, company, title) VALUES (?, ?, ?, ?, ?, ?)')
    .run(wsId, email, extra.first_name ?? 'Ada', extra.last_name ?? 'Lovelace',
      extra.company ?? 'Acme', extra.title ?? 'Head of Operations')
  return db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(wsId, email)
}

export function seedMailbox(db, wsId, email = 'sender@example.com') {
  db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', ?, 'Sender')")
    .run(wsId, email)
  return db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND email = ?').get(wsId, email)
}

export function seedCampaign(db, wsId, name = 'Q3 outbound', mailboxId = null) {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, 'draft', ?, '')")
    .run(wsId, name, mailboxId)
  return db.prepare('SELECT * FROM campaigns WHERE user_id = ? AND name = ?').get(wsId, name)
}

export function seedMessage(db, wsId, { campaignId = null, leadId = null, mailboxId = null, direction = 'in', ...rest } = {}) {
  const info = db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id, intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wsId, campaignId, leadId, mailboxId, direction,
    rest.subject ?? 'Re: hello', rest.body ?? 'Sounds good.',
    rest.from_email ?? 'lead@acme.test', rest.to_email ?? 'sender@example.com',
    rest.thread_id ?? 'thread-1', rest.intent ?? 'interested')
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
}

export function seedTag(db, wsId, name = 'VIP', appliesTo = 'lead') {
  db.prepare('INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, ?, ?, ?)')
    .run(wsId, appliesTo, name, '#8b5cf6')
  return db.prepare('SELECT * FROM tags WHERE workspace_id = ? AND applies_to = ? AND name = ?').get(wsId, appliesTo, name)
}
