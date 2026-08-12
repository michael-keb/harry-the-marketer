// Covers the automated bounce feed (server/mailer.js classifyBounce / markBounce)
// that the audit flagged as the #1 gap: the deliverability brake keys on
// leads.status='bounced' but nothing set it. These assert a DSN is detected, the
// failed lead + its outbound are marked bounced, and the brake then sees it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-bounce-feed-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'

const { db } = await import('../server/db.js')
const { classifyBounce, markBounce } = await import('../server/mailer.js')
const { bounceStats } = await import('../server/gates.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:o@x.com','o@x.com','O')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1,'gmail','sender@x.com','connected')").run()
const mailbox = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('sender@x.com')

function seedLead(email) {
  db.prepare("INSERT INTO leads (user_id, email, status) VALUES (1, ?, 'active')").run(email)
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(email)
  db.prepare(
    `INSERT INTO messages (user_id, mailbox_id, lead_id, direction, to_email, send_status, provider_message_id)
     VALUES (1, ?, ?, 'out', ?, 'sent', ?)`
  ).run(mailbox.id, lead.id, email, `out-${lead.id}`)
  return lead
}

const HARD_DSN = {
  fromEmail: 'mailer-daemon@googlemail.com',
  subject: 'Delivery Status Notification (Failure)',
  body: [
    'Delivery to the following recipient failed permanently:',
    '     gone@acme.com',
    'Technical details of permanent failure:',
    'Final-Recipient: rfc822; gone@acme.com ',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
  ].join('\n'),
  providerMessageId: 'dsn-hard-1',
  threadId: 'thr-dsn-1',
}

test('classifyBounce detects a DSN and extracts the failed recipient', () => {
  const c = classifyBounce(HARD_DSN)
  assert.ok(c, 'a delivery-failure notice is recognised')
  assert.equal(c.failed, 'gone@acme.com')
})

test('a normal reply is not classified as a bounce', () => {
  assert.equal(
    classifyBounce({ fromEmail: 'lead@acme.com', subject: 'Re: your note', body: 'Sounds good, talk next week.' }),
    null,
  )
})

test('a transient delay from mailer-daemon is NOT a bounce (lead stays reachable)', () => {
  // Gmail's "delivery has been delayed" — 4.x.x, will retry. Must not suppress.
  assert.equal(
    classifyBounce({
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Delay)',
      body: 'Your message has been delayed and delivery will be retried.\nStatus: 4.2.2\nFinal-Recipient: rfc822; busy@acme.com',
    }),
    null,
  )
  // But a message carrying BOTH a transient line and a hard 5.x.x is still a bounce.
  const hard = classifyBounce({
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    body: 'Delivery was delayed, then failed.\nStatus: 5.1.1\nFinal-Recipient: rfc822; gone@acme.com',
  })
  assert.equal(hard?.failed, 'gone@acme.com')
})

test('markBounce suppresses the lead, stamps its outbound, and feeds the brake', () => {
  const lead = seedLead('gone@acme.com')
  assert.equal(bounceStats(mailbox.id, 50).bounced, 0, 'clean before')

  const res = markBounce({ wsId: mailbox.user_id, mailboxId: mailbox.id, failedEmail: 'gone@acme.com' })
  assert.equal(res?.leadId, lead.id)

  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'bounced')
  assert.equal(
    db.prepare("SELECT send_status FROM messages WHERE lead_id = ? AND direction = 'out'").get(lead.id).send_status,
    'bounced',
  )
  assert.ok(bounceStats(mailbox.id, 50).bounced >= 1, 'the brake now sees the bounce')
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'bounced' AND lead_id = ?").get(lead.id).n,
    1,
  )
})

test('markBounce for an unknown recipient does nothing', () => {
  assert.equal(markBounce({ wsId: mailbox.user_id, mailboxId: mailbox.id, failedEmail: 'stranger@nowhere.com' }), null)
})

test('marking the same bounce twice is idempotent and does not re-log', () => {
  const lead = seedLead('twice@acme.com')
  markBounce({ wsId: mailbox.user_id, mailboxId: mailbox.id, failedEmail: 'twice@acme.com' })
  markBounce({ wsId: mailbox.user_id, mailboxId: mailbox.id, failedEmail: 'twice@acme.com' })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'bounced' AND lead_id = ?").get(lead.id).n, 1)
})
