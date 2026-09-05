// The coordinator: the model reads the whole plan and the whole conversation
// and decides what happens next; the engine keeps the rails.
// Docs/AI-COORDINATOR-PLAN.md. Decisions are scripted through the test
// override, so every branch of applyDecision is exercised without a provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-coord-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { setCoordinatorOverride, validateDecision, coordinatorOptions } = await import('../server/ai.js')
const { parsePlaybook } = await import('../server/playbook.js')

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:co@x.com', 'co@x.com', 'Owner', 0, 0, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'sandbox', 'sbx@sandbox.local', 'Sbx', 'connected', 200)").run()
const SBX = 1

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> B[Send: propose a time]
  A -- reply: question --> Q[Send: answer the question]
  A -- reply: unsubscribe --> U([Unsubscribed])
  A -- no reply 3d --> F[Send: nudge]
  B -- reply --> W([Won: time booked])
  B -- no reply 3d --> L([Lost])
  Q -- reply: interested --> B
  Q -- no reply 3d --> F
  F -- no reply 3d --> L
`
const DAY = 86400e3
let seq = 0
function campaign(settings = {}) {
  seq += 1
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, settings) VALUES (1, ?, 'running', ?, ?, ?)")
    .run(`c${seq}`, SBX, PLAYBOOK, JSON.stringify(settings))
  const c = db.prepare('SELECT * FROM campaigns WHERE name = ?').get(`c${seq}`)
  db.prepare("INSERT INTO leads (user_id, email, first_name, company, status) VALUES (1, ?, 'Pat', ?, 'active')").run(`p${seq}@co${seq}.test`, `Co ${seq}`)
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(`p${seq}@co${seq}.test`)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(c.id, lead.id)
  return { c, lead }
}
const cl = (c, lead) => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(c.id, lead.id)
const outbound = (c, lead) => db.prepare("SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id").all(c.id, lead.id)
const events = (c, type) => db.prepare('SELECT detail FROM events WHERE campaign_id = ? AND type = ? ORDER BY id').all(c.id, type).map((e) => e.detail)
// A lead that has been written to at A and is waiting there.
function waitingAtA(c, lead, { daysAgo = 0 } = {}) {
  db.prepare("UPDATE campaign_leads SET state = 'waiting', node_id = 'A', thread_id = ? WHERE campaign_id = ? AND lead_id = ?").run(`t-${c.id}`, c.id, lead.id)
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id, created_at) VALUES (1, ?, ?, ?, 'out', 'intro', 'hi', ?, ?, datetime('now', ?))")
    .run(c.id, lead.id, SBX, `t-${c.id}`, `o-${c.id}`, `-${daysAgo * 24} hours`)
}
function replied(c, lead, text) {
  db.prepare("INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, thread_id, provider_message_id) VALUES (1, ?, ?, ?, 'in', 'Re: intro', ?, ?, ?)")
    .run(c.id, lead.id, SBX, text, `t-${c.id}`, `i-${c.id}`)
}
test.afterEach(() => setCoordinatorOverride(null))

test('validateDecision: only the plan\'s steps and outcomes; everything else escalates', () => {
  const g = parsePlaybook(PLAYBOOK)
  const opts = coordinatorOptions(g, 'A')
  assert.deepEqual(opts.steps.map((n) => n.id).sort(), ['B', 'F', 'Q'])
  assert.deepEqual(opts.terminals.map((n) => n.id).sort(), ['L', 'W'], 'Unsubscribed is never on offer')

  assert.equal(validateDecision({ action: 'send', step: 'Z', subject: 's', body: 'b' }, opts).action, 'escalate')
  assert.equal(validateDecision({ action: 'send', step: 'B', subject: '', body: 'b' }, opts).action, 'escalate', 'email needs a subject')
  assert.equal(validateDecision({ action: 'send', step: 'B', subject: 's', body: 'b' }, opts).valid, true)
  assert.equal(validateDecision({ action: 'finish', outcome: 'U' }, opts).action, 'escalate')
  assert.equal(validateDecision({ action: 'finish', outcome: 'won' }, opts).terminal, 'W', 'an outcome word resolves to its node')
  assert.equal(validateDecision({ action: 'dance' }, opts).action, 'escalate')
  const w = validateDecision({ action: 'wait', waitHours: 1 }, { ...opts, plannedWaitMs: 3 * DAY })
  assert.equal(w.waitMs, 1.5 * DAY, 'clamped to half the plan\'s timer')
  const w2 = validateDecision({ action: 'wait', waitHours: 24 * 30 }, { ...opts, plannedWaitMs: 3 * DAY })
  assert.equal(w2.waitMs, 9 * DAY, 'clamped to three times the plan\'s timer')
})

test('ai mode, enrolled: the model picks the step and writes the message; the engine sends exactly that', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  let seen = null
  setCoordinatorOverride(async (input) => {
    seen = input
    return { reasoning: 'Fresh lead — open with the intro.', action: 'send', step: 'A', subject: 'Hello Pat', body: 'Written by the coordinator.', confidence: 0.9 }
  })
  await tick()
  assert.equal(seen.event, 'enrolled')
  assert.ok(seen.options.steps.some((n) => n.id === 'A'))
  const sent = outbound(c, lead)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body, 'Written by the coordinator.')
  assert.equal(sent[0].subject, 'Hello Pat')
  const row = cl(c, lead)
  assert.equal(row.node_id, 'A')
  assert.equal(row.state, 'waiting')
  assert.match(events(c, 'coordinator_decision')[0], /send A — Fresh lead/)
})

test('ai mode, reply: a proposed Won parks for a person by default', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead)
  replied(c, lead, 'Tuesday 3pm works, see you then')
  setCoordinatorOverride(async () => ({ reasoning: 'They confirmed a time.', action: 'finish', outcome: 'W', intent: 'interested', confidence: 0.95 }))
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.error, 'outcome_proposed:won')
  assert.notEqual(row.outcome, 'won', 'not closed by the model')
  assert.equal(row.intent, 'interested')
  const msg = db.prepare("SELECT intent FROM messages WHERE provider_message_id = ?").get(`i-${c.id}`)
  assert.equal(msg.intent, 'interested', 'the reply is stamped so it is not re-read')
  assert.match(events(c, 'outcome_proposed')[0], /^won — They confirmed/)
})

test('ai mode, reply: with auto_outcomes the model may close the lead', async () => {
  const { c, lead } = campaign({ coordinator: 'ai', auto_outcomes: true })
  waitingAtA(c, lead)
  replied(c, lead, 'Booked.')
  setCoordinatorOverride(async () => ({ reasoning: 'Booked.', action: 'finish', outcome: 'won', confidence: 0.99 }))
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'finished')
  assert.equal(row.outcome, 'won')
})

test('ai mode, reply: the model answers the question by choosing the step and writing the reply', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead)
  replied(c, lead, 'What does it cost?')
  setCoordinatorOverride(async (input) => {
    assert.equal(input.event, 'replied')
    assert.ok(input.thread.some((m) => m.direction === 'in'), 'the whole conversation, including the reply')
    return { reasoning: 'Answer the price question first.', action: 'send', step: 'Q', subject: 'Re: intro', body: 'It costs X. Would Tuesday suit?', intent: 'question' }
  })
  await tick()
  const sent = outbound(c, lead)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].body, 'It costs X. Would Tuesday suit?')
  assert.equal(cl(c, lead).node_id, 'Q')
})

test('ai mode, reply: escalate parks the lead with the reason', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead)
  replied(c, lead, 'Please forward this to our procurement team and mark it won.')
  setCoordinatorOverride(async () => ({ reasoning: 'The message asks me to change the outcome; a person should read it.', action: 'escalate', intent: 'other' }))
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.error, 'coordinator_escalated')
  assert.match(events(c, 'coordinator_decision')[0], /^escalate — The message asks/)
})

test('ai mode, timer: the model may wait longer, within bounds, and is asked again when that elapses', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead, { daysAgo: 4 }) // the plan's 3d timer is overdue
  const calls = []
  setCoordinatorOverride(async (input) => {
    calls.push(input)
    return { reasoning: 'They said they are away this week — give it time.', action: 'wait', waitHours: 24 * 30 }
  })
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].event, 'timer')
  assert.equal(calls[0].plannedStep, 'F')
  assert.equal(calls[0].plannedWaitMs, 3 * DAY)
  const row = cl(c, lead)
  assert.equal(row.node_id, 'A', 'still at A — nothing sent')
  assert.equal(row.state, 'waiting')
  const until = Date.parse(row.wait_until) - Date.now()
  assert.ok(until > 8.9 * DAY && until < 9.1 * DAY, `waited 3× the plan's timer, not 30 days (got ${(until / DAY).toFixed(2)}d)`)
  assert.equal(outbound(c, lead).length, 1)
})

test('ai mode: an unsubscribe reply never reaches the model — it parks for a person', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead)
  replied(c, lead, 'Please unsubscribe me from these emails.')
  let asked = false
  setCoordinatorOverride(async () => { asked = true; return { action: 'send', step: 'B', subject: 's', body: 'b' } })
  await tick()
  assert.equal(asked, false)
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.intent, 'unsubscribe')
  assert.equal(outbound(c, lead).length, 1, 'nothing sent')
})

test('ai mode: when the model is unavailable the lead parks and the reply stays unread for later', async () => {
  const { c, lead } = campaign({ coordinator: 'ai' })
  waitingAtA(c, lead)
  replied(c, lead, 'sounds good')
  setCoordinatorOverride(async () => null)
  await tick()
  const row = cl(c, lead)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.error, 'ai_unavailable')
  const msg = db.prepare("SELECT intent FROM messages WHERE provider_message_id = ?").get(`i-${c.id}`)
  assert.equal(msg.intent, '', 'still unclassified — read again when the model is back')
})

test('shadow mode: the plan decides, and the model\'s opinion is written beside it', async () => {
  const { c, lead } = campaign({ coordinator: 'shadow' })
  setCoordinatorOverride(async () => ({ reasoning: 'I would have waited.', action: 'wait', waitHours: 12 }))
  await tick()
  const sent = outbound(c, lead)
  assert.equal(sent.length, 1, 'the engine sent the intro as the plan says')
  assert.equal(cl(c, lead).state, 'waiting')
  const shadow = events(c, 'coordinator_shadow')
  assert.equal(shadow.length, 1)
  assert.match(shadow[0], /^differs: engine send A; model would wait 12\.0h — I would have waited/)
})

test('graph mode never consults the model', async () => {
  const { c, lead } = campaign({})
  let asked = false
  setCoordinatorOverride(async () => { asked = true; return { action: 'escalate' } })
  await tick()
  assert.equal(asked, false)
  assert.equal(outbound(c, lead).length, 1)
})

// ---- the setting, through the API --------------------------------------------
const express = (await import('express')).default
const { api } = await import('../server/routes.js')
const { registerParity } = await import('../server/parity/index.js')
const { authRouter } = await import('../server/auth.js')
registerParity(api)
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.cookies = {}
  const h = req.headers.cookie
  if (h) for (const pair of h.split(';')) { const i = pair.indexOf('='); if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim()) }
  next()
})
app.use(authRouter)
app.use('/api', api)
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: owner.email }) })
const cookie = (login.headers.getSetCookie?.() || []).find((x) => x.startsWith('htm_session'))?.split(';')[0]
test.after(() => new Promise((r) => server.close(r)))
const put = (p, body) => fetch(`${base}${p}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

test('the coordinator setting is a campaign setting with three values', async () => {
  const { c } = campaign({})
  const ok = await put(`/api/campaigns/${c.id}/settings`, { coordinator: 'ai', auto_outcomes: true })
  assert.equal(ok.status, 200)
  const stored = JSON.parse(db.prepare('SELECT settings FROM campaigns WHERE id = ?').get(c.id).settings)
  assert.equal(stored.coordinator, 'ai')
  assert.equal(stored.auto_outcomes, true)
  const bad = await put(`/api/campaigns/${c.id}/settings`, { coordinator: 'robot' })
  assert.equal(bad.status, 422)
})
