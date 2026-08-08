// The test `campaigns/get-analytics.md` §5 asked for and nobody wrote:
// "a test asserts the campaign endpoint and the Reports aggregate agree".
//
// It would have failed. The campaign header divided replying leads by emails
// sent; Reports divided them by leads contacted. On ten leads and thirty sends
// the same campaign read 13.3% on one screen and 40.0% on the other.
//
// These tests are deliberately written against the *numbers*, not the shapes.
// A shape assertion — "the response has a reply_rate field" — is exactly what
// let this through the first time.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox } from './helpers/parity-harness.js'

setup('metrics')

const { db } = await import('../server/db.js')
const { campaignTotals, rate, ratesFor } = await import('../server/metrics.js')

const owner = seedUser(db, 'owner@metrics.test')
const mailbox = seedMailbox(db, owner.id, 'sender@metrics.test')
const campaign = seedCampaign(db, owner.id, 'Metrics campaign', mailbox.id)

// Ten leads. Three emails each = 30 real sends. Four of them reply.
const leads = []
for (let i = 0; i < 10; i++) {
  const lead = seedLead(db, owner.id, `lead${i}@acme.test`)
  leads.push(lead)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, ?, ?)')
    .run(campaign.id, lead.id, 'A', 'waiting')
  for (let s = 0; s < 3; s++) {
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, provider_message_id, send_status)
       VALUES (?, ?, ?, ?, 'out', 'Hello', 'Body', ?, 'sent')`
    ).run(owner.id, campaign.id, lead.id, mailbox.id, `m-${i}-${s}`)
  }
}
for (let i = 0; i < 4; i++) {
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, intent)
     VALUES (?, ?, ?, ?, 'in', 'Re: Hello', 'Sounds good', 'interested')`
  ).run(owner.id, campaign.id, leads[i].id, mailbox.id)
  db.prepare("UPDATE campaign_leads SET intent = 'interested' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, leads[i].id)
}

test('reply rate is per lead contacted, and says so in its own denominator', () => {
  const t = campaignTotals(campaign.id)
  assert.equal(t.sent, 30, 'thirty real sends')
  assert.equal(t.contacted, 10, 'ten distinct people')
  assert.equal(t.repliedLeads, 4)

  const r = t.rates.reply_rate
  assert.equal(r.denominator, 10, 'per lead contacted, not per email sent')
  assert.equal(r.numerator, 4)
  assert.equal(r.value, 40)
})

test('open and click rates are per email sent — a different denominator, deliberately', () => {
  const t = campaignTotals(campaign.id)
  assert.equal(t.rates.open_rate.denominator, 30)
  assert.equal(t.rates.click_rate.denominator, 30)
  // The distinction is the whole reason the two screens diverged. If someone
  // "helpfully" unifies these onto one denominator, this fails loudly.
  assert.notEqual(t.rates.reply_rate.denominator, t.rates.open_rate.denominator)
})

test('a test send moves no campaign figure', () => {
  const before = campaignTotals(campaign.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, provider_message_id, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Test', 'Body', 'test-1', 'test')`
  ).run(owner.id, campaign.id, leads[0].id, mailbox.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, provider_message_id, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Fwd', 'Body', 'fwd-1', 'forward')`
  ).run(owner.id, campaign.id, leads[0].id, mailbox.id)

  const after = campaignTotals(campaign.id)
  assert.equal(after.sent, before.sent, 'a test send is not outreach')
  assert.equal(after.rates.reply_rate.value, before.rates.reply_rate.value)
  assert.equal(after.rates.open_rate.value, before.rates.open_rate.value)
})

test('an empty denominator is 0 — never NaN, never Infinity, never null', () => {
  const empty = seedCampaign(db, owner.id, 'Never sent anything')
  const t = campaignTotals(empty.id)
  for (const [name, r] of Object.entries(t.rates)) {
    assert.equal(r.denominator, 0, `${name} has nothing to divide by`)
    assert.equal(r.value, 0, `${name} is 0`)
    assert.ok(Number.isFinite(r.value), `${name} is a real number`)
  }
})

test('a window applies to every figure, or the rate exceeds 100%', () => {
  // The old implementation windowed sends but not bounces, so a short window
  // compared this week's sends against all-time bounces.
  const wide = campaignTotals(campaign.id, { from: '2000-01-01 00:00:00', to: '2099-01-01 00:00:00' })
  assert.equal(wide.sent, 30)

  const none = campaignTotals(campaign.id, { from: '2000-01-01 00:00:00', to: '2000-01-02 00:00:00' })
  assert.equal(none.sent, 0, 'no sends in that window')
  assert.equal(none.bouncedLeads, 0, 'and no outcomes leaking in from outside it')
  for (const r of Object.values(none.rates)) assert.ok(r.value <= 100)
})

test('rate() reports its working so a figure on screen can be traced', () => {
  const r = rate(3, 8)
  assert.deepEqual(r, { value: 37.5, numerator: 3, denominator: 8 })
})

test('ratesFor covers every rate the product shows, so none is defined twice', () => {
  const names = Object.keys(ratesFor({}))
  for (const expected of [
    'open_rate', 'click_rate', 'bounce_share',
    'reply_rate', 'positive_reply_rate', 'win_rate', 'unsubscribe_rate', 'bounce_rate',
  ]) {
    assert.ok(names.includes(expected), `${expected} is defined here`)
  }
})

test('every send_status any module writes is classified — outreach or not', async () => {
  // The `'forward'` vs `'forwarded'` mismatch cost every forward a place in
  // `sent` and halved the open/click denominators, and nothing caught it
  // because both spellings look right in isolation. This reads the literals
  // the code actually writes and insists each one has been decided about.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { NOT_OUTREACH } = await import('../server/metrics.js')

  const OUTREACH = ['sent', 'sending', 'queued', 'bounced', 'scheduled', '']
  const known = new Set([...NOT_OUTREACH, ...OUTREACH])

  const dirs = [path.join(process.cwd(), 'server'), path.join(process.cwd(), 'server', 'parity')]
  const found = new Map()
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8')
      // `send_status = 'x'`, `send_status: 'x'`, and the bare literal in a
      // VALUES tuple next to a send_status column are all how these are written.
      for (const m of src.matchAll(/send_status\s*(?:=|:)\s*'([a-z_]*)'/g)) {
        if (!found.has(m[1])) found.set(m[1], `${file}`)
      }
    }
  }

  const unclassified = [...found].filter(([status]) => !known.has(status))
  assert.deepEqual(
    unclassified, [],
    `unclassified send_status literals — add each to NOT_OUTREACH or OUTREACH: ${JSON.stringify(unclassified)}`
  )
})

test('a forward does not inflate sent, or halve the open denominator', () => {
  const mb = seedMailbox(db, owner.id, 'fwd@example.com')
  const c = seedCampaign(db, owner.id, 'Forward campaign', mb.id)
  const lead = seedLead(db, owner.id, 'fwd-target@acme.test')
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, provider_message_id, send_status, opened_at)
     VALUES (?, ?, ?, ?, 'out', 'Real', 'B', 'real-1', 'sent', datetime('now'))`
  ).run(owner.id, c.id, lead.id, mb.id)

  const before = campaignTotals(c.id)
  assert.equal(before.sent, 1)
  assert.equal(before.rates.open_rate.value, 100)

  // Exactly what the forward route writes.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, provider_message_id, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Fwd: Real', 'B', 'fwd-1', 'forwarded')`
  ).run(owner.id, c.id, lead.id, mb.id)

  const after = campaignTotals(c.id)
  assert.equal(after.sent, 1, 'a forward is not outreach')
  assert.equal(after.rates.open_rate.value, 100, 'and does not dilute the denominator')
})
