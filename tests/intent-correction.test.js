// A human correction that the next tick undid.
//
// Setting a lead's intent by hand returned `{ routedTo: "B" }` and the lead's
// row showed the new intent. Neither was true for long. The route wrote
// `campaign_leads.intent` but never moved `node_id`, and it left the inbound
// message with `intent = ''` — which is exactly the query the tick uses to find
// replies nobody has read. Twenty seconds later the classifier ran again,
// reached its original conclusion, and wrote it back over the correction.
//
// The test that existed was called "survives as human-set" and never ticked, so
// it passed throughout. Every test here runs the engine after the correction,
// because the tick is where the bug lived.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-intent-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { simulateReply } = await import('../server/mailer.js')

// "not now" and "interested" lead to visibly different places, so which one the
// lead ends up following is a fact the test can read rather than infer.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> B[Send: propose a call]
  A -- reply: not now --> P[Send: check back later]
  A -- reply: unsubscribe --> U([Unsubscribed])
  A -- no reply 3d --> L([Lost])
  B -- reply --> W([Won])
  P -- no reply 3d --> L
`

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:i@x.com', 'i@x.com', 'Owner', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (1, 'sandbox', 'me@sandbox.local', 'Me')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Intents', 'running', 1, ?)").run(PLAYBOOK)

// ---- a real HTTP surface, because the bug was in the route ------------------

const express = (await import('express')).default
const { api } = await import('../server/routes.js')
const { registerParity } = await import('../server/parity/index.js')
const { authRouter } = await import('../server/auth.js')

registerParity(api)
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  next()
})
app.use(authRouter)
app.use('/api', api)
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const login = await fetch(`${base}/api/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: user.email }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
assert.ok(cookie, 'signed in')

test.after(() => new Promise((r) => server.close(r)))

const setIntent = (leadId, body) => fetch(`${base}/api/campaigns/1/leads/${leadId}/intent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

let n = 0
async function leadWhoReplied(text) {
  n += 1
  const email = `p${n}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)').run(email, `P${n}`)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, ?)').run(leadId)
  await tick() // sends the intro and parks them at A
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = 1 AND lead_id = ?').get(leadId)
  simulateReply({ user, campaignLead: cl, text })
  await tick() // classifies the reply and branches
  return leadId
}

const linkOf = (leadId) => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = 1 AND lead_id = ?').get(leadId)
const inboundIntent = (leadId) =>
  db.prepare("SELECT intent FROM messages WHERE lead_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(leadId)?.intent

// ---- the defect ------------------------------------------------------------

test('a corrected intent survives the next tick', async () => {
  // The whole bug in one test: correct the classifier, run the engine, and see
  // whether the correction is still there.
  const leadId = await leadWhoReplied('This sounds interesting — tell me more.')
  assert.equal(linkOf(leadId).intent, 'interested', 'the classifier read it as interested')

  const res = await setIntent(leadId, { intent: 'not now' })
  assert.equal(res.status, 200)

  await tick()
  await tick()

  const cl = linkOf(leadId)
  assert.equal(cl.intent, 'not now', 'the correction is still standing after two ticks')
  assert.equal(cl.intent_set_by, user.email, 'and it is still attributed to the person who made it')
})

test('correcting the intent moves the lead onto the matching branch', async () => {
  // `routedTo` used to be a claim about an edge nobody took.
  const leadId = await leadWhoReplied('Sounds interesting, tell me more.')
  assert.equal(linkOf(leadId).node_id, 'B', 'the classifier sent them down the call branch')

  const body = await (await setIntent(leadId, { intent: 'not now' })).json()
  assert.equal(body.routedTo, 'P')
  assert.equal(body.nodeId, 'P', 'and the lead is actually on P, not merely told about it')
  assert.equal(linkOf(leadId).node_id, 'P')

  await tick()
  assert.equal(linkOf(leadId).node_id, 'P', 'still there after a tick')
})

test('the reply is marked with the human intent, so nothing re-reads it', async () => {
  // This is the mechanism, tested directly: an inbound message with an empty
  // intent is what the tick treats as unread, and leaving it empty was the bug.
  const leadId = await leadWhoReplied('Interested, let us talk.')
  await setIntent(leadId, { intent: 'not now' })
  assert.equal(inboundIntent(leadId), 'not now', 'the message carries the corrected reading')
  await tick()
  assert.equal(inboundIntent(leadId), 'not now', 'and the tick left it alone')
})

test('a correction made before a new reply does not silence the new reply', async () => {
  // The guard is by time, not by presence. A lead corrected last week whose
  // reply arrives today still needs that reply read — otherwise one correction
  // would deafen the campaign to everything that lead said afterwards.
  const leadId = await leadWhoReplied('Interested — tell me more.')
  await setIntent(leadId, { intent: 'not now' })
  await tick()

  // Backdate the correction, then have them reply again.
  db.prepare("UPDATE campaign_leads SET intent_set_at = datetime('now', '-7 days') WHERE campaign_id = 1 AND lead_id = ?")
    .run(leadId)
  simulateReply({ user, campaignLead: linkOf(leadId), text: 'Actually please remove me from this list entirely.' })
  await tick()

  assert.equal(inboundIntent(leadId), 'unsubscribe', 'the new reply was read, not skipped')
  assert.notEqual(linkOf(leadId).intent, 'not now', 'and the stale correction did not survive it')
})

// ---- the rest of the acceptance criteria ------------------------------------

test('categorize and pause is one operation', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  const body = await (await setIntent(leadId, { intent: 'not now', pause: true })).json()
  assert.equal(body.paused, true)

  const cl = linkOf(leadId)
  assert.ok(cl.paused_at, 'the pause is recorded')
  assert.equal(cl.paused_by, user.email, 'and attributed to the categorization')

  const before = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n
  await tick()
  const after = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n
  assert.equal(after, before, 'and a paused lead is not emailed')
})

test('omitting pause leaves the lead moving', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  await setIntent(leadId, { intent: 'not now' })
  assert.equal(linkOf(leadId).paused_at || '', '', 'not paused by default')
})

test('an intent with no matching edge flags the lead rather than dropping it', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  // "question" is a core intent but node B has only a catch-all `reply` edge,
  // so route through a node that has neither.
  db.prepare("UPDATE campaign_leads SET node_id = 'P' WHERE campaign_id = 1 AND lead_id = ?").run(leadId)
  const body = await (await setIntent(leadId, { intent: 'question' })).json()

  assert.equal(body.needsAttention, true)
  assert.equal(linkOf(leadId).state, 'needs_attention', 'it is waiting for a person, not lost')
})

test('setting unsubscribe is honoured immediately, whatever the playbook says', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  const body = await (await setIntent(leadId, { intent: 'unsubscribe' })).json()
  assert.equal(body.unsubscribed, true)

  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(leadId).status, 'unsubscribed')
  const before = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n
  await tick()
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n,
    before,
    'and nothing further is sent'
  )
})

test('an unknown intent is refused with the accepted values named', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  const before = linkOf(leadId).intent
  const res = await setIntent(leadId, { intent: 'enthusiastic-maybe' })

  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.field, 'intent')
  assert.match(body.message, /not now/, 'the message lists what it will accept')
  assert.equal(linkOf(leadId).intent, before, 'and nothing changed')
})

test('the activity trail records the old intent, the new one, and who set it', async () => {
  const leadId = await leadWhoReplied('Interested, tell me more.')
  await setIntent(leadId, { intent: 'not now' })
  await setIntent(leadId, { intent: 'interested' })

  const trail = db.prepare("SELECT detail FROM events WHERE lead_id = ? AND type = 'lead_intent' ORDER BY id").all(leadId)
  assert.equal(trail.length, 2, 'both changes are there')
  assert.match(trail[0].detail, /interested -> not now \(i@x\.com\)/)
  assert.match(trail[1].detail, /not now -> interested \(i@x\.com\)/)
})
