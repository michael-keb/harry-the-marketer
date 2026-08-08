// Suppression cannot be routed around.
//
// An audit proved it could be. `mailer.sendEmail` carried the check and was
// described as "the one line every send passes through" — but four call sites
// reach `gmailSend` directly, and a forward to `ana@mail.competitor.com` went
// out 200 with `competitor.com` blocked.
//
// The check now lives in `gmailSend` itself, the last function before the bytes
// leave the process. These tests exist to make adding a fifth bypass painful:
// if someone reaches past the transport again, the count test below fails.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setup, seedUser, seedLead } from './helpers/parity-harness.js'

setup('suppression-chokepoint')

const { db } = await import('../server/db.js')
const { suppressionFor, SuppressedError } = await import('../server/suppression.js')
const { gmailSend } = await import('../server/google.js')

const owner = seedUser(db, 'owner@chokepoint.test')
const block = (value, isDomain = 1) =>
  db.prepare(
    "INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, ?, ?, 'manual')"
  ).run(owner.id, value, isDomain)

const mailbox = { id: 1, user_id: owner.id, email: 'sender@example.com', display_name: 'S', provider: 'gmail' }

test('a blocked domain also blocks its subdomains — the case that got through', async () => {
  block('competitor.com')
  // The predicate itself must agree before we test the transport.
  assert.ok(suppressionFor(owner.id, { address: 'ana@mail.competitor.com' }),
    'suppressionFor walks parent labels')

  await assert.rejects(
    () => gmailSend(mailbox, { to: 'ana@mail.competitor.com', subject: 'Hi', body: 'x', workspaceId: owner.id }),
    (err) => err instanceof SuppressedError,
    'the transport refuses it'
  )
})

test('one suppressed recipient refuses the whole forward, rather than silently dropping them', async () => {
  block('competitor.com')
  await assert.rejects(
    () => gmailSend(mailbox, {
      to: 'ok@allowed.test, ana@competitor.com',
      subject: 'Fwd', body: 'x', workspaceId: owner.id,
    }),
    (err) => err instanceof SuppressedError,
    'a partial forward is a worse surprise than a refused one'
  )
})

test('an unsubscribed lead cannot be reached through the transport', async () => {
  const lead = seedLead(db, owner.id, 'quit@allowed.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(lead.id)
  await assert.rejects(
    () => gmailSend(mailbox, { to: 'quit@allowed.test', subject: 'Hi', body: 'x', workspaceId: owner.id }),
    (err) => err instanceof SuppressedError
  )
})

test('a display-name address is unwrapped before it is checked', async () => {
  block('competitor.com')
  await assert.rejects(
    () => gmailSend(mailbox, { to: 'Ana Example <ana@competitor.com>', subject: 'Hi', body: 'x', workspaceId: owner.id }),
    (err) => err instanceof SuppressedError,
    '"Name <addr>" must not slip past the match'
  )
})

test('a caller that cannot name the workspace is refused, not silently unchecked', async () => {
  await assert.rejects(
    () => gmailSend({ email: 'x@y.test' }, { to: 'anyone@allowed.test', subject: 'Hi', body: 'x' }),
    /requires workspaceId/,
    'no workspace means no suppression list means no send'
  )
})

test('an allowed recipient still passes the guard', async () => {
  // Reaches the network layer and fails there, which is the proof it got past
  // suppression rather than being stopped by it.
  await assert.rejects(
    () => gmailSend(mailbox, { to: 'fine@allowed.test', subject: 'Hi', body: 'x', workspaceId: owner.id }),
    (err) => !(err instanceof SuppressedError),
    'not blocked — it fails for want of a Google token, which is a different thing'
  )
})

test('nothing reaches the wire except through the checked transport', () => {
  // The structural guarantee. `gmailSend` is the only function that hands bytes
  // to Google, and it now always checks. If a future change adds a second
  // sender — a raw gmailFetch to messages/send, say — this fails.
  const google = fs.readFileSync(path.join(process.cwd(), 'server', 'google.js'), 'utf8')
  const senders = google.match(/messages\/send/g) || []
  assert.equal(senders.length, 1, `exactly one send path in google.js, found ${senders.length}`)
  assert.ok(google.includes('suppressionFor'), 'and it consults suppression')
})
