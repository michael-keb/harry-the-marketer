// The attach-time feedback loop for the person cooling-off (gates.js
// `firstTouchDeferral`). Adding a recently-contacted lead to a campaign used to
// look like it worked while the first email silently held for a fortnight, the
// reason visible only as one send_gated row in the activity trail. Both attach
// routes and the campaign leads listing must now say so up front.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-cooloff-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:co@x.com', 'co@x.com', 'Owner', 0, 1, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()

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
  body: JSON.stringify({ email: owner.email }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
assert.ok(cookie, 'signed in')
test.after(() => new Promise((r) => server.close(r)))

const get = (p) => fetch(`${base}${p}`, { headers: { cookie } })
const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
})
const json = async (res) => res.json()

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> W([Won])
  A -- no reply 3d --> L([Lost])
`

db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'gmail', 'real@x.com', 'Real', 'connected', 50)").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'sandbox', 'sbx@sandbox.local', 'Sbx', 'connected', 50)").run()
const realBox = db.prepare("SELECT id FROM mailboxes WHERE provider = 'gmail'").get().id
const sbxBox = db.prepare("SELECT id FROM mailboxes WHERE provider = 'sandbox'").get().id

function seedCampaign(name, mailboxId) {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, ?, 'draft', ?, ?)")
    .run(name, mailboxId, PLAYBOOK)
  return db.prepare('SELECT * FROM campaigns WHERE name = ?').get(name)
}
function seedLead(email) {
  db.prepare("INSERT INTO leads (user_id, email, first_name, company, status) VALUES (1, ?, 'T', 'Co', 'active')").run(email)
  return db.prepare('SELECT * FROM leads WHERE email = ?').get(email)
}
const DAY = 86400e3
function touch(leadId, daysAgo) {
  db.prepare(
    "INSERT INTO touches (workspace_id, lead_id, company_domain, channel, campaign_id, sent_at) VALUES (1, ?, 'elsewhere.test', 'email', 999, ?)"
  ).run(leadId, Date.now() - daysAgo * DAY)
}

test('import names recently-touched leads and when their first email may go', async () => {
  const c = seedCampaign('Warns on import', realBox)
  const warm = seedLead('warm@one.test'); touch(warm.id, 3)
  const cold = seedLead('cold@two.test')
  const res = await json(await post(`/api/campaigns/${c.id}/leads/import`, {
    leads: [{ email: warm.email }, { email: cold.email }],
  }))
  assert.equal(res.addedCount, 2)
  assert.equal(res.coolingOffCount, 1)
  assert.equal(res.coolingOff[0].email, warm.email)
  assert.match(res.coolingOff[0].reason, /contacted 3 days ago/)
  const until = Date.parse(res.coolingOff[0].until)
  const expected = Date.now() + 11 * DAY
  assert.ok(Math.abs(until - expected) < DAY, `until ≈ 11 days out (got ${res.coolingOff[0].until})`)
  assert.ok(res.personDays >= 1, 'the rule window travels with the warning')
})

test('the campaign leads listing shows cooling-off on the row', async () => {
  const c = db.prepare("SELECT * FROM campaigns WHERE name = 'Warns on import'").get()
  const res = await json(await get(`/api/campaigns/${c.id}/leads`))
  const warm = res.leads.find((l) => l.email === 'warm@one.test')
  const cold = res.leads.find((l) => l.email === 'cold@two.test')
  assert.ok(warm.coolingOffUntil, 'touched lead carries the date')
  assert.match(warm.coolingOffReason, /waits until/)
  assert.equal(cold.coolingOffUntil, undefined, 'untouched lead carries nothing')
})

test('a lead this campaign has already emailed is a follow-up, not a fresh approach', async () => {
  const c = db.prepare("SELECT * FROM campaigns WHERE name = 'Warns on import'").get()
  const warm = db.prepare("SELECT * FROM leads WHERE email = 'warm@one.test'").get()
  db.prepare(
    "INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body) VALUES (1, ?, ?, ?, 'out', 's', 'b')"
  ).run(c.id, warm.id, realBox)
  const res = await json(await get(`/api/campaigns/${c.id}/leads`))
  const row = res.leads.find((l) => l.email === 'warm@one.test')
  assert.equal(row.coolingOffUntil, undefined, 'follow-ups are exempt from the cap and from the warning')
})

test('sandbox campaigns never warn — there is no recipient to protect', async () => {
  const c = seedCampaign('Sandbox silent', sbxBox)
  const warm = seedLead('warm@three.test'); touch(warm.id, 1)
  const res = await json(await post(`/api/campaigns/${c.id}/leads/import`, { leads: [{ email: warm.email }] }))
  assert.equal(res.coolingOffCount, 0)
})

test('the legacy attach route gives the same warning', async () => {
  const c = seedCampaign('Legacy warns', realBox)
  const warm = seedLead('warm@four.test'); touch(warm.id, 5)
  const res = await json(await post(`/api/campaigns/${c.id}/leads`, { leadIds: [warm.id] }))
  assert.equal(res.added, 1)
  assert.equal(res.coolingOff.length, 1)
  assert.equal(res.coolingOff[0].email, warm.email)
  assert.match(res.coolingOff[0].reason, /contacted 5 days ago/)
})
