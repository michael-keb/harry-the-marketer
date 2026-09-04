// What happens to a REAL recipient when the AI cannot do its job.
//
// The first live run of this product, with the monthly allowance exhausted,
// emailed a prospect the raw playbook instruction ("close - propose booking the
// haircut this week, offer two windows") and then marked the lead Won on a
// keyword match against "can you send me more information?". Both are the same
// defect: degraded AI silently kept acting. Now a real recipient gets a person;
// a sandbox recipient keeps the template/keyword path the rehearsal relies on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-degraded-'))
process.env.AI_MODE = 'off' // every compose falls to template, every classify to keywords

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { heuristicClassify } = await import('../server/ai.js')
const { describePlaybook, parsePlaybook } = await import('../server/playbook.js')

// A real (non-sandbox) mailbox is gated by the recipient quiet-hours floor,
// which falls back to the sender's timezone. Pin that timezone to wherever it
// is currently midday so the send gate is open whatever hour the suite runs.
const shift = 12 - new Date().getUTCHours() // hours to add to UTC
const NOON_TZ = shift === 0 ? 'UTC' : `Etc/GMT${shift > 0 ? '-' : '+'}${Math.abs(shift)}`
db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:dg@x.com', 'dg@x.com', 'Owner', 0, 0, '00:00', '23:59', 'everyday', ?)`
).run(NOON_TZ)
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'gmail', 'real@x.com', 'Real', 'connected', 50)").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'sandbox', 'sbx@sandbox.local', 'Sbx', 'connected', 50)").run()
const REAL = 1
const SBX = 2

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: close - propose booking the haircut this week]
  A -- reply: interested --> W([Won: haircut booked])
  A -- reply: question --> Q[Send: answer their question]
  A -- no reply 3d --> L([Lost])
  Q -- reply: interested --> W
  Q -- no reply 3d --> L
`
let seq = 0
function campaign(mailboxId, extra = {}) {
  seq += 1
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, purpose) VALUES (1, ?, 'running', ?, ?, ?)")
    .run(`c${seq}`, mailboxId, PLAYBOOK, extra.purpose || 'commercial')
  const c = db.prepare('SELECT * FROM campaigns WHERE name = ?').get(`c${seq}`)
  db.prepare("INSERT INTO leads (user_id, email, first_name, company, status) VALUES (1, ?, 'Pat', ?, 'active')").run(`p${seq}@co${seq}.test`, `Co ${seq}`)
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(`p${seq}@co${seq}.test`)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(c.id, lead.id)
  return { c, lead }
}
const cl = (c, lead) => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(c.id, lead.id)
const outbound = (c, lead) => db.prepare("SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out'").all(c.id, lead.id)
const drafts = (c, lead) => db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').all(c.id, lead.id)

test('a real recipient never receives template copy: the step parks as a draft for a person', async () => {
  const { c, lead } = campaign(REAL)
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.error, 'ai_unavailable')
  assert.equal(outbound(c, lead).length, 0, 'nothing left the mailbox')
  const d = drafts(c, lead)
  assert.equal(d.length, 1, 'a rough draft is waiting for review')
  assert.equal(d[0].status, 'pending')
  const ev = db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND type = 'ai_unavailable'").get(c.id)
  assert.match(ev.detail, /parked for a person/)
})

test('a sandbox recipient still gets the template send — the rehearsal depends on it', async () => {
  const { c, lead } = campaign(SBX)
  await tick()
  assert.equal(cl(c, lead).state, 'waiting')
  assert.equal(outbound(c, lead).length, 1)
})

test('a keyword-classified reply to a real recipient parks instead of routing — no Won on a guess', async () => {
  const { c, lead } = campaign(REAL)
  // Put the lead where a real send would have left it, without sending.
  db.prepare("UPDATE campaign_leads SET state = 'waiting', node_id = 'A', thread_id = 't-1' WHERE campaign_id = ? AND lead_id = ?").run(c.id, lead.id)
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id) VALUES (1, ?, ?, ?, 'out', 'hi', 'b', 't-1', 'o-1')").run(c.id, lead.id, REAL)
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id) VALUES (1, ?, ?, ?, 'in', 'Re: hi', 'sounds good, book a call', 't-1', 'i-1')").run(c.id, lead.id, REAL)
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention', 'parked, not routed')
  assert.equal(row.error, 'ai_unavailable')
  assert.equal(row.intent, 'interested', 'the keyword reading is shown to the person')
  assert.notEqual(row.outcome, 'won')
  const msg = db.prepare("SELECT intent FROM messages WHERE provider_message_id = 'i-1'").get()
  assert.equal(msg.intent, 'interested', 'stamped so it is not re-read every tick')
})

test('a keyword-classified reply to a sandbox recipient still routes', async () => {
  const { c, lead } = campaign(SBX)
  db.prepare("UPDATE campaign_leads SET state = 'waiting', node_id = 'A', thread_id = 't-2' WHERE campaign_id = ? AND lead_id = ?").run(c.id, lead.id)
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id) VALUES (1, ?, ?, ?, 'out', 'hi', 'b', 't-2', 'o-2')").run(c.id, lead.id, SBX)
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id) VALUES (1, ?, ?, ?, 'in', 'Re: hi', 'sounds good, book a call', 't-2', 'i-2')").run(c.id, lead.id, SBX)
  await tick()
  assert.equal(cl(c, lead).outcome, 'won')
})

test('"can you send me more information?" is a question, not a yes', () => {
  const vocab = ['interested', 'question', 'not now', 'other']
  assert.equal(heuristicClassify('Cna you send me more information though?', vocab).intent, 'question')
  assert.equal(heuristicClassify('Sounds good — tell me more.', vocab).intent, 'interested', 'no question mark: still interest')
  assert.equal(heuristicClassify('send me more info?', ['interested', 'other']).intent, 'interested', 'without a question edge the phrase still counts as interest')
})

test('the agreement link is only offered where there is something to agree to', async () => {
  // Commercial plan, interested lead, sandbox mailbox so the template path runs
  // and would print the link if one were offered.
  const { c, lead } = campaign(SBX)
  db.prepare("UPDATE campaign_leads SET state = 'active', node_id = 'Q', intent = 'interested' WHERE campaign_id = ? AND lead_id = ?").run(c.id, lead.id)
  await tick()
  const sent = outbound(c, lead).at(-1)
  assert.ok(sent, 'sent')
  assert.doesNotMatch(sent.body, /\/agree\//, 'a haircut pitch carries no consent link')

  const nc = campaign(SBX, { purpose: 'assessment' })
  db.prepare("UPDATE campaign_leads SET state = 'active', node_id = 'Q', intent = 'interested' WHERE campaign_id = ? AND lead_id = ?").run(nc.c.id, nc.lead.id)
  await tick()
  const sent2 = outbound(nc.c, nc.lead).at(-1)
  assert.match(sent2.body, /\/agree\//, 'a non-commercial ask puts the yes on record')
})

test('approving a parked draft puts the lead back in play and it sends', async () => {
  // Drive the same path the approve route takes: approve + un-park + tick.
  const { c, lead } = campaign(REAL)
  await tick()
  assert.equal(cl(c, lead).state, 'needs_attention')
  const d = drafts(c, lead)[0]
  db.prepare("UPDATE drafts SET status = 'approved', subject = 'Real subject', body = 'A person wrote this.' WHERE id = ?").run(d.id)
  db.prepare("UPDATE campaign_leads SET state = 'active', error = '' WHERE campaign_id = ? AND lead_id = ? AND state = 'needs_attention' AND error IN ('purpose_blocked','ai_unavailable')").run(c.id, lead.id)
  // The gmail transport cannot deliver in a test; what matters is the lead
  // is selectable again and reaches the send gate with the approved copy.
  await tick()
  const row = cl(c, lead)
  assert.notEqual(row.state, 'needs_attention', 'no longer parked')
  assert.notEqual(row.error, 'ai_unavailable')
})

test('the plan description names every step, branch, outcome and the current position', () => {
  const g = parsePlaybook(PLAYBOOK)
  const text = describePlaybook(g, 'Q')
  assert.match(text, /THE PLAN/)
  assert.match(text, /A \(send email: "close - propose booking the haircut this week"\)/)
  assert.match(text, /if they reply "interested" → W \(END — Won: haircut booked\)/)
  assert.match(text, /if no reply after 3d → L/)
  assert.match(text, /Outcomes: W = "Won: haircut booked"; L = "Lost"/)
  assert.match(text, /THIS PERSON IS NOW AT: Q .* reached via S \[then\] → A \[if they reply "question"\] → Q/)
  assert.equal(describePlaybook(parsePlaybook('nonsense'), 'A'), '', 'an invalid graph describes nothing')
})

test('an operator allowance override replaces the plan table', async () => {
  const { monthlyAllowanceCents } = await import('../server/ai-spend.js')
  const before = monthlyAllowanceCents(1)
  process.env.AI_MONTHLY_ALLOWANCE_CENTS = '123456'
  assert.equal(monthlyAllowanceCents(1), 123456)
  delete process.env.AI_MONTHLY_ALLOWANCE_CENTS
  assert.equal(monthlyAllowanceCents(1), before)
})
