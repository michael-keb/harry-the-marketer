// Which lead a reply belongs to is decided by the provider thread, not by the
// From address. Matching on the address first sent a reply to whichever lead
// owned that address and to whatever campaign that lead sat in — so the lead
// actually written to never saw the answer. Reproduced live: a campaign wrote
// to `hello+haircut@…`, the reply arrived from `hello@…`, and it was filed
// against a different lead in a different campaign.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-replymatch-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { ingestRecentInbound } = await import('../server/upkeep.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:rm@x.com', 'rm@x.com', 'Owner')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name, status) VALUES (1, 'gmail', 'sender@x.com', 'S', 'connected')").run()
const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = 1').get()

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> W([Won])
  A -- no reply 3d --> L([Lost])
`
function campaign(name) {
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, ?, 'running', 1, ?)").run(name, PLAYBOOK)
  return db.prepare('SELECT * FROM campaigns WHERE name = ?').get(name)
}
function lead(email) {
  db.prepare("INSERT INTO leads (user_id, email, status) VALUES (1, ?, 'active')").run(email)
  return db.prepare('SELECT * FROM leads WHERE email = ?').get(email)
}

// The decoy: the base address, enrolled in an older campaign. Address matching
// picks this one; the thread says otherwise.
const other = campaign('Older campaign')
const baseLead = lead('hello@co.test')
db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, 'waiting', 'thread-OLD')").run(other.id, baseLead.id)

// The campaign that actually wrote, to the plus-alias, on thread-NEW.
const live = campaign('Live campaign')
const aliasLead = lead('hello+haircut@co.test')
db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, 'waiting', 'thread-NEW')").run(live.id, aliasLead.id)
db.prepare(
  "INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, thread_id) VALUES (1, ?, ?, 1, 'out', 'Intro', 'b', 'hello+haircut@co.test', 'out-1', 'thread-NEW')"
).run(live.id, aliasLead.id)

test('a reply from the base address is filed against the lead that owns the thread', () => {
  const outcome = ingestRecentInbound(mailbox, {
    providerMessageId: 'in-1',
    threadId: 'thread-NEW',
    fromEmail: 'hello@co.test', // the alias is only on the To side
    subject: 'Re: Intro',
    body: 'Sounds good, tell me more',
  })
  assert.equal(outcome, 'attached')
  const row = db.prepare("SELECT * FROM messages WHERE provider_message_id = 'in-1'").get()
  assert.equal(row.lead_id, aliasLead.id, 'filed against the lead that was written to')
  assert.equal(row.campaign_id, live.id, 'and against the campaign that wrote')
})

test('a reply on an unknown thread still falls back to the From address', () => {
  const outcome = ingestRecentInbound(mailbox, {
    providerMessageId: 'in-2',
    threadId: 'thread-OLD',
    fromEmail: 'hello@co.test',
    subject: 'Re: something',
    body: 'hello there',
  })
  assert.equal(outcome, 'attached')
  const row = db.prepare("SELECT * FROM messages WHERE provider_message_id = 'in-2'").get()
  assert.equal(row.lead_id, baseLead.id)
  assert.equal(row.campaign_id, other.id)
})

test('the thread wins even when the From address matches no lead at all', () => {
  const outcome = ingestRecentInbound(mailbox, {
    providerMessageId: 'in-3',
    threadId: 'thread-NEW',
    fromEmail: 'assistant@somewhere-else.test', // an assistant answering on their behalf
    subject: 'Re: Intro',
    body: 'Michael asked me to reply — yes please',
  })
  assert.equal(outcome, 'attached')
  const row = db.prepare("SELECT * FROM messages WHERE provider_message_id = 'in-3'").get()
  assert.equal(row.lead_id, aliasLead.id)
  assert.equal(row.campaign_id, live.id)
})
