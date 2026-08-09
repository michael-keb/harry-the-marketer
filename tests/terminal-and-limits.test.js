// Three settings that were stored, echoed back, and never acted on.
//
// Each of these is a case where a person told Harry to stop and Harry carried on
// emailing anyway, so every test here ends the same way: drive `tick()` and
// count rows in `messages`. A response envelope proves nothing — all three
// defects returned a perfectly cheerful 200 while the email went out.
//
//   1. Completing a lead was not terminal. `completed_at` was set, the stage
//      read "completed", and any route that wrote `state` — the intent route
//      most obviously — put the pairing straight back into the engine's
//      selection, which then sent a second email to somebody marked done.
//      (Docs/campaigns/mark-lead-complete.md §5.)
//
//   2. `DELETE /api/campaigns/:id/leads/:leadId` removed the pairing and left
//      the pending draft standing in Needs your OK, one approval away from
//      emailing a lead who is no longer in the campaign — and answered
//      `200 {"removed": 0}` for a lead that was never in it.
//
//   3. A client's allowance was recorded, shown, and read by nothing on the
//      send path, so lowering it below usage changed a badge and nothing else.
//      (Docs/clients/update.md AC 4 / TC-10.)
//
// Fixtures: sandbox mailboxes throughout, which skip the clock and the spacing
// gap but not the ceilings or any refusal, and a 24-hour every-day window on the
// owner so no clock gate can fire ahead of the one being tested. Campaigns are
// created as drafts and started inside the test that needs them, because
// `tick()` processes every running campaign in the database.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-terminal-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'
process.env.DEV_LOGIN = '1'

const express = (await import('express')).default
const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { api } = await import('../server/routes.js')
const { registerParity } = await import('../server/parity/index.js')
const { authRouter } = await import('../server/auth.js')

// Two send steps, so "did a second email go out?" is a question the playbook can
// actually answer: a lead who has had the intro still has somewhere to go.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> B[Send: propose a call]
  A -- reply: not now --> P[Send: check back later]
  A -- no reply 3d --> L([Lost])
  B -- reply --> W([Won])
  P -- no reply 3d --> L
`

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:owner@terminal.test', 'owner@terminal.test', 'Owner', 0, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const owner = db.prepare("SELECT * FROM users WHERE email = 'owner@terminal.test'").get()

db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', 'send@sandbox.local', 'Sender')")
  .run(owner.id)
const mailbox = db.prepare("SELECT * FROM mailboxes WHERE email = 'send@sandbox.local'").get()

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

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}
const post = (url, body = {}) => call('POST', url, body)
const patch = (url, body = {}) => call('PATCH', url, body)
const del = (url) => call('DELETE', url)

// ---- fixtures ---------------------------------------------------------------

let seq = 0
function draftCampaign(name) {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, 'draft', ?, ?)")
    .run(owner.id, name, mailbox.id, PLAYBOOK)
  return db.prepare('SELECT * FROM campaigns WHERE user_id = ? AND name = ?').get(owner.id, name)
}
const start = (id) => db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id)
const park = (id) => db.prepare("UPDATE campaigns SET status = 'draft' WHERE id = ?").run(id)

// A distinct domain per lead, so no company-frequency rule can be the reason a
// send did not happen.
function newLead() {
  seq += 1
  const email = `person${seq}@acme${seq}.test`
  db.prepare('INSERT INTO leads (user_id, email, first_name, company) VALUES (?, ?, ?, ?)')
    .run(owner.id, email, `Person${seq}`, `Acme ${seq}`)
  return db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, email)
}
function enrol(campaignId, leadId) {
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, leadId)
  return db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)
}

// The only measure that counts: emails that actually left.
const sentTo = (leadId) =>
  db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n
const sentBy = (campaignId) =>
  db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'").get(campaignId).n
const linkOf = (campaignId, leadId) =>
  db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)

// ============================================================================
// 1. Completing a lead is terminal
// ============================================================================

test('setting an intent cannot talk a completed lead back into the campaign', async () => {
  // The defect, end to end. Complete the lead, categorise their reply, tick —
  // and a second email used to arrive at somebody a person had closed the loop
  // on, with `completed_at` still sitting on the row the whole time.
  const c = draftCampaign('Intent resurrection')
  const lead = newLead()
  enrol(c.id, lead.id)
  start(c.id)
  await tick()
  assert.equal(sentTo(lead.id), 1, 'the intro went out, so the claim below is not vacuous')

  const done = await post(`/api/campaigns/${c.id}/leads/${lead.id}/complete`)
  assert.equal(done.status, 200)
  const completedAt = linkOf(c.id, lead.id).completed_at
  assert.ok(completedAt, 'the completion is recorded')

  const refused = await post(`/api/campaigns/${c.id}/leads/${lead.id}/intent`, { intent: 'interested' })
  assert.equal(refused.status, 409, 'the route says no rather than quietly reopening the pairing')
  assert.equal(refused.body.error, 'lead_completed')

  await tick()
  await tick()

  assert.equal(sentTo(lead.id), 1, 'no second email reached a lead who was marked done')
  const after = linkOf(c.id, lead.id)
  assert.equal(after.state, 'finished', 'and the row was not left claiming a state the tick will never act on')
  assert.equal(after.completed_at, completedAt, 'the completion timestamp survived the attempt')
  park(c.id)
})

test('the engine refuses a completed pairing whatever its state column says', async () => {
  // The guard that carries the weight. `state` is written by a dozen routes —
  // resume, retry, reclassify, the handoff, the intent correction — and every
  // one of them could put a completed row back in front of the engine. This
  // writes the state by hand, which is precisely what "some other route did it"
  // looks like from the engine's side.
  const c = draftCampaign('Terminal at the top of the tick')
  const lead = newLead()
  enrol(c.id, lead.id)
  start(c.id)
  await tick()
  assert.equal(sentTo(lead.id), 1)

  await post(`/api/campaigns/${c.id}/leads/${lead.id}/complete`)
  db.prepare("UPDATE campaign_leads SET state = 'active', node_id = 'A' WHERE campaign_id = ? AND lead_id = ?")
    .run(c.id, lead.id)

  await tick()
  await tick()

  assert.equal(sentTo(lead.id), 1, 'a completed row is terminal before any composing or pacing work')
  assert.ok(linkOf(c.id, lead.id).completed_at, 'and it is still marked complete')
  park(c.id)
})

test('completing one campaign leaves the same lead sending in another', async () => {
  // mark-lead-complete.md AC 3. A terminal marker that leaked across campaigns
  // would be a worse bug than the one being fixed.
  const here = draftCampaign('Completed here')
  const there = draftCampaign('Still running there')
  const lead = newLead()
  enrol(here.id, lead.id)
  enrol(there.id, lead.id)
  start(here.id)
  start(there.id)
  await tick()
  assert.equal(sentBy(here.id), 1)
  assert.equal(sentBy(there.id), 1)

  await post(`/api/campaigns/${here.id}/leads/${lead.id}/complete`)
  // Move the second campaign's lead on so it has a fresh step to take.
  db.prepare("UPDATE campaign_leads SET state = 'active', node_id = 'A' WHERE campaign_id = ? AND lead_id = ?")
    .run(there.id, lead.id)
  await tick()

  assert.equal(sentBy(here.id), 1, 'the completed campaign sent nothing more')
  assert.equal(sentBy(there.id), 2, 'and the other campaign was untouched by it')
  park(here.id)
  park(there.id)
})

test('re-enrolling a completed lead on purpose still works', async () => {
  // The guard has to stop an accident, not a decision. Removing the pairing and
  // adding it again is the deliberate act, and it starts a genuinely new run —
  // otherwise "terminal" would mean "this person can never be emailed from this
  // campaign again", which is not what marking one deal closed should buy.
  const c = draftCampaign('Deliberate re-enrolment')
  const lead = newLead()
  enrol(c.id, lead.id)
  start(c.id)
  await tick()
  await post(`/api/campaigns/${c.id}/leads/${lead.id}/complete`)
  await tick()
  assert.equal(sentTo(lead.id), 1, 'completed, and holding')

  const removed = await del(`/api/campaigns/${c.id}/leads/${lead.id}`)
  assert.equal(removed.status, 200)
  const added = await post(`/api/campaigns/${c.id}/leads`, { leadIds: [lead.id] })
  assert.equal(added.status, 200)
  assert.equal(added.body.added, 1)
  assert.equal(linkOf(c.id, lead.id).completed_at || '', '', 'the new pairing carries no completion')

  await tick()
  assert.equal(sentTo(lead.id), 2, 'a deliberate re-enrolment sends again')
  park(c.id)
})

// ============================================================================
// 2. Removing one lead from a campaign
// ============================================================================

test('removing a lead withdraws the email waiting in Needs your OK', async () => {
  // The draft is the dangerous half. The pairing was deleted and the draft was
  // left pending: an email addressed to somebody no longer in the campaign, one
  // click from being sent, with no screen anywhere saying why.
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    const c = draftCampaign('Draft left behind')
    const lead = newLead()
    enrol(c.id, lead.id)
    start(c.id)
    await tick()

    const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(c.id, lead.id)
    assert.ok(draft, 'the fixture parked an email for approval')
    assert.equal(draft.status, 'pending')
    assert.equal(sentTo(lead.id), 0, 'nothing sends without a human OK')

    const res = await del(`/api/campaigns/${c.id}/leads/${lead.id}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.draftsCancelled, 1, 'the response reports the withdrawal it performed')

    assert.equal(linkOf(c.id, lead.id), undefined, 'the pairing is gone')
    assert.notEqual(
      db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'pending',
      'and the queue no longer offers an email to a lead who has left the campaign',
    )

    // The approval route is the thing that would have sent it.
    const approve = await post(`/api/drafts/${draft.id}/approve`)
    assert.notEqual(approve.status, 200, 'a withdrawn draft cannot be approved')

    await tick()
    assert.equal(sentTo(lead.id), 0, 'and no email reached the removed lead')
    park(c.id)
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('removing a lead that is not in the campaign is a 404, not a cheerful zero', async () => {
  // `200 {"removed": 0}` reads as success for work that did not happen, and it
  // is the one answer that cannot be told apart from a typo in the id. The bulk
  // route already reported `not_in_campaign`; this one now 404s like every other
  // per-lead action on a campaign.
  const mine = draftCampaign('Has the lead')
  const other = draftCampaign('Does not have the lead')
  const lead = newLead()
  enrol(mine.id, lead.id)

  const res = await del(`/api/campaigns/${other.id}/leads/${lead.id}`)
  assert.equal(res.status, 404)
  assert.ok(linkOf(mine.id, lead.id), 'and the pairing it does have is untouched')
})

test('the two removal routes agree: both withdraw the draft and both refuse an absent lead', async () => {
  // Parity with `POST /campaigns/:id/leads/remove`, which was already correct.
  // Two routes that mean the same thing must do the same thing, or which one a
  // screen happens to call decides whether an email survives.
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    const c = draftCampaign('Bulk parity')
    const lead = newLead()
    enrol(c.id, lead.id)
    start(c.id)
    await tick()
    const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(c.id, lead.id)
    assert.equal(draft.status, 'pending')

    const bulk = await post(`/api/campaigns/${c.id}/leads/remove`, { leadIds: [lead.id] })
    assert.equal(bulk.status, 200)
    assert.equal(bulk.body.results[0].draftsCancelled, 1)
    assert.notEqual(db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'pending')

    const again = await post(`/api/campaigns/${c.id}/leads/remove`, { leadIds: [lead.id] })
    assert.equal(again.body.results[0].reason, 'not_in_campaign', 'the bulk route names the miss')
    const single = await del(`/api/campaigns/${c.id}/leads/${lead.id}`)
    assert.equal(single.status, 404, 'and the single route refuses the same miss')

    await tick()
    assert.equal(sentTo(lead.id), 0)
    park(c.id)
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

// ============================================================================
// 3. A client's allowance stops that client's sending
// ============================================================================

async function clientWith(name) {
  const made = await post('/api/clients', { name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@brand.test` })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  return made.body.data
}

test('a client over its email allowance stops sending, and the reason names the client', async () => {
  const brand = await clientWith('Overspender')
  const theirs = draftCampaign('Client campaign')
  const attached = await post(`/api/clients/${brand.id}/scope`, { campaignIds: [theirs.id] })
  assert.equal(attached.status, 200)

  const first = newLead()
  const second = newLead()
  enrol(theirs.id, first.id)
  enrol(theirs.id, second.id)
  start(theirs.id)
  await tick()
  assert.equal(sentBy(theirs.id), 2, 'the client has spent two emails')

  // Lowering the allowance below usage is accepted, never refused (AC 4).
  const lowered = await patch(`/api/clients/${brand.id}`, {
    is_credit_assigned: true, email_credits: 1, lead_credits: 0,
  })
  assert.equal(lowered.status, 200)
  assert.equal(lowered.body.overAllowance.enforced, true, 'the response claims a pause')

  // A third lead the campaign has never touched: the only thing that can stop
  // this send now is the allowance.
  const third = newLead()
  enrol(theirs.id, third.id)
  await tick()
  await tick()

  assert.equal(sentTo(third.id), 0, 'an over-allowance client sends nothing at all')
  assert.equal(sentBy(theirs.id), 2, 'the count is where the breach left it')

  const gated = db.prepare(
    "SELECT detail FROM events WHERE campaign_id = ? AND type = 'send_gated' ORDER BY id DESC LIMIT 1"
  ).get(theirs.id)
  assert.ok(gated, 'the hold is on the activity trail')
  assert.match(gated.detail, /Overspender/, 'and it names the client, not just a number')
  assert.match(gated.detail, /allowance/)

  // And it lifts on its own the moment the allowance is raised: the pause is a
  // condition, not a status somebody has to remember to undo.
  const raised = await patch(`/api/clients/${brand.id}`, {
    is_credit_assigned: true, email_credits: 500, lead_credits: 0,
  })
  assert.equal(raised.status, 200)
  assert.equal(raised.body.overAllowance, null, 'no longer over')

  await tick()
  assert.equal(sentTo(third.id), 1, 'raising the allowance resumes sending with nothing else to do')
  park(theirs.id)
})

test("a client's breach stops that client only", async () => {
  // `client_id` is a partition, so the agency's own campaigns and every other
  // brand have to carry on. A ceiling that stopped the workspace would be a
  // worse failure than the one it fixes.
  const brand = await clientWith('Capped Brand')
  const capped = draftCampaign('Capped brand campaign')
  const agency = draftCampaign('Agency own campaign')
  await post(`/api/clients/${brand.id}/scope`, { campaignIds: [capped.id] })

  enrol(capped.id, newLead().id)
  enrol(capped.id, newLead().id)
  start(capped.id)
  await tick()
  assert.equal(sentBy(capped.id), 2)

  const lowered = await patch(`/api/clients/${brand.id}`, {
    is_credit_assigned: true, email_credits: 1, lead_credits: 0,
  })
  assert.equal(lowered.status, 200)
  assert.equal(lowered.body.overAllowance.enforced, true)
  const cappedSecond = newLead()
  enrol(capped.id, cappedSecond.id)

  const agencyLead = newLead()
  enrol(agency.id, agencyLead.id)
  start(agency.id)
  await tick()
  await tick()

  assert.equal(sentTo(cappedSecond.id), 0, 'the capped brand is stopped')
  assert.equal(sentTo(agencyLead.id), 1, 'and the agency\'s own campaign sent in the same tick')
  park(capped.id)
  park(agency.id)
})

test('a client on the agency pool has no ceiling of its own', async () => {
  // `assigned: false` is the default and means the brand draws on the agency
  // pool. Nothing about attaching a campaign to a client may make it stop.
  const brand = await clientWith('Pooled Brand')
  const pooled = draftCampaign('Pooled brand campaign')
  await post(`/api/clients/${brand.id}/scope`, { campaignIds: [pooled.id] })
  const lead = newLead()
  enrol(pooled.id, lead.id)
  start(pooled.id)
  await tick()
  assert.equal(sentTo(lead.id), 1, 'a pooled client sends exactly as the agency does')
  park(pooled.id)
})
