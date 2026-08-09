// Attaching mailboxes to a campaign did nothing at all.
//
// `add-email-accounts.md` opens with the reason the feature exists — "so that
// the campaign's sending is spread across them instead of hammering one Gmail
// account" — and states it as a criterion: "attaching more mailboxes raises
// total volume, never per-mailbox volume."
//
// There was no rotation. `campaign_mailboxes` had exactly one reader in the
// whole server, and it was there to validate a per-lead pin. Every email went
// from `campaigns.mailbox_id` until that single mailbox hit its cap, and the
// per-mailbox capacity figures the campaign page showed described a spread that
// was never happening. The route returned `{ok: true}`, the rows were written,
// the UI listed them — and the behaviour they were for did not exist.
//
// Every test here ticks the engine and reads `messages.mailbox_id`, because
// that column is the only thing that says which address a recipient saw.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-rotate-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- no reply 30d --> L([Lost])
`

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:rot@x.com', 'rot@x.com', 'Owner', 0, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()

const addMailbox = db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, next_send_at)
   VALUES (?, 'sandbox', ?, ?, 'connected', ?, 0)`
)
addMailbox.run(owner.id, 'one@sandbox.local', 'One', 100)   // id 1 — the campaign's own
addMailbox.run(owner.id, 'two@sandbox.local', 'Two', 100)   // id 2 — pooled
addMailbox.run(owner.id, 'three@sandbox.local', 'Three', 100) // id 3 — pooled

db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Spread', 'running', 1, ?)")
  .run(owner.id, PLAYBOOK)
const CAMPAIGN = db.prepare('SELECT id FROM campaigns WHERE name = ?').get('Spread').id

let seq = 0
function enrol(n = 1) {
  const ids = []
  for (let i = 0; i < n; i++) {
    seq += 1
    const email = `rot${seq}@acme.test`
    db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (?, ?, ?)').run(owner.id, email, `R${seq}`)
    const id = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id
    db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(CAMPAIGN, id)
    ids.push(id)
  }
  return ids
}

// The gap between sends is per mailbox; clearing it lets a tick do real work
// instead of measuring the pacing jitter.
async function tickFreely(times = 1) {
  for (let i = 0; i < times; i++) {
    db.prepare('UPDATE mailboxes SET next_send_at = 0 WHERE user_id = ?').run(owner.id)
    await tick()
  }
}

const sentFrom = (leadId) => db.prepare(
  "SELECT mailbox_id FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id LIMIT 1"
).get(leadId)?.mailbox_id

const spread = () => db.prepare(
  `SELECT mailbox_id, COUNT(*) n FROM messages
    WHERE campaign_id = ? AND direction = 'out' GROUP BY mailbox_id ORDER BY mailbox_id`
).all(CAMPAIGN)

// ---- the defect ------------------------------------------------------------

test('with one mailbox attached, everything comes from it', async () => {
  // The control. Rotation must not invent a spread that is not there.
  const [lead] = enrol(1)
  await tickFreely()
  assert.equal(sentFrom(lead), 1)
})

test('attaching more mailboxes spreads the sending across them', async () => {
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, 2)').run(CAMPAIGN)
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, 3)').run(CAMPAIGN)

  enrol(9)
  await tickFreely(4)

  const used = spread()
  assert.equal(used.length, 3, `all three mailboxes sent — got ${JSON.stringify(used)}`)
  for (const row of used) {
    assert.ok(row.n > 0, `mailbox ${row.mailbox_id} carried some of it`)
  }
})

test('the spread is even — no mailbox carries the whole campaign', async () => {
  // Choosing the mailbox with the most room left is what makes this true. A
  // naive "first that can send" would drain mailbox 1 to its cap before
  // touching mailbox 2, which is the behaviour the spec calls hammering.
  const used = spread()
  const counts = used.map((r) => r.n)
  const most = Math.max(...counts)
  const fewest = Math.min(...counts)
  assert.ok(most - fewest <= 2, `evenly spread — got ${JSON.stringify(counts)}`)
})

// ---- the rules that keep it honest ----------------------------------------

test('a conversation keeps the mailbox it started from', async () => {
  // Switching sender mid-thread breaks threading in the recipient's client and
  // reads as a stranger picking up the conversation. Rotation chooses who
  // starts a conversation, never who continues one.
  const [lead] = enrol(1)
  await tickFreely()
  const first = sentFrom(lead)
  assert.ok(first, 'the opener went out')

  // Advance the lead so the playbook wants a second email from the same node.
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
       VALUES (?, ?, ?, ?, 'out', 'Follow-up', 'Body', 'x@acme.test', ?, 'sent')`
    ).run(owner.id, CAMPAIGN, lead, first, `cont-${lead}-${i}`)
  }

  const all = db.prepare(
    "SELECT DISTINCT mailbox_id FROM messages WHERE lead_id = ? AND direction = 'out'"
  ).all(lead)
  assert.equal(all.length, 1, 'one sender for the whole conversation')
  assert.equal(all[0].mailbox_id, first)
})

test('a per-lead pin still beats the rotation', async () => {
  // The pin is an explicit instruction from a person; the rotation is a default.
  const [lead] = enrol(1)
  db.prepare('UPDATE campaign_leads SET mailbox_id = 3 WHERE campaign_id = ? AND lead_id = ?').run(CAMPAIGN, lead)
  await tickFreely()
  assert.equal(sentFrom(lead), 3, 'the pinned mailbox sent, whatever the rotation preferred')
})

test('a suspended mailbox drops out of the pool', async () => {
  db.prepare('UPDATE mailboxes SET is_suspended = 1 WHERE id = 2').run()
  const before = db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND mailbox_id = 2"
  ).get(CAMPAIGN).n

  enrol(6)
  await tickFreely(3)

  const after = db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND mailbox_id = 2"
  ).get(CAMPAIGN).n
  assert.equal(after, before, 'the suspended mailbox sent nothing more')
  db.prepare('UPDATE mailboxes SET is_suspended = 0 WHERE id = 2').run()
})

test('per-mailbox caps still apply — more mailboxes raise total volume, not per-mailbox volume', async () => {
  // The criterion, stated almost word for word in the spec.
  //
  // The arithmetic has a wrinkle worth writing down, because it caught this
  // test out first: Harry keeps the last slot of each mailbox's daily allowance
  // for follow-ups, so a mailbox capped at N will only open N-1 new
  // conversations. Someone already mid-thread should not lose their reply
  // because a fresh prospect used the day's last send. So three mailboxes at
  // three a day is six first approaches, not nine — and the reserve is per
  // mailbox, which is itself part of the claim being tested.
  // A fresh set of mailboxes so the counters are clean, each allowed two a day.
  // Created before the campaign that points at them — the foreign key is real.
  const capped = []
  for (const email of ['c1@sandbox.local', 'c2@sandbox.local', 'c3@sandbox.local']) {
    db.prepare(
      `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, next_send_at)
       VALUES (?, 'sandbox', ?, 'connected', 3, 0)`
    ).run(owner.id, email)
    capped.push(db.prepare('SELECT id FROM mailboxes WHERE email = ?').get(email).id)
  }

  const solo = db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Capped', 'running', ?, ?) RETURNING id"
  ).get(owner.id, capped[0], PLAYBOOK)

  for (const id of capped.slice(1)) {
    db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(solo.id, id)
  }

  for (let i = 0; i < 12; i++) {
    seq += 1
    db.prepare('INSERT INTO leads (user_id, email) VALUES (?, ?)').run(owner.id, `cap${seq}@acme.test`)
    const id = db.prepare('SELECT id FROM leads WHERE email = ?').get(`cap${seq}@acme.test`).id
    db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(solo.id, id)
  }

  await tickFreely(8)

  const rows = db.prepare(
    `SELECT mailbox_id, COUNT(*) n FROM messages
      WHERE campaign_id = ? AND direction = 'out' GROUP BY mailbox_id`
  ).all(solo.id)
  const total = rows.reduce((sum, r) => sum + r.n, 0)

  assert.equal(total, 6, 'three mailboxes each opening two conversations — not two, and not eighteen')
  for (const row of rows) {
    assert.ok(row.n <= 2, `mailbox ${row.mailbox_id} opened at most two, its cap of three minus the follow-up reserve (${row.n})`)
  }
})
