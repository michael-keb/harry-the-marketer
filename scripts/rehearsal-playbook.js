#!/usr/bin/env node
// Scripted run of Docs/campaigns/playbook-workflow-test-plan.md against the
// real server code: sandbox mailbox, real engine ticks, simulated replies.
// Time is advanced by backdating the timer anchor (outbound created_at) and,
// where the case calls for it, the frozen wait_until — the same instants the
// engine reads — so every branch decision is made by production code.
//
// Run: node scripts/rehearsal-playbook.js   (exits non-zero on any failure)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-rehearsal-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick, campaignCtx, routeReply } = await import('../server/engine.js')
const { simulateReply } = await import('../server/mailer.js')

// Workspace that never gates on the clock.
db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:rehearse@x.com', 'rehearse@x.com', 'Rehearser', 0, 1, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()

const REHEARSAL_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: short intro email — who we are and the problem we solve]
    A -- reply: interested --> B[Send: thanks — propose a 15-minute call this week]
    A -- reply: question --> Q[Send: answer their question directly, then suggest a call]
    A -- reply: not now --> N[Wait: 30d]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 30s --> F[Send: one-line friendly nudge]
    F -- reply: interested --> B
    F -- reply: question --> Q
    F -- no reply 40s --> L([Lost: no response])
    Q -- reply: interested --> B
    B -- reply: interested --> W([Won: call booked])
    B -- no reply 40s --> L
`

function seedMailbox(email, dailyLimit = 50) {
  db.prepare(
    "INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit) VALUES (1, 'sandbox', ?, ?, 'connected', ?)"
  ).run(email, email.split('@')[0], dailyLimit)
  return db.prepare('SELECT * FROM mailboxes WHERE email = ?').get(email)
}
function seedCampaign(name, mailboxId, mermaid = REHEARSAL_PLAYBOOK) {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, ?, 'running', ?, ?)")
    .run(name, mailboxId, mermaid)
  return db.prepare('SELECT * FROM campaigns WHERE name = ?').get(name)
}
let leadSeq = 0
function seedLead() {
  leadSeq += 1
  // Distinct company/domain per lead so the per-company weekly cap never gates.
  db.prepare("INSERT INTO leads (user_id, email, first_name, company, status) VALUES (1, ?, ?, ?, 'active')")
    .run(`cand${leadSeq}@co${leadSeq}.test`, `Cand${leadSeq}`, `Co ${leadSeq}`)
  return db.prepare('SELECT * FROM leads WHERE email = ?').get(`cand${leadSeq}@co${leadSeq}.test`)
}
const mb1 = seedMailbox('sender@sandbox.local')
const camp = seedCampaign('Rehearsal', mb1.id)

const attach = (campaignId, leadId) =>
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, leadId)
const cl = (campaignId, leadId) =>
  db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)
const outbound = (campaignId, leadId) =>
  db.prepare("SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id").all(campaignId, leadId)
const events = (campaignId, leadId, type) =>
  db.prepare('SELECT * FROM events WHERE campaign_id = ? AND lead_id = ? AND type = ? ORDER BY id').all(campaignId, leadId, type)
const reply = (campaignId, leadId, text) => simulateReply({ user, campaignLead: cl(campaignId, leadId), text })

// Advance time for one pairing: age its outbound mail (the timer anchor) and,
// if a wait is frozen, age the frozen clock the same way.
function elapse(campaignId, leadId, seconds) {
  db.prepare(
    `UPDATE messages SET created_at = datetime(created_at, '-' || ? || ' seconds')
      WHERE campaign_id = ? AND lead_id = ? AND direction = 'out'`
  ).run(seconds, campaignId, leadId)
  const row = cl(campaignId, leadId)
  if (row.wait_until) {
    const moved = new Date(Date.parse(row.wait_until) - seconds * 1000).toISOString()
    db.prepare('UPDATE campaign_leads SET wait_until = ? WHERE id = ?').run(moved, row.id)
  }
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (err) {
    results.push({ name, ok: false, err: String(err.message || err).split('\n')[0] })
    console.log(`FAIL  ${name}\n      ${String(err.message || err).split('\n')[0]}`)
  }
}

// ---- cases ------------------------------------------------------------------

const lead1 = seedLead(); attach(camp.id, lead1.id)
await run('1. Happy path A → B → Won', async () => {
  await tick()
  assert.equal(cl(camp.id, lead1.id).node_id, 'A')
  assert.equal(outbound(camp.id, lead1.id).length, 1, 'intro sent')
  reply(camp.id, lead1.id, "Sounds good — tell me more.")
  await tick()
  assert.equal(cl(camp.id, lead1.id).node_id, 'B', 'branched to proposal')
  reply(camp.id, lead1.id, "Sounds good — let's talk, book a call.")
  await tick()
  const row = cl(camp.id, lead1.id)
  assert.equal(row.state, 'finished')
  assert.equal(row.outcome, 'won')
})

const lead2 = seedLead(); attach(camp.id, lead2.id)
await run('2. Question first A → Q → B → Won', async () => {
  await tick()
  reply(camp.id, lead2.id, 'What is your pricing?')
  await tick()
  assert.equal(cl(camp.id, lead2.id).node_id, 'Q')
  reply(camp.id, lead2.id, 'Sounds good — tell me more.')
  await tick()
  assert.equal(cl(camp.id, lead2.id).node_id, 'B')
  reply(camp.id, lead2.id, "Sounds good, let's talk.")
  await tick()
  assert.equal(cl(camp.id, lead2.id).outcome, 'won')
})

const lead3 = seedLead(); attach(camp.id, lead3.id)
await run('3. Not now → parked at N with a ~30d clock', async () => {
  await tick()
  reply(camp.id, lead3.id, 'Not now, maybe later.')
  await tick()
  const row = cl(camp.id, lead3.id)
  assert.equal(row.node_id, 'N')
  assert.equal(row.state, 'waiting')
  const days = (Date.parse(row.wait_until) - Date.now()) / 86400e3
  assert.ok(days > 29 && days < 31, `wait_until ~30d out, got ${days.toFixed(1)}d`)
})

const lead4 = seedLead(); attach(camp.id, lead4.id)
await run('4. Unsubscribe: machine parks for a person; confirmation opts out; re-attach never sends', async () => {
  await tick()
  reply(camp.id, lead4.id, 'Please unsubscribe me.')
  await tick()
  let row = cl(camp.id, lead4.id)
  assert.equal(row.state, 'needs_attention', 'the machine may not act on its own unsubscribe reading')
  assert.equal(row.intent, 'unsubscribe')
  // A person confirms from the inbox.
  const ctx = campaignCtx(camp.id)
  const msg = db.prepare("SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'in'").get(camp.id, lead4.id)
  await routeReply(ctx, cl(camp.id, lead4.id), 'unsubscribe', msg, { setBy: user.email })
  row = cl(camp.id, lead4.id)
  assert.equal(row.outcome, 'unsubscribed')
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead4.id).status, 'unsubscribed')
  // Remove and re-attach: suppression must hold.
  const before = outbound(camp.id, lead4.id).length
  db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').run(camp.id, lead4.id)
  attach(camp.id, lead4.id)
  await tick()
  assert.equal(outbound(camp.id, lead4.id).length, before, 'no email to an unsubscribed address')
  assert.notEqual(cl(camp.id, lead4.id).state, 'waiting')
})

const lead5 = seedLead(); attach(camp.id, lead5.id)
await run('5. Silent lead A → F → Lost on the two timers', async () => {
  await tick() // intro
  await tick() // freeze the A timer
  assert.ok(cl(camp.id, lead5.id).wait_until, 'A timer frozen')
  elapse(camp.id, lead5.id, 60)
  await tick()
  assert.equal(cl(camp.id, lead5.id).node_id, 'F', 'nudge fired')
  assert.equal(outbound(camp.id, lead5.id).length, 2)
  await tick() // freeze the F timer
  elapse(camp.id, lead5.id, 60)
  await tick()
  const row = cl(camp.id, lead5.id)
  assert.equal(row.state, 'finished')
  assert.equal(row.outcome, 'lost')
})

const lead6 = seedLead(); attach(camp.id, lead6.id)
await run('6. Late interest: nudge fires, reply on the nudge still routes A → F → B → Won', async () => {
  await tick(); await tick()
  elapse(camp.id, lead6.id, 60)
  await tick()
  assert.equal(cl(camp.id, lead6.id).node_id, 'F')
  reply(camp.id, lead6.id, 'Sounds good — tell me more.')
  await tick()
  assert.equal(cl(camp.id, lead6.id).node_id, 'B')
  reply(camp.id, lead6.id, "Sure, let's talk.")
  await tick()
  assert.equal(cl(camp.id, lead6.id).outcome, 'won')
})

const lead7 = seedLead(); attach(camp.id, lead7.id)
await run('7. Question on the nudge routes F → Q → B', async () => {
  await tick(); await tick()
  elapse(camp.id, lead7.id, 60)
  await tick()
  reply(camp.id, lead7.id, 'How does it work?')
  await tick()
  assert.equal(cl(camp.id, lead7.id).node_id, 'Q')
  reply(camp.id, lead7.id, 'Sounds good — book a call.')
  await tick()
  assert.equal(cl(camp.id, lead7.id).node_id, 'B')
})

const lead8 = seedLead(); attach(camp.id, lead8.id)
await run('8. Q has no timeout (the authored warning): lead waits there', async () => {
  await tick()
  reply(camp.id, lead8.id, 'What does it cost?')
  await tick()
  assert.equal(cl(camp.id, lead8.id).node_id, 'Q')
  elapse(camp.id, lead8.id, 600)
  await tick(); await tick()
  const row = cl(camp.id, lead8.id)
  assert.equal(row.node_id, 'Q')
  assert.equal(row.state, 'waiting', 'no timeout edge — waits, as the Playbook tab warns')
})

await run('9. Approval gate: nothing sends until the edited draft is approved; the sent email is the edit', async () => {
  db.prepare('UPDATE campaigns SET require_approval = 1 WHERE id = ?').run(camp.id)
  const lead = seedLead(); attach(camp.id, lead.id)
  await tick()
  assert.equal(outbound(camp.id, lead.id).length, 0, 'held for approval')
  const draft = db.prepare("SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'").get(camp.id, lead.id)
  assert.ok(draft, 'draft parked in Needs your OK')
  db.prepare("UPDATE drafts SET subject = 'Edited by hand', status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(user.email, draft.id)
  await tick()
  const sent = outbound(camp.id, lead.id)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, 'Edited by hand', 'the approved edit is what left')
  db.prepare('UPDATE campaigns SET require_approval = 0 WHERE id = ?').run(camp.id)
})

const lead10 = seedLead(); attach(camp.id, lead10.id)
await run('10. Unmatched intent (not interested) parks as needs attention with the intent recorded', async () => {
  await tick()
  reply(camp.id, lead10.id, 'Not interested, no thanks.')
  await tick()
  const row = cl(camp.id, lead10.id)
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.intent, 'not interested')
})

const lead11 = seedLead(); attach(camp.id, lead11.id)
await run('11. Proposal ignored: Lost fires from B, not from F', async () => {
  await tick()
  reply(camp.id, lead11.id, 'Sounds good — tell me more.')
  await tick()
  assert.equal(cl(camp.id, lead11.id).node_id, 'B')
  await tick() // freeze B timer
  elapse(camp.id, lead11.id, 60)
  await tick()
  const row = cl(camp.id, lead11.id)
  assert.equal(row.outcome, 'lost')
  const branch = events(camp.id, lead11.id, 'branched').map((e) => e.detail).join(' | ')
  assert.match(branch, /B --\[no reply 40s\]--> L/, `Lost came from B: ${branch}`)
})

const lead12 = seedLead(); attach(camp.id, lead12.id)
await run('12. The F → Lost timer counts from the nudge send, not the intro', async () => {
  await tick(); await tick()
  elapse(camp.id, lead12.id, 60)
  await tick() // F sends now
  await tick() // F timer freezes
  const row = cl(camp.id, lead12.id)
  const nudge = outbound(camp.id, lead12.id).at(-1)
  const nudgeAt = Date.parse(nudge.created_at.replace(' ', 'T') + 'Z')
  const secs = (Date.parse(row.wait_until) - nudgeAt) / 1000
  assert.ok(secs > 30 && secs < 50, `frozen ${secs.toFixed(1)}s after the nudge (40s ± smart-timing bounds)`)
})

await run('13. Two leads, independent clocks and branches', async () => {
  const a = seedLead(); attach(camp.id, a.id)
  const b = seedLead(); attach(camp.id, b.id)
  await tick()
  reply(camp.id, a.id, 'Sounds good — tell me more.')
  await tick()
  assert.equal(cl(camp.id, a.id).node_id, 'B')
  assert.equal(cl(camp.id, b.id).node_id, 'A', 'the other lead did not move')
  assert.equal(outbound(camp.id, b.id).length, 1)
})

await run('14. Stop mid-wait: nothing fires while paused; resume fires the expired timer', async () => {
  const lead = seedLead(); attach(camp.id, lead.id)
  await tick(); await tick()
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(camp.id)
  elapse(camp.id, lead.id, 120)
  await tick()
  assert.equal(cl(camp.id, lead.id).node_id, 'A', 'paused campaign did not advance')
  assert.equal(outbound(camp.id, lead.id).length, 1)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(camp.id)
  await tick()
  assert.equal(cl(camp.id, lead.id).node_id, 'F', 'expired timer fired on the first tick after resume')
})

await run('15. Daily limit + follow-up reserve: two of three send, the third goes when the cap lifts', async () => {
  // The last ~30% of a mailbox's day is reserved for follow-ups, so a limit of
  // 3 allows 2 fresh approaches; the third waits with a named reason.
  const mb = seedMailbox('capped@sandbox.local', 3)
  const c = seedCampaign('Capped', mb.id)
  const trio = [seedLead(), seedLead(), seedLead()]
  for (const l of trio) attach(c.id, l.id)
  await tick()
  const sent = trio.filter((l) => outbound(c.id, l.id).length === 1)
  assert.equal(sent.length, 2, `fresh-approach allowance went out (got ${sent.length})`)
  const gate = db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND type = 'send_gated'").get(c.id)
  assert.match(gate?.detail || '', /follow-ups|allowance|limit/i, 'the third lead was told why')
  db.prepare('UPDATE mailboxes SET daily_limit = 10 WHERE id = ?').run(mb.id)
  await tick()
  assert.equal(trio.filter((l) => outbound(c.id, l.id).length === 1).length, 3, 'third sent after the cap lifted')
})

const lead16 = seedLead(); attach(camp.id, lead16.id)
await run('16. Two replies before one tick: handled oldest-first, one branch each (fix #6)', async () => {
  await tick()
  reply(camp.id, lead16.id, 'What is your pricing?')
  reply(camp.id, lead16.id, 'Sounds good — tell me more.')
  await tick()
  assert.equal(cl(camp.id, lead16.id).node_id, 'Q', 'older question routed first')
  await tick()
  assert.equal(cl(camp.id, lead16.id).node_id, 'B', 'newer interested routed second, at Q')
  const order = events(camp.id, lead16.id, 'branched').map((e) => e.detail).join(' | ')
  assert.match(order, /reply: question.*reply: interested/s, order)
})

const lead17 = seedLead(); attach(camp.id, lead17.id)
await run('17. A hand-corrected intent sticks; the classifier never overrules it (fix #2)', async () => {
  await tick()
  reply(camp.id, lead17.id, 'Sounds good — tell me more.') // would classify interested
  db.prepare("UPDATE campaign_leads SET intent = 'not now', intent_set_by = ?, intent_set_at = ? WHERE campaign_id = ? AND lead_id = ?")
    .run(user.email, new Date().toISOString(), camp.id, lead17.id)
  await tick(); await tick()
  const msg = db.prepare("SELECT intent FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'in'").get(camp.id, lead17.id)
  assert.equal(msg.intent, 'not now', 'the human reading was stamped onto the reply')
  assert.equal(cl(camp.id, lead17.id).node_id, 'A', 'no branch on the classifier reading')
  assert.equal(events(camp.id, lead17.id, 'classified').length, 0, 'classifier never ran')
})

await run('18. Two-timer ladder: the 30s edge fires at 60s; the 2m edge never fires early (fix #1)', async () => {
  const c = seedCampaign('Ladder', seedMailbox('ladder@sandbox.local').id, `flowchart TD
    S([Start]) --> A[Send: intro]
    A -- no reply 30s --> F[Send: quick follow-up]
    A -- no reply 2m --> G[Send: much later check-in]
    F -- reply --> W([Won])
    G -- reply --> W
    F -- no reply 5m --> L([Lost])
    G -- no reply 5m --> L
  `)
  const lead = seedLead(); attach(c.id, lead.id)
  await tick(); await tick()
  elapse(c.id, lead.id, 60)
  await tick()
  const row = cl(c.id, lead.id)
  assert.equal(row.node_id, 'F', '30s edge fired')
  const branch = events(c.id, lead.id, 'branched').map((e) => e.detail).join(' | ')
  assert.ok(!/--> G/.test(branch), `the 2m edge stayed quiet: ${branch}`)
})

await run('19. Edit mid-wait: an unrelated edit moves nothing; deleting the node parks the lead (fix #5)', async () => {
  // Real HTTP save path, so the orphan-parking transaction runs.
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
    if (h) for (const pair of h.split(';')) {
      const i = pair.indexOf('=')
      if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
    }
    next()
  })
  app.use(authRouter)
  app.use('/api', api)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const login = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email }),
    })
    const cookie = (login.headers.getSetCookie?.() || []).find((x) => x.startsWith('htm_session'))?.split(';')[0]
    assert.ok(cookie, 'signed in')

    // Own mailbox: by this point the shared one is near its fresh-approach
    // cutoff (daily cap minus the follow-up reserve) and would gate the intro.
    const c = seedCampaign('EditMidWait', seedMailbox('edit@sandbox.local').id)
    const lead = seedLead(); attach(c.id, lead.id)
    await tick(); await tick()
    elapse(c.id, lead.id, 60)
    await tick()
    assert.equal(cl(c.id, lead.id).node_id, 'F', 'lead waiting at the nudge step')
    await tick()
    const frozen = cl(c.id, lead.id).wait_until

    // A running campaign's sequence is edit-locked; the real flow is
    // pause → edit → resume, so the rehearsal does the same.
    const setStatus = (s) => db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(s, c.id)
    const put = (mermaid) => fetch(`${base}/api/campaigns/${c.id}/sequence`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ mermaid }),
    })

    const unrelated = REHEARSAL_PLAYBOOK.replace('who we are and the problem we solve', 'a slightly different intro')
    setStatus('paused')
    const ok = await put(unrelated)
    assert.equal(ok.status, 200, `unrelated edit saves (${ok.status})`)
    setStatus('running')
    assert.equal(cl(c.id, lead.id).wait_until, frozen, 'frozen timer untouched by the edit')
    assert.equal(cl(c.id, lead.id).node_id, 'F')

    const withoutF = `flowchart TD
    S([Start]) --> A[Send: a slightly different intro]
    A -- reply: interested --> B[Send: thanks — propose a 15-minute call this week]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 30s --> L([Lost: no response])
    B -- reply: interested --> W([Won: call booked])
    B -- no reply 40s --> L
`
    setStatus('paused')
    const removed = await put(withoutF)
    assert.equal(removed.status, 200, `node-removing edit saves (${removed.status})`)
    setStatus('running')
    const row = cl(c.id, lead.id)
    assert.equal(row.state, 'needs_attention', 'lead at a deleted step is parked for a person, not restarted')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

await run('20. Two mailboxes rotate; a conversation keeps its sender', async () => {
  const a = seedMailbox('rot-a@sandbox.local')
  const b = seedMailbox('rot-b@sandbox.local')
  const c = seedCampaign('Rotation', a.id)
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(c.id, b.id)
  const four = [seedLead(), seedLead(), seedLead(), seedLead()]
  for (const l of four) attach(c.id, l.id)
  await tick()
  const senders = four.map((l) => outbound(c.id, l.id)[0]?.mailbox_id)
  assert.ok(senders.every(Boolean), 'all four intros sent')
  assert.ok(senders.includes(a.id) && senders.includes(b.id), `both mailboxes used: ${senders.join(',')}`)
  // Follow-up keeps the intro's sender.
  const leadB = four.find((l) => outbound(c.id, l.id)[0].mailbox_id === b.id)
  await tick()
  elapse(c.id, leadB.id, 60)
  await tick()
  const msgs = outbound(c.id, leadB.id)
  assert.equal(msgs.length, 2, 'nudge sent')
  assert.equal(msgs[1].mailbox_id, b.id, 'nudge left from the same mailbox as the intro')
})

// ---- summary ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} cases passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.err}`)
  process.exit(1)
}
