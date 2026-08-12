// Engine helpers for Cedar Pike (skip), Coral Heron (subject), Cobalt Falcon
// (timing freeze), and Teal Lynx (no-reply channel switch notes).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-intents-engine-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { parsePlaybook } = await import('../server/playbook.js')
const { composeEmail } = await import('../server/ai.js')
const {
  nextAfterSkip,
  resolveComposeSubject,
  tick,
  campaignCtx,
  routeReply,
} = await import('../server/engine.js')

test('resolveComposeSubject: example wins over campaign on new threads', () => {
  assert.equal(
    resolveComposeSubject({ exampleSubject: 'From example', campaignSubject: 'From campaign' }),
    'From example',
  )
})

test('resolveComposeSubject: campaign subject when no example', () => {
  assert.equal(
    resolveComposeSubject({ exampleSubject: '', campaignSubject: 'Campaign line' }),
    'Campaign line',
  )
  assert.equal(
    resolveComposeSubject({ campaignSubject: '  trimmed  ' }),
    'trimmed',
  )
})

test('resolveComposeSubject: thread reply keeps Re: logic', () => {
  assert.equal(
    resolveComposeSubject({
      exampleSubject: 'Example',
      campaignSubject: 'Campaign',
      threadSubject: 'Hello',
    }),
    'Re: Hello',
  )
  assert.equal(
    resolveComposeSubject({ threadSubject: 'Re: Hello', campaignSubject: 'Campaign' }),
    'Re: Hello',
  )
})

test('resolveComposeSubject: null when nothing to force', () => {
  assert.equal(resolveComposeSubject({}), null)
  assert.equal(resolveComposeSubject({ exampleSubject: '  ', campaignSubject: '' }), null)
})

test('resolveComposeSubject: default variant after campaign subject', () => {
  assert.equal(
    resolveComposeSubject({ defaultSubject: 'Workspace default' }),
    'Workspace default',
  )
  assert.equal(
    resolveComposeSubject({ campaignSubject: 'Campaign', defaultSubject: 'Workspace default' }),
    'Campaign',
  )
})

test('composeEmail template path uses campaignSubject when AI_MODE=off', async () => {
  const composed = await composeEmail({
    instruction: 'intro our product to {{firstName}}',
    lead: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' },
    businessContext: '',
    thread: [],
    senderName: 'Harry',
    campaignSubject: 'Campaign subject from settings',
  })
  assert.equal(composed.via, 'template')
  assert.equal(composed.subject, 'Campaign subject from settings')
  assert.match(composed.body, /Ada/)
})

test('composeEmail template path: example subject beats campaign', async () => {
  const composed = await composeEmail({
    instruction: 'intro',
    lead: { first_name: 'Ada', email: 'ada@example.test' },
    thread: [],
    senderName: 'Harry',
    example: { subject: 'Approved subject', body: 'Approved body about {{firstName}}' },
    campaignSubject: 'Campaign subject',
  })
  assert.equal(composed.subject, 'Approved subject')
})

test('composeEmail thread reply ignores campaign subject', async () => {
  const composed = await composeEmail({
    instruction: 'follow up',
    lead: { first_name: 'Ada', email: 'ada@example.test' },
    thread: [{ direction: 'out', subject: 'Original', body: 'Hi', created_at: 'earlier' }],
    senderName: 'Harry',
    campaignSubject: 'Campaign subject',
  })
  assert.equal(composed.subject, 'Re: Original')
})

test('nextAfterSkip prefers always, then shortest timeout', () => {
  const withAlways = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send sms: nudge]
    A --> B[Send email: fallback]
  `)
  assert.equal(withAlways.valid, true)
  assert.equal(nextAfterSkip(withAlways, 'A'), 'B')

  const timeouts = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send sms: nudge]
    A -- no reply 5d --> C[Send email: slow]
    A -- no reply 1d --> D[Send email: sooner]
    A -- reply --> W([Won])
  `)
  assert.equal(timeouts.valid, true)
  assert.equal(nextAfterSkip(timeouts, 'A'), 'D')

  const deadEnd = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send sms: nudge]
    A -- reply --> W([Won])
  `)
  assert.equal(deadEnd.valid, true)
  assert.equal(nextAfterSkip(deadEnd, 'A'), null)
})

// --- soft SMS skip advances (Cedar Pike) ---

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:intents@x.com', 'intents@x.com', 'Intents', 0)").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (1, 'sandbox', 'sender@sandbox.local', 'Sandbox')").run()

const SMS_SKIP_PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send sms: Quick nudge]
  A -- no reply 1d --> B[Send email: Email instead]
  B -- no reply 3d --> L([Lost])
  B -- reply --> W([Won])
`

test('soft SMS ineligibility (no phone) skips and advances to email step', async () => {
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, email_subject) VALUES (1, 'Skip SMS', 'running', 1, ?, ?)"
  ).run(SMS_SKIP_PLAYBOOK, 'Fallback campaign subject')
  const campaign = db.prepare("SELECT * FROM campaigns WHERE name = 'Skip SMS'").get()
  db.prepare(
    "INSERT INTO channel_accounts (workspace_id, channel, provider, display_name, phone_number, status, daily_limit) VALUES (1, 'sms', 'sandbox', 'SMS', '+61400000100', 'connected', 50)"
  ).run()
  const account = db.prepare("SELECT id FROM channel_accounts WHERE phone_number = '+61400000100'").get()
  db.prepare(
    'INSERT INTO campaign_channel_accounts (campaign_id, channel_account_id) VALUES (?, ?)'
  ).run(campaign.id, account.id)

  // Lead with email but no phone — SMS soft-skips; email step should send.
  db.prepare("INSERT INTO leads (user_id, email, first_name, phone) VALUES (1, 'nophone@example.test', 'Pat', '')").run()
  const lead = db.prepare("SELECT * FROM leads WHERE email = 'nophone@example.test'").get()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)

  await tick()

  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  const skipped = db.prepare(
    "SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND lead_id = ? AND type = 'step_skipped'"
  ).get(campaign.id, lead.id).n
  assert.ok(skipped >= 1, 'step_skipped logged')
  assert.notEqual(cl.state, 'finished', 'soft skip must not finish the lead')
  assert.equal(cl.node_id, 'B')
  assert.equal(cl.state, 'waiting')

  const out = db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id"
  ).all(campaign.id, lead.id)
  assert.equal(out.length, 1)
  assert.equal(out[0].channel || 'email', 'email')
  assert.equal(out[0].subject, 'Fallback campaign subject')
})

test('timing freeze: wait_until set on first timeout compute and not moved by recomputation', async () => {
  const playbook = `flowchart TD
    S([Start]) --> A[Send: hello]
    A -- no reply 3d --> F[Send: follow up]
    F -- reply --> W([Won])
  `
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Freeze', 'running', 1, ?)"
  ).run(playbook)
  const campaign = db.prepare("SELECT * FROM campaigns WHERE name = 'Freeze'").get()
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'freeze@example.test', 'Fry')").run()
  const lead = db.prepare("SELECT * FROM leads WHERE email = 'freeze@example.test'").get()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)

  await tick() // send + park waiting with empty wait_until
  let cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(cl.state, 'waiting')
  assert.equal(cl.node_id, 'A')

  await tick() // first processWaiting freezes wait_until
  cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.ok(cl.wait_until, 'wait_until frozen')
  const frozen = cl.wait_until
  const untilMs = Date.parse(frozen)
  assert.ok(untilMs > Date.now() + 2 * 86400e3, 'frozen ~3d out')

  // Simulate a mermaid delay edit landing on the campaign — frozen wait must stick.
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(
    playbook.replace('no reply 3d', 'no reply 10d'),
    campaign.id,
  )
  await tick()
  cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(cl.wait_until, frozen)
  assert.equal(cl.node_id, 'A')
})

test('ignoreOOOasReply true keeps waiting; false treats OOO as a reply', async () => {
  const playbook = `flowchart TD
    S([Start]) --> A[Send: hello]
    A -- reply: interested --> W([Won])
    A -- no reply 3d --> L([Lost])
  `
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, settings) VALUES (1, 'OOO ignore', 'running', 1, ?, ?)"
  ).run(playbook, JSON.stringify({ out_of_office_detection_settings: { ignoreOOOasReply: true } }))
  const campaign = db.prepare("SELECT * FROM campaigns WHERE name = 'OOO ignore'").get()
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'ooo@example.test', 'Oz')").run()
  const lead = db.prepare("SELECT * FROM leads WHERE email = 'ooo@example.test'").get()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)

  await tick()
  const clRow = () => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(clRow().state, 'waiting')

  const ctx = campaignCtx(campaign.id)
  await routeReply(ctx, clRow(), 'out of office', null)
  assert.equal(clRow().state, 'waiting', 'ignoreOOOasReply keeps waiting')
  assert.equal(clRow().intent, 'out of office')

  // Flip setting: OOO should park for attention when no matching edge.
  db.prepare('UPDATE campaigns SET settings = ? WHERE id = ?').run(
    JSON.stringify({ out_of_office_detection_settings: { ignoreOOOasReply: false } }),
    campaign.id,
  )
  const ctx2 = campaignCtx(campaign.id)
  db.prepare("UPDATE campaign_leads SET state = 'waiting' WHERE id = ?").run(clRow().id)
  await routeReply(ctx2, clRow(), 'out of office', null)
  assert.equal(clRow().state, 'needs_attention')
})

test('no_reply to opposite channel logs channel_switched', async () => {
  const playbook = `flowchart TD
    S([Start]) --> A[Send email: Intro]
    A -- no reply 1d --> B[Send sms: Nudge]
    B -- reply --> W([Won])
  `
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, settings) VALUES (1, 'Switch', 'running', 1, ?, ?)"
  ).run(playbook, JSON.stringify({
    reply_handling: {
      email: { noReplySwitchTo: 'sms', timeoutMs: 86400e3 },
      sms: { noReplySwitchTo: 'email', timeoutMs: 86400e3 },
    },
  }))
  const campaign = db.prepare("SELECT * FROM campaigns WHERE name = 'Switch'").get()

  // Ensure SMS account exists for the follow-up send (may already from earlier test).
  let account = db.prepare("SELECT * FROM channel_accounts WHERE channel = 'sms' LIMIT 1").get()
  if (!account) {
    db.prepare(
      "INSERT INTO channel_accounts (workspace_id, channel, provider, display_name, phone_number, status, daily_limit) VALUES (1, 'sms', 'sandbox', 'SMS', '+61400000999', 'connected', 50)"
    ).run()
    account = db.prepare("SELECT * FROM channel_accounts WHERE phone_number = '+61400000999'").get()
  }
  db.prepare('INSERT INTO campaign_channel_accounts (campaign_id, channel_account_id) VALUES (?, ?)').run(campaign.id, account.id)

  db.prepare(
    "INSERT INTO leads (user_id, email, first_name, phone, sms_opt_in_at, sms_opt_in_source) VALUES (1, 'switch@example.test', 'Sam', '+61400000888', datetime('now'), 'test')"
  ).run()
  const lead = db.prepare("SELECT * FROM leads WHERE email = 'switch@example.test'").get()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)

  await tick() // send email
  let cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(cl.node_id, 'A')

  // Make the no-reply due: backdate outbound and clear freeze so recompute fires.
  db.prepare("UPDATE messages SET created_at = datetime('now', '-2 days') WHERE campaign_id = ? AND lead_id = ?").run(campaign.id, lead.id)
  db.prepare("UPDATE campaign_leads SET wait_until = '' WHERE id = ?").run(cl.id)

  await tick()
  cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)

  const branched = db.prepare(
    "SELECT detail FROM events WHERE campaign_id = ? AND lead_id = ? AND type = 'branched' ORDER BY id DESC LIMIT 5"
  ).all(campaign.id, lead.id)
  assert.ok(
    branched.some((e) => /channel_switched/.test(e.detail)),
    `expected channel_switched in branch log, got: ${branched.map((e) => e.detail).join(' | ')}`,
  )
})
