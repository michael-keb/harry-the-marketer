// A reply must thread in the recipient's mail client, and it must not carry a
// bulk-mail opt-out footer. Both are the transport's job: In-Reply-To and
// References from stored RFC Message-IDs; the footer and List-Unsubscribe
// dropped once the person has written back.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign } from './helpers/parity-harness.js'

setup('threading')
const { db } = await import('../server/db.js')
const { sendEmail, simulateReply } = await import('../server/mailer.js')

const owner = seedUser(db, 'owner@example.com')
const user = { id: owner.id }

db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, refresh_token)
   VALUES (?, 'gmail', 'sender@example.com', 'Sender', 'connected', 50, 'rt')`
).run(owner.id)
const mailbox = () => db.prepare("SELECT * FROM mailboxes WHERE email = 'sender@example.com'").get()

const lead = seedLead(db, owner.id, 'them@acme.test')
const seeded = seedCampaign(db, owner.id, 'Thread test', mailbox().id)
const campaign = () => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(seeded.id)
db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, 'active', '')").run(seeded.id, lead.id)

// The transport, captured. Token refresh and messages/send are the only two
// calls gmailSend makes.
const sent = []
globalThis.fetch = async (url, options = {}) => {
  const u = String(url)
  if (u.includes('oauth2')) {
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' }
  }
  if (u.endsWith('/messages/send')) {
    const { raw } = JSON.parse(options.body)
    const mime = Buffer.from(raw, 'base64url').toString('utf8')
    const [headers, ...rest] = mime.split('\r\n\r\n')
    sent.push({ headers, body: rest.join('\r\n\r\n') })
    return { ok: true, json: async () => ({ id: `g${sent.length}`, threadId: 'thr-1' }), text: async () => '' }
  }
  throw new Error(`unexpected fetch ${u}`)
}

test('a first touch carries the opt-out footer, List-Unsubscribe, and its own Message-ID', async () => {
  await sendEmail({ mailbox: mailbox(), user, campaign: campaign(), lead, nodeId: 'A', subject: 'Hello there', body: 'First note.' })
  const m = sent[0]
  assert.match(m.headers, /^Message-ID: <htm-[a-z0-9]+@example\.com>$/mi)
  assert.match(m.headers, /^List-Unsubscribe: </mi)
  assert.doesNotMatch(m.headers, /^In-Reply-To:/mi)
  assert.match(m.body, /Unsubscribe here:/)
  const row = db.prepare("SELECT rfc_message_id FROM messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1").get()
  assert.match(row.rfc_message_id, /^<htm-[a-z0-9]+@example\.com>$/)
})

test('a reply after they wrote back threads on their Message-ID and drops the footer', async () => {
  const first = db.prepare("SELECT rfc_message_id, thread_id FROM messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1").get()
  db.prepare('UPDATE campaign_leads SET thread_id = ? WHERE campaign_id = ? AND lead_id = ?').run(first.thread_id, seeded.id, lead.id)
  // Their reply, as inbound sync stores it.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id, rfc_message_id)
     VALUES (?, ?, ?, ?, 'in', 'Re: Hello there', 'What exactly do you do?', 'them@acme.test', 'sender@example.com', 'g-in-1', ?, '<abc123@acme.test>')`
  ).run(owner.id, seeded.id, lead.id, mailbox().id, first.thread_id)

  await sendEmail({ mailbox: mailbox(), user, campaign: campaign(), lead, nodeId: 'Q', subject: 'Re: Hello there', body: 'We do X.' })
  const m = sent[1]
  assert.match(m.headers, /^In-Reply-To: <abc123@acme\.test>$/mi, 'replies to the newest message, theirs')
  const refs = m.headers.match(/^References: (.+)$/mi)[1]
  assert.ok(refs.includes(first.rfc_message_id), 'cites our first email')
  assert.ok(refs.includes('<abc123@acme.test>'), 'and their reply')
  assert.doesNotMatch(m.headers, /^List-Unsubscribe/mi, 'no bulk-mail header on correspondence')
  assert.doesNotMatch(m.body, /Unsubscribe here:/, 'no opt-out footer on correspondence')
  assert.doesNotMatch(m.body, /\/t\/u\//, 'no unsubscribe link in the HTML part either')
})

test('a simulated reply is stored with an RFC Message-ID so later sends can cite it', () => {
  const sbLead = seedLead(db, owner.id, 'sandbox@acme.test')
  db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', 'sb@sandbox.local', 'SB')").run(owner.id)
  const sb = db.prepare("SELECT id FROM mailboxes WHERE email = 'sb@sandbox.local'").get()
  db.prepare("UPDATE campaigns SET mailbox_id = ? WHERE id = ?").run(sb.id, seeded.id)
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, 'waiting', 'sbx-thr-x')").run(seeded.id, sbLead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
     VALUES (?, ?, ?, ?, 'out', 'Hi', 'hi', 'sb@sandbox.local', 'sandbox@acme.test', 'sbx-msg-x', 'sbx-thr-x')`
  ).run(owner.id, seeded.id, sbLead.id, sb.id)
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(seeded.id, sbLead.id)
  simulateReply({ user: owner, campaignLead: cl, text: 'Sounds good' })
  const row = db.prepare("SELECT rfc_message_id FROM messages WHERE lead_id = ? AND direction = 'in'").get(sbLead.id)
  assert.match(row.rfc_message_id, /^<sbx-[a-f0-9]+@sandbox\.local>$/)
})
