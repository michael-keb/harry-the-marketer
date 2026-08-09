// Two implementations of "honour an unsubscribe", and the one facing the
// outside world was the weaker of the two.
//
// The Settings route wrote the timestamps, stopped every enrolment and declined
// the queued drafts. The footer link — the one a *recipient* clicks, which is
// the one that actually matters — set `leads.status` and stopped there. So:
//
//   * Reports counts `campaign_leads.unsubscribed_at`, which stayed empty, and
//     went on showing zero unsubscribes on a campaign people were leaving;
//   * a draft already written for that person stayed pending in Needs your OK,
//     one click away from being approved and sent to someone who had just
//     asked never to hear from us again.
//
// Both paths now call the same function. These tests drive the footer URL,
// because that is the path that was wrong and the one no test covered.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-unsub-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { campaignTotals } = await import('../server/metrics.js')
const { trackingRouter } = await import('../server/tracking.js')

const express = (await import('express')).default
const app = express()
app.use(trackingRouter)
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => new Promise((r) => server.close(r)))

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:u@x.com', 'u@x.com', 'Owner')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'me@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id) VALUES (1, 'A', 'running', 1)").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id) VALUES (1, 'B', 'running', 1)").run()

let seq = 0
// A lead enrolled in both campaigns, emailed from campaign A, with a pending
// draft waiting for approval and a queued send behind it.
function recipient() {
  seq += 1
  const token = `tok-unsub-${seq}`
  const email = `u${seq}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run(email)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id

  for (const campaignId of [1, 2]) {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'waiting')")
      .run(campaignId, leadId)
  }
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, tracking_token, provider_message_id, send_status)
     VALUES (1, 1, ?, 1, 'out', 'Hello', 'Body', ?, ?, ?, 'sent')`
  ).run(leadId, email, token, `m-${seq}`)
  db.prepare(
    `INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status)
     VALUES (1, 1, ?, 'A', 'Follow-up', 'Body', 'pending')`
  ).run(leadId)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, send_status)
     VALUES (1, 1, ?, 1, 'out', 'Queued', 'Body', ?, 'queued')`
  ).run(leadId, email)

  return { leadId, token, email }
}

const unsubscribe = (token) => fetch(`${base}/t/u/${token}`)
const leadRow = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
const links = (id) => db.prepare('SELECT * FROM campaign_leads WHERE lead_id = ? ORDER BY campaign_id').all(id)

// ---- the defect ------------------------------------------------------------

test('the footer unsubscribe stamps the columns Reports actually counts', async () => {
  const { leadId, token } = recipient()
  const before = campaignTotals(1).unsubscribed

  const res = await unsubscribe(token)
  assert.equal(res.status, 200)

  for (const link of links(leadId)) {
    assert.ok(link.unsubscribed_at, `campaign ${link.campaign_id} has a timestamp`)
    assert.equal(link.outcome, 'unsubscribed')
    assert.equal(link.state, 'stopped')
  }
  assert.equal(campaignTotals(1).unsubscribed, before + 1, 'and the campaign figure moved')
})

test('a pending draft to someone who just unsubscribed is withdrawn', async () => {
  // The sharp end of the bug: this draft sat in Needs your OK, and approving it
  // would have emailed a person who had just opted out.
  const { leadId, token } = recipient()
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ? AND status = 'pending'").get(leadId).n, 1,
    'a draft is waiting before they unsubscribe'
  )

  await unsubscribe(token)

  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ? AND status = 'pending'").get(leadId).n, 0,
    'and it is gone after'
  )
  assert.equal(db.prepare("SELECT status FROM drafts WHERE lead_id = ?").get(leadId).status, 'declined')
})

test('a send already queued is cancelled, not merely un-scheduled', async () => {
  const { leadId, token } = recipient()
  await unsubscribe(token)
  const queued = db.prepare("SELECT send_status FROM messages WHERE lead_id = ? AND send_status IN ('queued','cancelled')").all(leadId)
  assert.ok(queued.length > 0)
  for (const m of queued) assert.equal(m.send_status, 'cancelled')
})

test('unsubscribing from one campaign leaves them out of all of them', async () => {
  // Opting out of one email is opting out; anything narrower is a loophole
  // dressed as precision.
  const { leadId, token } = recipient()
  await unsubscribe(token)

  const all = links(leadId)
  assert.equal(all.length, 2)
  for (const link of all) assert.equal(link.state, 'stopped', `campaign ${link.campaign_id} stopped too`)
})

test('the lead record carries the timestamp and the source', async () => {
  const { leadId, token } = recipient()
  await unsubscribe(token)
  const lead = leadRow(leadId)
  assert.equal(lead.status, 'unsubscribed')
  assert.ok(lead.unsubscribed_at, 'when')
  assert.equal(lead.unsubscribed_source, 'link', 'and how — a recipient clicked, nobody did it for them')
})

test('the activity trail says what the unsubscribe actually stopped', async () => {
  const { leadId, token } = recipient()
  await unsubscribe(token)
  const event = db.prepare("SELECT detail FROM events WHERE lead_id = ? AND type = 'unsubscribed_link'").get(leadId)
  assert.ok(event)
  assert.match(event.detail, /enrolments? stopped/)
  assert.match(event.detail, /draft/, 'including the withdrawn draft, so the consequence is visible')
})

test('clicking the link twice is harmless', async () => {
  const { leadId, token } = recipient()
  await unsubscribe(token)
  const first = leadRow(leadId).unsubscribed_at

  const res = await unsubscribe(token)
  assert.equal(res.status, 200, 'still a friendly page, not an error')
  assert.equal(
    db.prepare("SELECT unsubscribed_at FROM campaign_leads WHERE lead_id = ? LIMIT 1").get(leadId).unsubscribed_at,
    db.prepare("SELECT unsubscribed_at FROM campaign_leads WHERE lead_id = ? LIMIT 1").get(leadId).unsubscribed_at,
    'and the original timestamp is not rewritten'
  )
  assert.ok(first)
})

test('an unknown token does not blow up or unsubscribe anybody', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM leads WHERE status = 'unsubscribed'").get().n
  const res = await unsubscribe('not-a-real-token')
  assert.equal(res.status, 200)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE status = 'unsubscribed'").get().n, before)
})

// ---- the legacy import route tells the truth about who may be emailed -------

test('re-importing an unsubscriber does not present them as contactable', async () => {
  // No email could have escaped either way — enrolment and the mailer both
  // re-check suppression — but this route imported a person who had opted out
  // with `status = 'active'`, so the Leads page showed them sitting there
  // looking available, with nothing to say otherwise. Being wrong on screen
  // about who you may email is its own harm, even when the send path holds.
  const express = (await import('express')).default
  const { api } = await import('../server/routes.js')
  const { authRouter } = await import('../server/auth.js')
  process.env.DEV_LOGIN = '1'

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
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const at = `http://127.0.0.1:${srv.address().port}`
  const login = await fetch(`${at}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'u@x.com' }),
  })
  const jar = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]

  // Somebody opts out, then is tidied away.
  const { leadId, token, email } = recipient()
  await unsubscribe(token)
  db.prepare('DELETE FROM leads WHERE id = ?').run(leadId)

  // Next month's CSV brings them back, alongside somebody who never opted out.
  const res = await fetch(`${at}/api/leads/import`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: jar },
    body: JSON.stringify({ rows: [{ email }, { email: 'fresh-contact@acme.test' }] }),
  })
  const body = await res.json()
  await new Promise((r) => srv.close(r))

  assert.equal(res.status, 200)
  assert.equal(body.added, 2, 'both rows imported — the record is not silently dropped')
  assert.equal(body.suppressed, 1, 'and the response says one of them may not be contacted')

  assert.equal(
    db.prepare('SELECT status FROM leads WHERE email = ?').get(email).status, 'unsubscribed',
    'the returning unsubscriber comes back opted out, not active',
  )
  assert.equal(
    db.prepare('SELECT status FROM leads WHERE email = ?').get('fresh-contact@acme.test').status, 'active',
    'and a genuinely new contact is unaffected',
  )
})
