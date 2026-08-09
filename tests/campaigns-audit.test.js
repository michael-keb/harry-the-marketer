// The campaigns-category behaviour that was changed and left unverified.
//
// Every case below covers a change made to server/parity/campaigns.js that the
// suite was green throughout — green only ever meant "no existing test touched
// this path". Three of the ten gaps (the confirm_email_change refusal, its
// same-address escape, and the lead-history ordering) are covered in
// tests/agent-followup.test.js and are deliberately not repeated here.
//
// Two rules shaped the assertions:
//
//   * Read the database and the observable effect, not the envelope. A route
//     that returns `{ ok: true }` has said nothing about what it did.
//   * Anything that claims to change sending runs `tick()` and then counts rows
//     in `messages`. The campaign-detail holding test below is the clearest
//     case: it asserts the reason the API gives *predicts the tick*, in both
//     directions, which is the only thing that makes the reason worth printing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-camp-audit-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { dailyCap } = await import('../server/pacing.js')

// A workspace that never gates on the clock, so a test that is about the daily
// cap or the export columns cannot fail because the suite ran at 6am.
db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:ca@x.com', 'ca@x.com', 'Owner', 0, 1, '00:00', '23:59', 'everyday', 'UTC')`
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
const put = (p, body) => fetch(`${base}${p}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
})
const json = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error(`not JSON (${res.status}): ${text.slice(0, 200)}`) }
}

// ---- fixtures ---------------------------------------------------------------

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> W([Won])
  A -- no reply 3d --> B[Send: bump]
  B -- no reply 5d --> L([Lost])
`

db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, created_at)
   VALUES (1, 'sandbox', 'me@sandbox.local', 'Harry', 'connected', 50, '2020-01-01 00:00:00')`
).run()
const sandboxId = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('me@sandbox.local').id

let leadSeq = 0
// A distinct domain per lead: the workspace frequency rule allows three people
// per company per week, and a shared domain would silently gate the fourth send
// for a reason no test here is about.
function seedLead(extra = {}) {
  leadSeq += 1
  const email = `p${leadSeq}@co${leadSeq}.test`
  db.prepare(
    `INSERT INTO leads (user_id, email, first_name, last_name, company, title, phone, status)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(email, extra.first_name ?? `First${leadSeq}`, extra.last_name ?? `Last${leadSeq}`,
    extra.company ?? `Co ${leadSeq}`, extra.title ?? 'Head of Ops',
    extra.phone ?? `+61 400 000 ${String(leadSeq).padStart(3, '0')}`, extra.status ?? 'active')
  return db.prepare('SELECT * FROM leads WHERE email = ?').get(email)
}

function seedCampaign(name, { status = 'draft', mermaid = PLAYBOOK, mailboxId = sandboxId } = {}) {
  db.prepare('INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, ?, ?, ?, ?)')
    .run(name, status, mailboxId, mermaid)
  return db.prepare('SELECT * FROM campaigns WHERE name = ?').get(name)
}

const attach = (campaignId, leadId) =>
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, leadId)

const sentCount = (campaignId) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'"
).get(campaignId).n

// =============================================================================
// create.md — a blank name is a validation failure, an absent one is a default
// =============================================================================

test('a present-but-blank campaign name is refused and no campaign row is written', async () => {
  // TC-4 and TC-6 are different requests. Both used to produce a campaign named
  // "Untitled campaign", so a form submitted blank quietly created a record the
  // user then had to find and rename. The assertion that matters is the row
  // count, not the status code: a 422 beside a written row would be worse than
  // either behaviour on its own.
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns').get().n

  for (const name of ['', '   ', '\t\n']) {
    const res = await post('/api/campaigns/create', { name })
    assert.equal(res.status, 422, `blank name ${JSON.stringify(name)} is refused`)
    const body = await json(res)
    assert.equal(body.field, 'name', 'and the 422 names the field')
  }

  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaigns').get().n, before,
    'three refusals wrote three nothings',
  )
})

test('an absent name still gets the default, and is really in the table', async () => {
  // The other half. Without this the fix above could be "reject everything".
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns').get().n
  const res = await post('/api/campaigns/create', {})
  const body = await json(res)
  assert.equal(res.status, 200, JSON.stringify(body))

  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(body.id)
  assert.ok(row, 'the campaign exists in the database, not only in the response')
  assert.equal(row.name, 'Untitled campaign')
  assert.equal(row.status, 'draft')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns').get().n, before + 1)
})

// =============================================================================
// get-by-id.md — the holding reason predicts what the tick does
// =============================================================================

test('the holding reason on the campaign detail predicts the tick, in both directions', async () => {
  // §2: "the response includes the holding reason and the estimated next send
  // time, matching what the pacing logic computes". "Matching" is only worth
  // anything if it is checked against the engine rather than against a second
  // copy of the arithmetic — so this asserts what the API says and then runs
  // the tick to see whether it was telling the truth.
  //
  // The mailbox's daily allowance is the gate used because it is the one that
  // fires the same way whatever hour the suite runs at: a sandbox mailbox skips
  // the clock and the spacing, and the ceiling still applies to it.
  const campaign = seedCampaign('Holding', { status: 'running' })
  attach(campaign.id, seedLead().id)

  // -- allowance spent: the API says it is holding, and the tick sends nothing.
  const today = new Date().toISOString().slice(0, 10)
  db.prepare('UPDATE mailboxes SET sent_today = daily_limit, sent_today_date = ? WHERE id = ?')
    .run(today, sandboxId)

  const held = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.equal(held.holding.sending, false, 'the page says it is not sending')
  assert.equal(held.holding.gate, 'mailbox_daily_cap', 'and names the gate the engine would hit')
  assert.match(held.holding.reason, /for today/i)

  await tick()
  assert.equal(sentCount(campaign.id), 0, 'and the engine agreed — nothing went out')

  // -- allowance restored: the API says it is sending, and the tick sends.
  db.prepare('UPDATE mailboxes SET sent_today = 0, sent_today_date = ?, next_send_at = 0 WHERE id = ?')
    .run(today, sandboxId)

  const open = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.equal(open.holding.sending, true, 'the page says it is sending again')
  assert.equal(open.holding.gate, '', 'with no gate named')

  await tick()
  assert.equal(sentCount(campaign.id), 1, 'and the engine agreed — the email went out')
})

test('a campaign that is not running says so rather than inventing a pacing reason', async () => {
  const campaign = seedCampaign('Paused holding', { status: 'paused' })
  attach(campaign.id, seedLead().id)

  const body = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.equal(body.holding.sending, false)
  assert.equal(body.holding.gate, 'not_running')

  await tick()
  assert.equal(sentCount(campaign.id), 0, 'and a paused campaign is not ticked')
})

// =============================================================================
// get-sequences.md — empty is not invalid, and a wait comes from the edge
// =============================================================================

test('a campaign nobody has drawn yet is empty, not invalid', async () => {
  // These two used to give the same answer — an errors array — which sends the
  // owner of a brand-new campaign looking for a mistake they have not made.
  const blank = seedCampaign('No playbook', { mermaid: '' })
  const body = await json(await get(`/api/campaigns/${blank.id}/steps`))

  assert.equal(body.valid, true, 'an undrawn playbook has not failed validation')
  assert.equal(body.empty, true)
  assert.deepEqual(body.steps, [])
  assert.deepEqual(body.errors, [], 'and carries no errors to display')
})

test('a diagram that fails validation still returns its errors, and is not called empty', async () => {
  const broken = seedCampaign('Broken playbook', { mermaid: 'flowchart TD\n  A[Send: nowhere]\n' })
  const body = await json(await get(`/api/campaigns/${broken.id}/steps`))

  assert.equal(body.valid, false)
  assert.equal(body.empty, false, 'the two states stay distinguishable')
  assert.ok(body.errors.length > 0, 'the validator\'s own errors come back')
  assert.deepEqual(body.steps, [])
})

test('a step\'s wait is read from the edge that reaches it, not from the step', async () => {
  // A Send node has no duration of its own. The wait belongs to the "no reply
  // 3d" edge that leads into it, and reading it off the node would report every
  // follow-up as having no delay at all.
  const campaign = seedCampaign('Waits')
  const body = await json(await get(`/api/campaigns/${campaign.id}/steps`))
  assert.equal(body.valid, true, JSON.stringify(body.errors))

  const intro = body.steps.find((s) => s.nodeId === 'A')
  const bump = body.steps.find((s) => s.nodeId === 'B')

  assert.equal(intro.seq_number, 1, 'the first Send step is position 1')
  assert.equal(bump.seq_number, 2)

  assert.equal(intro.seq_delay_details, null, 'nothing waits before the first email')
  assert.equal(bump.seq_delay_details.delayInDays, 3, 'the follow-up inherits the 3d edge')
  assert.equal(bump.seq_delay_details.from, 'A', 'and says which step it waits on')

  // The documented envelope carries the Send steps only, in path order — a Wait
  // or an outcome node is not a step in the source API's sense.
  assert.deepEqual(body.data.map((s) => s.nodeId), ['A', 'B'])
})

// =============================================================================
// export-leads.md — the documented columns, in a fixed order
// =============================================================================

// The header and the column order are the breaking part of this change: a CSV
// consumer maps by position or by name, and both moved. Asserted literally.
const EXPECTED_HEADER = [
  'lead_id', 'email', 'first_name', 'last_name', 'company_name', 'phone_number',
  'status', 'category', 'created_at',
  'title', 'state', 'node', 'outcome', 'paused_at', 'completed_at', 'last_activity',
  // Docs/leads/export.md §2: the engagement criterion and the company URL.
  // Appended rather than interleaved so every column a consumer already maps
  // keeps its position — the header still changed, which is the breaking part.
  'company_url', 'last_step_sent', 'open_count', 'click_count', 'reply_count',
]

async function exportRows(campaignId) {
  const res = await get(`/api/campaigns/${campaignId}/leads/export`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/csv/)

  // Read the raw bytes, not `res.text()`: the decoder strips a leading BOM, so
  // decoding first would make the byte-order mark impossible to assert — and
  // the BOM is what stops Excel mangling accented names.
  const bytes = new Uint8Array(await res.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'the UTF-8 byte-order mark leads the file')

  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  const lines = text.split('\r\n').filter(Boolean)
  return { header: lines[0].split(','), rows: lines.slice(1) }
}

test('the export header carries the documented columns in a fixed order', async () => {
  const campaign = seedCampaign('Export header')
  attach(campaign.id, seedLead().id)

  const { header } = await exportRows(campaign.id)
  assert.deepEqual(header, EXPECTED_HEADER)
})

test('the export carries the phone and the created date the columns promise', async () => {
  // These two were absent from the file entirely before the change, so the
  // header could name them and the rows still be short.
  const campaign = seedCampaign('Export values')
  const lead = seedLead({ phone: '+61 400 111 222' })
  attach(campaign.id, lead.id)

  const { header, rows } = await exportRows(campaign.id)
  assert.equal(rows.length, 1)
  const cells = rows[0].split(',')
  assert.equal(cells.length, header.length, 'every column has a cell')

  assert.equal(cells[header.indexOf('email')], lead.email)
  assert.equal(cells[header.indexOf('phone_number')], '+61 400 111 222', 'the phone is really in the file')
  assert.equal(
    cells[header.indexOf('created_at')],
    db.prepare('SELECT created_at FROM leads WHERE id = ?').get(lead.id).created_at,
    'and the created date is the lead\'s own, not the link\'s',
  )
})

test('the export\'s status column is the derived stage and its category is the classified intent', async () => {
  // §2: "the status column carries the derived stage and the category column
  // carries the last classified reply intent". Derived means read off the
  // messages — so the fixtures below are messages and outcomes, never a stage
  // written directly.
  const campaign = seedCampaign('Export stages')
  const untouched = seedLead()
  const contacted = seedLead()
  const replied = seedLead()
  const optedOut = seedLead({ status: 'unsubscribed' })
  for (const l of [untouched, contacted, replied, optedOut]) attach(campaign.id, l.id)

  const send = (leadId, extra = '') => db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
     VALUES (1, ?, ?, ?, 'out', 'Hi', 'Body', '', ?, 'sent')`
  ).run(campaign.id, leadId, sandboxId, `exp-${leadId}${extra}`)

  send(contacted.id)
  send(replied.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, intent)
     VALUES (1, ?, ?, ?, 'in', 'Re: Hi', 'Sounds good', '', ?, 'interested')`
  ).run(campaign.id, replied.id, sandboxId, `exp-in-${replied.id}`)
  db.prepare("UPDATE campaign_leads SET intent = 'interested' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, replied.id)

  const { header, rows } = await exportRows(campaign.id)
  const byEmail = new Map(rows.map((line) => {
    const cells = line.split(',')
    return [cells[header.indexOf('email')], cells]
  }))

  const statusOf = (lead) => byEmail.get(lead.email)[header.indexOf('status')]
  const categoryOf = (lead) => byEmail.get(lead.email)[header.indexOf('category')]

  assert.equal(statusOf(untouched), 'not contacted')
  assert.equal(statusOf(contacted), 'contacted')
  assert.equal(statusOf(replied), 'interested', 'a classified reply moves the lead past "replied"')
  assert.equal(statusOf(optedOut), 'unsubscribed', 'and an opt-out ends the ladder wherever it got to')

  assert.equal(categoryOf(replied), 'interested')
  assert.equal(categoryOf(contacted), '', 'nothing classified is empty, not a guess')
})

// =============================================================================
// all-leads-activities.md — the feed names the lead and the campaign
// =============================================================================

test('the activity feed carries the lead email and campaign name the spec names', async () => {
  const campaign = seedCampaign('Feed')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare("INSERT INTO events (user_id, campaign_id, lead_id, type, detail) VALUES (1, ?, ?, 'sent', 'Hi')")
    .run(campaign.id, lead.id)

  const body = await json(await get(`/api/activity?campaignId=${campaign.id}`))
  const entry = body.activities.find((a) => a.leadId === lead.id)
  assert.ok(entry, 'the event is in the feed')

  assert.equal(entry.lead_email, lead.email, 'read from the leads table, not stored on the event')
  assert.equal(entry.campaign_name, 'Feed')
  assert.equal(entry.activity_type, 'sent')
  assert.equal(entry.event_time, entry.createdAt)
})

test('a deleted lead does not take its history out of the feed with it', async () => {
  // The join here is a LEFT JOIN on purpose. An inner one would drop the row —
  // quieter than an error and worse, because the feed would still look
  // complete while a person's history had silently left it.
  const campaign = seedCampaign('Feed after deletion')
  const lead = seedLead()
  db.prepare("INSERT INTO events (user_id, campaign_id, lead_id, type, detail) VALUES (1, ?, ?, 'sent', 'Gone')")
    .run(campaign.id, lead.id)

  const before = await json(await get(`/api/activity?campaignId=${campaign.id}`))
  assert.equal(before.total, 1)

  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id)

  const after = await json(await get(`/api/activity?campaignId=${campaign.id}`))
  assert.equal(after.total, 1, 'the entry survives the person it referred to')
  assert.equal(after.activities[0].detail, 'Gone')
  assert.equal(after.activities[0].lead_email, '', 'with no address left to show, and no crash')
})

// =============================================================================
// get-all.md — the window and the limits that actually govern the campaign
// =============================================================================

test('the campaign list shows the schedule that was saved and the cap that really binds', async () => {
  // §2: "the maximum leads per day and the minimum gap between emails are
  // visible, because those are what explain a campaign that looks slow". The
  // cap is compared against `pacing.dailyCap` rather than against the raw
  // `daily_limit`, because the ramp is the thing that makes a new mailbox slow
  // and a list that showed 50 while the mailbox could send 10 would explain
  // nothing.
  const campaign = seedCampaign('Listed')

  const saved = await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'Australia/Sydney',
    days: [1, 2, 3, 4, 5],
    start_hour: '09:00',
    end_hour: '17:00',
    min_gap_minutes: 120,
  })
  assert.equal(saved.status, 200, await saved.text())

  const list = await json(await get('/api/campaign-list?limit=200'))
  const row = list.campaigns.find((c) => c.id === campaign.id)
  assert.ok(row, 'the campaign is listed')

  assert.equal(row.scheduler_cron_value.tz, 'Australia/Sydney')
  assert.deepEqual(row.scheduler_cron_value.days, [1, 2, 3, 4, 5])
  assert.equal(row.scheduler_cron_value.startHour, '09:00')
  assert.equal(row.scheduler_cron_value.endHour, '17:00')
  assert.equal(row.min_time_btwn_emails, 120, 'the gap the gate enforces is the gap the row shows')

  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(sandboxId)
  assert.equal(row.max_leads_per_day, dailyCap(mailbox), 'the cap is the one pacing computes')

  // And the row agrees with the campaign's own detail, so a user reading the
  // list and then opening the campaign is not told two different things.
  const detail = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.equal(detail.schedule.min_gap_minutes, row.min_time_btwn_emails)
  assert.equal(detail.schedule.timezone, row.scheduler_cron_value.tz)
})

test('a campaign with no mailbox reports no cap rather than a cap of zero', async () => {
  // "No mailbox attached" and "allowed to send nothing" are different states,
  // and a 0 would read as the second.
  const campaign = seedCampaign('Unattached', { mailboxId: null })
  const list = await json(await get('/api/campaign-list?limit=200'))
  const row = list.campaigns.find((c) => c.id === campaign.id)
  assert.equal(row.max_leads_per_day, null)
})

// =============================================================================
// get-lead-by-id.md — email_stats is read off the messages
// =============================================================================

test('email_stats is derived from the thread, and a test send does not fake engagement', async () => {
  // The sharp case is the opened test send. `send_status = 'test'` is excluded
  // by the same REAL_SEND predicate Reports uses, so a test email that was
  // opened must not make the lead look engaged — otherwise pressing "send me a
  // test" would move a figure someone is judged on.
  const campaign = seedCampaign('Engagement')
  const engaged = seedLead()
  const tested = seedLead()
  attach(campaign.id, engaged.id)
  attach(campaign.id, tested.id)

  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status, opened_at, clicked_at)
     VALUES (1, ?, ?, ?, 'out', 'Hi', 'Body', '', 'eng-1', 'sent', '2026-01-01 00:00:00', '2026-01-01 00:01:00')`
  ).run(campaign.id, engaged.id, sandboxId)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id)
     VALUES (1, ?, ?, ?, 'in', 'Re: Hi', 'Yes', '', 'eng-2')`
  ).run(campaign.id, engaged.id, sandboxId)

  // A test send that was opened. Everything about it looks like engagement
  // except the one column that says it is not outreach.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status, opened_at, clicked_at)
     VALUES (1, ?, ?, ?, 'out', '[TEST] Hi', 'Body', '', 'eng-3', 'test', '2026-01-01 00:00:00', '2026-01-01 00:01:00')`
  ).run(campaign.id, tested.id, sandboxId)

  const real = await json(await get(`/api/campaigns/${campaign.id}/leads/${engaged.id}`))
  assert.deepEqual(real.email_stats, { is_opened: true, is_clicked: true, is_replied: true })

  const fake = await json(await get(`/api/campaigns/${campaign.id}/leads/${tested.id}`))
  assert.equal(fake.email_stats.is_opened, false, 'an opened test send is not an open')
  assert.equal(fake.email_stats.is_clicked, false)
  assert.equal(fake.email_stats.is_replied, false)
})

test('a campaign that never measured opens reports null, not false', async () => {
  // "Nobody opened it" and "we did not measure opens" are different facts, and
  // returning `false` for the second is how a campaign gets judged for a number
  // it was never allowed to collect.
  const campaign = seedCampaign('Untracked')
  db.prepare('UPDATE campaigns SET track_opens = 0, track_clicks = 0 WHERE id = ?').run(campaign.id)
  const lead = seedLead()
  attach(campaign.id, lead.id)

  const body = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}`))
  assert.equal(body.email_stats.is_opened, null)
  assert.equal(body.email_stats.is_clicked, null)
  assert.equal(body.email_stats.is_replied, false, 'a reply is a fact whatever tracking is set to')
})

test('a human correction to a reply intent is distinguishable from the classifier\'s guess', async () => {
  const campaign = seedCampaign('Corrected')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare(
    "UPDATE campaign_leads SET intent = 'not now', intent_set_by = ? WHERE campaign_id = ? AND lead_id = ?"
  ).run(owner.email, campaign.id, lead.id)

  const body = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}`))
  assert.equal(body.category_name, 'not now')
  assert.equal(body.category_set_by, owner.email)
  assert.equal(body.category_human_corrected, true)

  db.prepare("UPDATE campaign_leads SET intent_set_by = '' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, lead.id)
  const guessed = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}`))
  assert.equal(guessed.category_human_corrected, false, 'an unattributed intent is the classifier\'s')
})

// =============================================================================
// get-email-accounts.md — health a person can read
// =============================================================================

test('the campaign mailbox list names the type in words and counts real send failures', async () => {
  const campaign = seedCampaign('Mailbox panel')
  db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)')
    .run(campaign.id, sandboxId)

  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
     VALUES (1, ?, NULL, ?, 'out', 'Nope', 'Body', '', 'fail-1', 'failed')`
  ).run(campaign.id, sandboxId)

  const body = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  assert.ok(Array.isArray(body.data), 'the documented envelope is an array')
  const row = body.data.find((m) => m.id === sandboxId)

  assert.equal(row.from_email, 'me@sandbox.local')
  assert.equal(row.from_name, 'Harry')
  assert.equal(row.type, 'Sandbox', 'a word a person reads, not a protocol name')
  assert.equal(row.warmup_enabled, false)
  assert.equal(row.needs_reconnect, false)
  assert.equal(row.recentFailures, 1, 'the failed send is counted')
  assert.equal(body.canLaunch, true)

  // `mailboxes` and `data` are the same array, never two that can disagree.
  assert.deepEqual(body.mailboxes, body.data)
})

test('a mailbox that has lost its authorisation is flagged for reconnection', async () => {
  const campaign = seedCampaign('Broken mailbox')
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, last_error, created_at)
     VALUES (1, 'gmail', 'revoked@company.test', 'Rev', 'error', 50, 'Token revoked', '2020-01-01 00:00:00')`
  ).run()
  const brokenId = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('revoked@company.test').id
  db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)')
    .run(campaign.id, brokenId)

  const body = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  const row = body.data.find((m) => m.id === brokenId)

  assert.equal(row.needs_reconnect, true)
  assert.equal(row.type, 'Gmail')
  assert.equal(row.lastError, 'Token revoked', 'and says what went wrong in the provider\'s own words')
})

test('a campaign with no mailboxes says it cannot launch rather than returning a bare empty list', async () => {
  const campaign = seedCampaign('No mailboxes', { mailboxId: null })
  const body = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  assert.deepEqual(body.data, [])
  assert.equal(body.canLaunch, false)
})
