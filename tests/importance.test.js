// Automatic importance: the half of the Important folder that did not exist.
//
// `importance_score` and `importance_reasons` appeared nowhere in the codebase.
// Starring worked, so the folder worked — but only as a manual bookmark, which
// meant a CTO writing "budget approved, send the contract" and an out-of-office
// notice arrived looking identical, which is the exact problem the spec opens
// with.
//
// Two of these tests exist because the spec asks for them by name and they are
// the ones a scorer usually fails: a manual star must survive a re-score, and
// scoring must work with no API key. The rest guard the rule that makes the
// feature trustworthy — unknown data lowers confidence rather than raising it.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-important-'))
// Off, deliberately: the spec requires a score with reasons on the no-API-key
// path, so every assertion below is made with no model available at all.
process.env.AI_MODE = 'off'
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY

const { db } = await import('../server/db.js')
const { scoreReply, applyScore, IMPORTANT_AT } = await import('../server/importance.js')

// ---- the scorer, read directly ---------------------------------------------

test('a decision-maker title and a buying signal together clear the bar', () => {
  const { score, reasons } = scoreReply({
    lead: { title: 'Chief Technology Officer', company: 'Acme' },
    body: 'Budget is approved — can you send the contract this week?',
  })
  assert.ok(score >= IMPORTANT_AT, `${score} clears ${IMPORTANT_AT}`)
  assert.ok(reasons.includes('Decision-maker title'))
  assert.ok(reasons.some((r) => /budget/i.test(r)), 'and says why in words')
})

test('every score comes with reasons — never a bare number', () => {
  // The rule the spec states outright. A score with no explanation is an
  // instruction to trust something nobody can inspect.
  for (const body of [
    'Budget approved, send the contract.',
    'Can you send me a proposal?',
    'What does it cost?',
    'Please book a call for next week.',
  ]) {
    const { score, reasons } = scoreReply({ lead: { title: 'Head of Growth' }, body })
    assert.ok(score > 0, `${body} scored`)
    assert.ok(reasons.length > 0, `${body} explains itself`)
    for (const r of reasons) {
      assert.equal(typeof r, 'string')
      assert.ok(!/^\d+$/.test(r), 'a reason is words, not a number')
    }
  }
})

test('a title alone is interesting but not important', () => {
  // Seniority makes a reply worth reading sooner. It is not on its own a reason
  // to interrupt someone — if it were, the folder would fill with pleasantries
  // from senior people and stop being a queue.
  const { score, reasons } = scoreReply({
    lead: { title: 'VP of Engineering' },
    body: 'Thanks for the note.',
  })
  assert.ok(score > 0, 'it counts for something')
  assert.ok(score < IMPORTANT_AT, 'but does not clear the bar by itself')
  assert.deepEqual(reasons, ['Decision-maker title'])
})

test('no title and neutral wording invents nothing', () => {
  // TC-10, and the rule behind it: unknown data lowers confidence rather than
  // raising a score. A system that rewarded incomplete records would quietly
  // promote every lead nobody had finished researching.
  const { score, reasons } = scoreReply({ lead: {}, body: 'Thanks, I will take a look.' })
  assert.equal(score, 0)
  assert.deepEqual(reasons, [], 'and no reason is fabricated')
})

test('a title that merely contains a keyword does not count', () => {
  // Word boundaries matter: "Overhead Analyst" is not a Head of anything.
  const { reasons } = scoreReply({ lead: { title: 'Overhead Cost Analyst' }, body: 'Hello' })
  assert.deepEqual(reasons, [])
})

test('an out-of-office scores nothing however senior the sender', () => {
  // This is the noise the folder exists to keep out. A CEO's auto-responder is
  // still an auto-responder.
  const { score, reasons } = scoreReply({
    lead: { title: 'CEO' },
    body: 'I am out of the office until Monday with limited access to email.',
    intent: 'out of office',
  })
  assert.equal(score, 0)
  assert.deepEqual(reasons, [])
})

test('an unsubscribe is never important', () => {
  const { score } = scoreReply({ lead: { title: 'Founder' }, body: 'Remove me.', intent: 'unsubscribe' })
  assert.equal(score, 0)
})

test('reasons stay readable — a reply tripping many patterns does not list them all', () => {
  const { reasons } = scoreReply({
    lead: { title: 'CEO' },
    body: 'Budget is approved, send me a proposal, what does it cost, when can we start, book a call, urgent',
    intent: 'interested',
  })
  assert.ok(reasons.length <= 5, `${reasons.length} reasons is still readable`)
})

test('the score is bounded, so nothing sorts above everything for ever', () => {
  const { score } = scoreReply({
    lead: { title: 'Chief Executive Officer' },
    body: 'Budget approved. Send the contract. When can we start? Urgent. Book a call.',
    intent: 'interested',
  })
  assert.ok(score <= 100, `${score} is within range`)
})

// ---- persistence and the human override ------------------------------------

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:imp@x.com', 'imp@x.com', 'Owner')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'me@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id) VALUES (1, 'C', 'running', 1)").run()

let seq = 0
function inbound(body, { title = '', importantBy = '', isImportant = 0 } = {}) {
  seq += 1
  db.prepare('INSERT INTO leads (user_id, email, title) VALUES (1, ?, ?)').run(`i${seq}@acme.test`, title)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(`i${seq}@acme.test`).id
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, is_important, important_by)
     VALUES (1, 1, ?, 1, 'in', 'Re: hello', ?, ?, ?)`
  ).run(leadId, body, isImportant, importantBy)
  const id = db.prepare('SELECT MAX(id) id FROM messages').get().id
  return { id, leadId, row: db.prepare('SELECT * FROM messages WHERE id = ?').get(id) }
}

const stored = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

test('scoring a message stores the score and its reasons, and stars it', () => {
  const { id, row, leadId } = inbound('Budget approved — please send the contract.', { title: 'CTO' })
  applyScore(db, row, { lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) })

  const after = stored(id)
  assert.ok(after.importance_score >= IMPORTANT_AT)
  assert.equal(after.is_important, 1, 'starred without anyone asking')
  const reasons = JSON.parse(after.importance_reasons)
  assert.ok(reasons.length > 0)
  assert.ok(reasons.includes('Decision-maker title'))
})

test('a manual star survives a subsequent automatic re-score', () => {
  // Named in the spec's definition of done. Someone starred a dull-looking
  // reply because they know something the scorer does not; a re-score on the
  // next tick must not overrule them.
  const { id, row } = inbound('Thanks, noted.', { importantBy: 'someone@ours.test', isImportant: 1 })
  applyScore(db, row, { lead: {} })

  const after = stored(id)
  assert.equal(after.is_important, 1, 'still starred')
  assert.equal(after.importance_score, 0, 'even though it scores nothing on its own')
  assert.equal(after.important_by, 'someone@ours.test', 'and the person keeps the credit')
})

test('a manual un-star also survives a re-score', () => {
  // The mirror image, and the same insult: re-starring something a person
  // deliberately cleared is a machine overruling a human on a timer.
  const { id, row } = inbound('Budget approved — send the contract.', {
    title: 'CEO', importantBy: 'someone@ours.test', isImportant: 0,
  })
  applyScore(db, row, { lead: { title: 'CEO' } })

  const after = stored(id)
  assert.equal(after.is_important, 0, 'stayed un-starred')
  assert.ok(after.importance_score >= IMPORTANT_AT, 'while still recording what it thinks')
})

test('scoring works with no API key configured', () => {
  // The other DoD item stated by name. Asserting the environment has no key is
  // not the way to prove it — `server/env.js` loads a .env on import, so the
  // test cannot control that and would only be measuring the machine it ran on.
  //
  // The property that actually matters is that scoring cannot reach a model at
  // all: `scoreReply` is synchronous, so there is no await for a network call
  // to hide behind, and it returns a finished answer rather than a promise.
  const result = scoreReply({ lead: { title: 'Founder' }, body: 'Send me a proposal — budget is approved.' })
  assert.ok(!(result instanceof Promise), 'synchronous, so nothing is being fetched')
  assert.ok(result.score > 0)
  assert.ok(result.reasons.length > 0, 'with reasons, not just a number')

  // And the same through the storage path, with AI switched off.
  assert.equal(process.env.AI_MODE, 'off')
  const { id, row, leadId } = inbound('Can you send me a proposal? Budget is approved.', { title: 'Founder' })
  applyScore(db, row, { lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) })

  const after = stored(id)
  assert.ok(after.importance_score > 0)
  assert.ok(JSON.parse(after.importance_reasons).length > 0)
})

test('scoring the same reply twice gives the same answer', () => {
  const a = scoreReply({ lead: { title: 'Director' }, body: 'What does it cost?' })
  const b = scoreReply({ lead: { title: 'Director' }, body: 'What does it cost?' })
  assert.deepEqual(a, b, 'deterministic, so it can be reasoned about and tested')
})
