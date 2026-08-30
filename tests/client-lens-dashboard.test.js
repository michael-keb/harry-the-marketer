// Client Lens scope honesty (ux-audit-self-healing.md, P0 item 1).
//
// The sidebar told an agency "you are looking at this client" while the
// Dashboard KPIs, the Needs You sources and the parked-lead queue stayed
// workspace-wide. These tests hold the four routes the lens now narrows —
// /api/dashboard, /api/drafts, /api/tasks, /api/reminders — to the same rule
// tests/client-lens.test.js holds the lists to: a clientId must narrow, and
// counts must narrow with the rows they sit beside.
//
// This drives the real router behind the real auth middleware, the same way
// cross-cutting-audit.test.js does, because /api/dashboard lives on the main
// router rather than in a parity module.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setup, seedUser, seedCampaign, seedLead, seedMailbox } from './helpers/parity-harness.js'

setup('lens-dashboard')            // MUST precede any ../server import
process.env.DEV_LOGIN = '1'        // the router's real sign-in, not a fake session

const { db } = await import('../server/db.js')
const { api } = await import('../server/routes.js')
const { authRouter } = await import('../server/auth.js')

const app = express()
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) {
    for (const pair of header.split(';')) {
      const i = pair.indexOf('=')
      if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
    }
  }
  next()
})
app.use(authRouter)
app.use('/api', api)

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => new Promise((r) => server.close(r)))

const owner = seedUser(db, 'owner@lens-dash.test')

const login = await fetch(`${base}/api/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: owner.email }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
assert.ok(cookie, 'dev login issued a session')

async function get(path) {
  const res = await fetch(base + path, { headers: { cookie } })
  return { status: res.status, body: await res.json() }
}

// ---- fixtures: one client's world and the agency's own ----------------------

const run = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid)

const clientId = run(
  "INSERT INTO clients (workspace_id, name, email) VALUES (?, 'Northwind', 'northwind@example.test')",
  owner.id,
)

const nwCampaign = seedCampaign(db, owner.id, 'NW spring')
const houseCampaign = seedCampaign(db, owner.id, 'Our own marketing')
db.prepare("UPDATE campaigns SET client_id = ?, status = 'running' WHERE id = ?").run(clientId, nwCampaign.id)
db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(houseCampaign.id)

const nwLead = seedLead(db, owner.id, 'nw-lead@example.test')
const houseLead = seedLead(db, owner.id, 'house-lead@example.test')
db.prepare('UPDATE leads SET client_id = ? WHERE id = ?').run(clientId, nwLead.id)

const nwBox = seedMailbox(db, owner.id, 'nw-box@example.test')
seedMailbox(db, owner.id, 'house-box@example.test')
db.prepare('UPDATE mailboxes SET client_id = ? WHERE id = ?').run(clientId, nwBox.id)

// One outbound and one inbound message per campaign.
for (const [campaign, lead] of [[nwCampaign, nwLead], [houseCampaign, houseLead]]) {
  for (const direction of ['out', 'in']) {
    run(
      `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body)
       VALUES (?, ?, ?, ?, 'subject', 'body')`,
      owner.id, campaign.id, lead.id, direction,
    )
  }
}

// One parked lead per campaign.
for (const [campaign, lead] of [[nwCampaign, nwLead], [houseCampaign, houseLead]]) {
  run(
    "INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'needs_attention')",
    campaign.id, lead.id,
  )
}

// One pending approval draft per campaign.
for (const [campaign, lead] of [[nwCampaign, nwLead], [houseCampaign, houseLead]]) {
  run(
    "INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body) VALUES (?, ?, ?, 'A', 's', 'b')",
    owner.id, campaign.id, lead.id,
  )
}

// One open task and one overdue reminder per lead.
for (const lead of [nwLead, houseLead]) {
  run(
    "INSERT INTO lead_tasks (workspace_id, lead_id, title, status) VALUES (?, ?, 'call them', 'open')",
    owner.id, lead.id,
  )
  run(
    "INSERT INTO lead_reminders (workspace_id, lead_id, reminder_at, note) VALUES (?, ?, '2020-01-01T00:00:00.000Z', 'nudge')",
    owner.id, lead.id,
  )
}

// ---- dashboard --------------------------------------------------------------

test('without a lens the dashboard counts the whole workspace and says so', async () => {
  const res = await get('/api/dashboard')
  assert.equal(res.status, 200)
  assert.equal(res.body.stats.leads, 2)
  assert.equal(res.body.stats.activeCampaigns, 2)
  assert.equal(res.body.stats.sent, 2)
  assert.equal(res.body.stats.replies, 2)
  assert.equal(res.body.stats.needsAttention, 2)
  assert.equal(res.body.stats.awaitingApproval, 2)
  assert.equal(res.body.attention.length, 2)
  assert.equal(res.body.scope, null)
})

test('a clientId narrows every KPI, the chart and the parked-lead queue', async () => {
  const res = await get(`/api/dashboard?clientId=${clientId}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.stats.leads, 1)
  assert.equal(res.body.stats.activeCampaigns, 1)
  assert.equal(res.body.stats.sent, 1)
  assert.equal(res.body.stats.replies, 1)
  assert.equal(res.body.stats.unread, 1)
  assert.equal(res.body.stats.needsAttention, 1)
  assert.equal(res.body.stats.awaitingApproval, 1)
  assert.equal(res.body.attention.length, 1)
  assert.equal(res.body.attention[0].campaign_name, 'NW spring')
  // The chart narrows with the tiles — the same lens, or the two disagree.
  const chartTotal = res.body.sentByDay.reduce((sum, d) => sum + d.sent + d.replies, 0)
  assert.equal(chartTotal, 2)
  // The payload names what the lens cannot cut, so the UI can say it too.
  assert.deepEqual(res.body.scope, { clientId, workspaceWide: ['activity', 'ai', 'engine'] })
})

// ---- the Needs You sources --------------------------------------------------

test('the approval queue narrows with the lens', async () => {
  const all = await get('/api/drafts')
  assert.equal(all.body.drafts.length, 2)
  const scoped = await get(`/api/drafts?clientId=${clientId}`)
  assert.equal(scoped.body.drafts.length, 1)
  assert.equal(scoped.body.drafts[0].campaign_name, 'NW spring')
})

test('tasks narrow with the lens, and so do their counts', async () => {
  const all = await get('/api/tasks?status=open&limit=50')
  assert.equal(all.body.items.length, 2)
  assert.equal(all.body.counts.open, 2)
  const scoped = await get(`/api/tasks?status=open&limit=50&clientId=${clientId}`)
  assert.equal(scoped.body.items.length, 1)
  // Counts must narrow with the rows they sit beside, or the fix would create
  // the same lie one level down.
  assert.equal(scoped.body.counts.open, 1)
})

test('reminders narrow with the lens', async () => {
  const all = await get('/api/reminders?status=pending&due=overdue&limit=50')
  assert.equal(all.body.items.length, 2)
  const scoped = await get(`/api/reminders?status=pending&due=overdue&limit=50&clientId=${clientId}`)
  assert.equal(scoped.body.items.length, 1)
})

test('another workspace\'s data never leaks through a foreign clientId', async () => {
  // The workspace scope is applied first, so a foreign client id narrows to
  // nothing rather than acting as a key into someone else's rows.
  const stranger = seedUser(db, 'stranger@lens-dash.test')
  const theirClient = run(
    "INSERT INTO clients (workspace_id, name, email) VALUES (?, 'Theirs', 'theirs@example.test')",
    stranger.id,
  )
  const res = await get(`/api/dashboard?clientId=${theirClient}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.stats.leads, 0)
  assert.equal(res.body.stats.awaitingApproval, 0)
  assert.equal(res.body.attention.length, 0)
})
