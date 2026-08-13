// Derived prospect stages, the signed agreement, follow-up timing, alert
// webhook detection, and the guided briefing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-progress-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { leadStages, lastInbounds, messageSnippet } = await import('../server/stages.js')
const { ensureConsent, ownerTerms, consentFor } = await import('../server/consent.js')
const { followUpTiming } = await import('../server/engine.js')
const { webhookKind, isSupportedWebhook } = await import('../server/alerts.js')
const { composeBusinessContext, profileGaps } = await import('../shared/profile.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:o@x.com', 'o@x.com', 'Owner')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'me@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'C', 'draft', 1, '')").run()
const addLead = db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)')
for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com']) addLead.run(email)
const out = db.prepare(
  "INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body) VALUES (1, 1, ?, 'out', 's', 'b')"
)
const inbound = db.prepare(
  "INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, intent) VALUES (1, 1, ?, 'in', 's', 'b', ?)"
)

test('a prospect stage is read off what actually happened', () => {
  out.run(2)                       // b: contacted
  out.run(3); inbound.run(3, '')   // c: replied
  out.run(4); inbound.run(4, 'interested') // d: interested
  out.run(5); inbound.run(5, 'interested') // e: interested, then signs
  db.prepare("INSERT INTO consents (user_id, lead_id, token, status, signed_name) VALUES (1, 5, 'tok-e', 'signed', 'Erin')").run()
  out.run(6)
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, outcome) VALUES (1, 6, 'finished', 'won')").run()

  const stages = leadStages(1)
  assert.equal(stages[1], 'not contacted')
  assert.equal(stages[2], 'contacted')
  assert.equal(stages[3], 'replied')
  assert.equal(stages[4], 'interested')
  assert.equal(stages[5], 'agreed')
  assert.equal(stages[6], 'won')
})

test('the last inbound is the card the board reads', () => {
  assert.equal(messageSnippet('  hello\n\nworld  '), 'hello world')
  assert.equal(messageSnippet('x'.repeat(200)).endsWith('…'), true)

  const map = lastInbounds(1)
  assert.equal(map[1], undefined, 'never replied')
  assert.equal(map[3].intent, '')
  assert.equal(map[3].snippet, 'b')
  assert.equal(map[4].intent, 'interested')
  // A newer inbound replaces the older one — the board always shows the latest tag.
  inbound.run(3, 'question')
  assert.equal(lastInbounds(1)[3].intent, 'question')
})

test('opting out ends the journey wherever it got to', () => {
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = 4").run()
  assert.equal(leadStages(1)[4], 'unsubscribed')
  db.prepare("UPDATE leads SET status = 'active' WHERE id = 4").run()
})

test('a win in one campaign outranks a loss in another', () => {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'C2', 'draft', 1, '')").run()
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, outcome) VALUES (2, 6, 'finished', 'lost')").run()
  assert.equal(leadStages(1)[6], 'won')
})

test('the agreement names the sender and says how to back out', () => {
  const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()
  const terms = ownerTerms(owner)
  assert.match(terms, /Owner/)
  assert.match(terms, /change your mind/i)
})

test('issuing an agreement link twice reuses the same link', () => {
  const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()
  const first = ensureConsent({ owner, leadId: 1, campaignId: 1 })
  const second = ensureConsent({ owner, leadId: 1, campaignId: 1 })
  assert.equal(first.token, second.token)
  assert.equal(consentFor(1, 1).status, 'sent')
})

test('custom agreement wording wins over the default', () => {
  db.prepare("UPDATE users SET consent_terms = 'Only my words.' WHERE id = 1").run()
  const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()
  assert.equal(ownerTerms(owner), 'Only my words.')
})

test('follow-up timing reacts to what the lead did, within bounds', () => {
  assert.equal(followUpTiming({ lastOutbound: { clicked_at: 'now' } }).factor, 0.5)
  assert.ok(followUpTiming({ lastOutbound: { opened_at: 'now' } }).factor < 1)
  assert.equal(followUpTiming({ intent: 'out of office' }).factor, 2)
  assert.ok(followUpTiming({ intent: 'not now' }).factor > 1)
  // No open recorded and no proof open tracking works anywhere: change nothing.
  const blind = followUpTiming({ lastOutbound: { opened_at: '' }, openTrackingWorks: false })
  assert.equal(blind.factor, 1)
  assert.equal(blind.reason, '')
  assert.ok(followUpTiming({ lastOutbound: { opened_at: '' }, openTrackingWorks: true }).factor > 1)
  // Every adjustment explains itself in the activity trail.
  assert.ok(followUpTiming({ lastOutbound: { clicked_at: 'now' } }).reason)
})

test('a webhook URL identifies its own service', () => {
  assert.equal(webhookKind('https://hooks.slack.com/services/T/B/x'), 'slack')
  assert.equal(webhookKind('https://acme.webhook.office.com/webhookb2/abc'), 'teams')
  assert.equal(webhookKind('https://prod-1.westus.logic.azure.com/workflows/x'), 'teams')
  assert.equal(webhookKind('http://hooks.slack.com/services/T/B/x'), null, 'https only')
  assert.equal(isSupportedWebhook('https://example.com/anything'), false)
})

test('the guided answers become the briefing the agent reads', () => {
  const composed = composeBusinessContext({ who: 'Sam, ops lead', offer: 'A short assessment', voice: 'warm' })
  assert.match(composed, /Who is asking: Sam, ops lead/)
  assert.match(composed, /What you are asking for: A short assessment/)
  assert.match(composed, /Voice: Warm/i)
  assert.equal(composeBusinessContext({}), '', 'an empty profile never overwrites a hand-written briefing')
  assert.ok(profileGaps({ who: 'Sam' }).length > 0)
})
