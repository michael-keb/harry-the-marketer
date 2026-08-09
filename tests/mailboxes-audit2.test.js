// Mailbox fleet, mailbox labels and sender procurement — the twenty specs that
// still had no test-backed verdict.
//
// `tests/mailboxes-audit.test.js` proved the thing the last change rested on:
// the warm-up cap the API reports is the cap `pacing.dailyCap` hands the
// engine. `tests/parity-mailboxes.test.js`, `tests/parity-tags.test.js` and
// `tests/parity-senders.test.js` cover the request/response contracts. What
// none of them touch is the question this codebase keeps getting wrong:
//
//   **is the setting read by the code that acts on it?**
//
// So this file is deliberately not a second pass over response envelopes. It
// mounts the *whole* API — server/routes.js plus every parity module — behind a
// real session, drives `tick()`, and reads `messages`, `drafts` and `mailboxes`
// afterwards. Where a setting turns out to change a screen and nothing else,
// the test says so out loud rather than asserting the screen and stopping.
//
// Two findings are pinned here as *defects*, with the assertion written the way
// the code actually behaves and a comment naming the criterion it fails. A test
// that quietly asserts the broken value is worse than none; a test that asserts
// it and says "this is Docs/email-accounts/update.md AC 6 and it does not work"
// is a verdict somebody can act on.
//
// Fixture ordering is load-bearing, exactly as in the first audit file:
// **every test that calls `tick()` is declared before the first Gmail mailbox
// exists.** `tick()` runs `runUpkeep()`, which polls Google for every
// connected, unsuspended Gmail mailbox in the database. Sandbox mailboxes carry
// the engine tests; the two Gmail fixtures are created inside the last section,
// which never ticks. Note also that `POST /api/drafts/:id/approve` ticks on the
// way out — that is a tick, and it is why section 3 sits where it does.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-mbaudit2-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'
process.env.DEV_LOGIN = '1'
// A sentinel marketplace credential, read by server/parity/providers.js at
// import time. It makes "the marketplace key never appears in a client
// response" (Docs/smart-senders/search-domain.md §5) a claim about a *value*
// rather than about the name of an environment variable. Nothing reaches the
// network: every supplier call in this file goes through the test seam.
process.env.SENDERS_API_URL = 'https://supplier.invalid'
process.env.SENDERS_API_KEY = 'MARKETPLACE-KEY-MUST-NOT-LEAK'

const express = (await import('express')).default
const { db } = await import('../server/db.js')
const { env } = await import('../server/env.js')
const { tick } = await import('../server/engine.js')
const { dailyCap, remainingToday } = await import('../server/pacing.js')
const { newTrackingToken, trackedClickUrl, pixelUrl, unsubscribeUrl } = await import('../server/tracking.js')
const { jobs } = await import('../server/upkeep.js')
const { __setSupplierForTests } = await import('../server/parity/senders.js')
const { api } = await import('../server/routes.js')
const { authRouter } = await import('../server/auth.js')

// ---- the app ----------------------------------------------------------------
//
// The real router, not a per-module mount: `DELETE /api/mailboxes/:id` lives in
// server/routes.js while everything else in Docs/email-accounts lives in
// server/parity/mailboxes.js, and a verdict on delete.md has to exercise the
// route the product actually serves.

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  next()
})
app.use(authRouter)
app.use('/api', api)

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => new Promise((r) => server.close(r)))

async function signIn(email) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
  assert.ok(cookie, `dev-login did not return a session for ${email}`)
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  // Approvals and the sending window are set per test-owner: a 24-hour
  // every-day window keeps the recipient/clock gates from masking whatever the
  // test is actually about.
  db.prepare(
    `UPDATE users SET send_from = '00:00', send_to = '23:59', send_days = 'everyday',
                      send_timezone = 'UTC' WHERE id = ?`
  ).run(user.id)
  return { user, client: clientFor(cookie) }
}

function clientFor(cookie) {
  const send = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed, text }
  }
  return {
    get: (u) => send('GET', u),
    post: (u, b = {}) => send('POST', u, b),
    put: (u, b = {}) => send('PUT', u, b),
    patch: (u, b = {}) => send('PATCH', u, b),
    del: (u, b) => send('DELETE', u, b),
  }
}

const owner = await signIn('owner@example.com')          // approvals off
const approver = await signIn('approver@example.com')    // approvals on, set below
const stranger = await signIn('stranger@example.com')    // the other workspace
db.prepare('UPDATE users SET require_approval = 0 WHERE id IN (?, ?)').run(owner.user.id, stranger.user.id)
db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(approver.user.id)

// ---- fixtures ---------------------------------------------------------------

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- no reply 3d --> L([Lost])
`

function sandbox(wsId, address, name = address.split('@')[0]) {
  const info = db.prepare(
    "INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', ?, ?)"
  ).run(wsId, address, name)
  return db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(info.lastInsertRowid)
}

// Campaigns are created as drafts and started inside the test that means to
// drive them — `tick()` picks up every running campaign in the database, so a
// campaign started at module level is live during every other test's tick.
function draftCampaign(wsId, name, mailboxId) {
  const info = db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, 'draft', ?, ?)"
  ).run(wsId, name, mailboxId, PLAYBOOK)
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid)
}

const start = (id) => db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id)
const park = (id) => db.prepare("UPDATE campaigns SET status = 'draft' WHERE id = ?").run(id)

function attach(wsId, campaignId, address) {
  db.prepare('INSERT INTO leads (user_id, email, first_name, last_name, company) VALUES (?, ?, ?, ?, ?)')
    .run(wsId, address, 'Ada', 'Lovelace', 'Acme')
  const lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(wsId, address)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, lead.id)
  return lead
}

const rowOf = (id) => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id)
const outbound = (mailboxId) =>
  db.prepare("SELECT * FROM messages WHERE mailbox_id = ? AND direction = 'out' ORDER BY id").all(mailboxId)

// ============================================================================
// 1. Two settings that change a screen and not a send
// ============================================================================
//
// Docs/email-accounts/update.md AC 6 and AC 7. Both columns exist, both are
// validated on write, both are echoed by the detail route, and both are
// rendered by web/src/mailboxes/MailboxDrawer.jsx. Neither is read by anything
// that sends. This is the exact shape of `warmup_daily_count` before it was
// fixed — a stored, reported, edited setting with no reader on the send path.

const brandBox = sandbox(owner.user.id, 'brand.sender@sandbox.local', 'Brand Sender')
const brandCampaign = draftCampaign(owner.user.id, 'Signature audit', brandBox.id)
attach(owner.user.id, brandCampaign.id, 'brand-lead@acme.test')

// A string that cannot arrive in a composed email by accident.
const SIG_MARK = 'Wilhelmina Sanderson-Quibble'

test('a signature is stored, sanitised and shown — and never reaches an email the engine sends', async () => {
  const res = await owner.client.patch(`/api/mailboxes/${brandBox.id}`, {
    signature: `<p>Kind regards,<br>${SIG_MARK}</p><script>alert(1)</script>`,
  })
  assert.equal(res.status, 200)

  // Stored, sanitised, echoed — all of which works.
  const stored = rowOf(brandBox.id).signature
  assert.match(stored, new RegExp(SIG_MARK))
  assert.equal(stored.includes('<script'), false, 'the sanitiser let a script tag through')
  const detail = await owner.client.get(`/api/mailboxes/${brandBox.id}`)
  assert.equal(detail.body.data.signature, stored)

  // And now the part nobody had asserted. Started here, so this tick is the
  // first chance this lead has ever had to go out.
  start(brandCampaign.id)
  await tick()

  const sent = outbound(brandBox.id)
  assert.equal(sent.length, 1, 'the fixture never sent, so the claim below would be vacuous')

  // DEFECT — Docs/email-accounts/update.md AC 7: "Given I set a `signature`,
  // when it is stored, then the HTML is sanitised, and it is appended below the
  // agent-composed body". `server/mailer.js` composes the outgoing body from
  // `subject`/`body` and `withOptOutFooter` only; it never reads
  // `mailboxes.signature`. The two readers of that column
  // (server/parity/inbox.js and server/parity/campaigns.js) are the *manual*
  // reply routes, and both require an explicit `add_signature` flag. So an
  // agent-composed email — which is every email a campaign sends — carries no
  // signature at all.
  assert.equal(
    sent[0].body.includes(SIG_MARK), false,
    'if this now passes, the signature has been wired into the send path and this test should become the positive assertion',
  )
})

test('a custom tracking domain is stored and shown — and no link in any email can use it', async () => {
  const res = await owner.client.patch(`/api/mailboxes/${brandBox.id}`, {
    custom_tracking_url: 'https://links.harry-audit.test/',
  })
  assert.equal(res.status, 200)
  assert.equal(rowOf(brandBox.id).tracking_domain, 'links.harry-audit.test', 'the hostname was normalised and stored')

  const detail = await owner.client.get(`/api/mailboxes/${brandBox.id}`)
  assert.equal(detail.body.data.trackingDomain, 'links.harry-audit.test')

  // An unreachable-looking hostname is still refused at save time, which is the
  // half of AC 6 that does work.
  const bad = await owner.client.patch(`/api/mailboxes/${brandBox.id}`, { custom_tracking_url: 'not a hostname' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'custom_tracking_url')

  // DEFECT — Docs/email-accounts/update.md AC 6: "when the next email sends,
  // then ... tracking links use the custom domain". Every tracked URL is built
  // from `trackingBase()`, which is `env.APP_URL` and nothing else. The three
  // builders do not take a mailbox, a campaign or a domain, so no send path
  // *could* honour the setting without changing their signatures — which is
  // what makes this structural rather than a missed branch.
  const token = newTrackingToken()
  for (const url of [
    trackedClickUrl(token, 'https://example.com/pricing'),
    pixelUrl(token),
    unsubscribeUrl(token),
  ]) {
    assert.ok(url.startsWith(env.APP_URL), `${url} did not come from APP_URL`)
    assert.equal(url.includes('links.harry-audit.test'), false)
  }
  assert.equal(pixelUrl.length, 1, 'pixelUrl takes a token and nothing else')
  assert.equal(trackedClickUrl.length, 2, 'trackedClickUrl takes a token and a url and nothing else')

  // The campaign-level column has the same problem, so this is not a mailbox
  // oversight that the campaign settings quietly cover.
  assert.equal(
    db.prepare('SELECT tracking_domain FROM campaigns WHERE id = ?').get(brandCampaign.id).tracking_domain, '',
  )
})

// ============================================================================
// 2. Deleting a mailbox
// ============================================================================
//
// Docs/email-accounts/delete.md asks for a soft delete that detaches campaigns,
// cancels waiting drafts, switches warm-up off and keeps history — all in one
// transaction. `DELETE /api/mailboxes/:id` in server/routes.js is a hard
// `DELETE FROM mailboxes` guarded by a 409 when a live campaign uses it.
//
// The route is not in this agent's file set, so these tests state the gap
// precisely rather than closing it.

const liveBox = sandbox(owner.user.id, 'live.sender@sandbox.local')
const liveCampaign = draftCampaign(owner.user.id, 'Delete refusal audit', liveBox.id)
const goneBox = sandbox(owner.user.id, 'gone.sender@sandbox.local')
const goneCampaign = draftCampaign(owner.user.id, 'Delete history audit', goneBox.id)
attach(owner.user.id, goneCampaign.id, 'gone-lead@acme.test')

test('the detail route can answer "what does this break" before anything is deleted', async () => {
  start(liveCampaign.id)
  const detail = await owner.client.get(`/api/mailboxes/${liveBox.id}`)
  assert.equal(detail.status, 200)
  const impact = detail.body.data.deleteImpact
  assert.equal(impact.campaignsAttached, 1, 'the confirmation has nothing to name')
  assert.equal(impact.draftsWaiting, 0)
  // A healthy mailbox holds nothing back, so `wouldHold` is empty here; the
  // suspended case is covered in tests/mailboxes-audit.test.js.
  assert.deepEqual(impact.wouldHold, [])
})

test('deleting a mailbox a running campaign uses is refused outright, not detached', async () => {
  const res = await owner.client.del(`/api/mailboxes/${liveBox.id}`)

  // DEFECT — delete.md AC 2: "when I delete it, then it is detached from all of
  // them as part of the same operation, and any campaign left with no mailbox
  // moves to holding with a stated reason". The route refuses instead, so the
  // documented flow (confirm the consequences, then delete) cannot happen at
  // all for the case the spec spends most of its words on.
  assert.equal(res.status, 409)
  assert.match(res.body.error, /archive them first/)
  assert.ok(rowOf(liveBox.id), 'the mailbox survived, which is the one thing the refusal gets right')
  assert.equal(
    db.prepare('SELECT status FROM campaigns WHERE id = ?').get(liveCampaign.id).status, 'running',
    'the campaign was neither detached nor moved to holding',
  )
})

test('a delete is a hard delete: the row is gone and its sent mail loses the address it came from', async () => {
  start(goneCampaign.id)
  await tick()
  const sent = outbound(goneBox.id)
  assert.equal(sent.length, 1, 'nothing was sent, so "history survives" would be vacuous')
  const messageId = sent[0].id

  // Parked so the 409 guard above lets the delete through at all.
  park(goneCampaign.id)

  const res = await owner.client.del(`/api/mailboxes/${goneBox.id}`)
  assert.equal(res.status, 200)

  // DEFECT — delete.md AC 1: the response is documented as carrying the deleted
  // id (`emailAccountId`). It carries `{ ok: true }` and nothing else.
  assert.deepEqual(res.body, { ok: true })

  // DEFECT — delete.md AC 4 and §5: "the mailbox is soft-deleted ... so Inbox
  // and Reports history stays intact". There is no `deleted_at` column on
  // `mailboxes` at all, and the row is physically removed.
  const columns = db.prepare('PRAGMA table_info(mailboxes)').all().map((c) => c.name)
  assert.equal(columns.includes('deleted_at'), false, 'a deleted_at column now exists — soft delete may have landed')
  assert.equal(rowOf(goneBox.id), undefined, 'the row was removed rather than marked')

  // The message row survives, but the foreign key is ON DELETE SET NULL, so the
  // send is no longer attributable to any address. delete.md TC-9 asks for
  // history "labelled with the removed mailbox"; what is left cannot be.
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  assert.ok(message, 'the message itself was destroyed, which would be worse still')
  assert.equal(message.mailbox_id, null, 'the sending address survived the delete — soft delete may have landed')
  assert.equal(message.from_email, 'gone.sender@sandbox.local', 'the address is only still readable off the message text')

  // And the campaign silently loses its sender rather than being told.
  assert.equal(db.prepare('SELECT mailbox_id FROM campaigns WHERE id = ?').get(goneCampaign.id).mailbox_id, null)
})

test('a mailbox id from another workspace is a 404 that leaks nothing — without the documented error code', async () => {
  const theirs = sandbox(stranger.user.id, 'theirs.sender@sandbox.local')

  const res = await owner.client.del(`/api/mailboxes/${theirs.id}`)
  assert.equal(res.status, 404)
  assert.ok(rowOf(theirs.id), 'a cross-workspace delete destroyed somebody else’s mailbox')
  // The isolation is right; only the shape differs from delete.md AC 5, which
  // names `errorCode: "ACCOUNT_NOT_FOUND"`.
  assert.equal(res.body.errorCode, undefined)

  // Deleting the same id twice reads as already-gone, which TC-10 asks for.
  const again = await owner.client.del(`/api/mailboxes/${goneBox.id}`)
  assert.equal(again.status, 404)
})

// ============================================================================
// 3. An approved email survives a suspension and goes out unchanged
// ============================================================================
//
// Docs/email-accounts/suspend.md AC 5 and unsuspend.md AC 4, and the backend
// DoD "Queued approved drafts are dispatched unchanged, covered by a test
// comparing stored and sent bodies". This is the criterion most likely to be
// wrong in the invisible direction: a re-composed replacement looks identical
// in a screenshot and is a different email from the one a human signed off.
//
// One mailbox on the campaign deliberately. With two, rotation would legally
// send the approved draft from the other mailbox, and the question "did the
// suspended mailbox's queue survive" would have no answer.

const queueBox = sandbox(approver.user.id, 'queue.sender@sandbox.local')
const queueCampaign = draftCampaign(approver.user.id, 'Queued approval audit', queueBox.id)
const queueLead = attach(approver.user.id, queueCampaign.id, 'queue-lead@acme.test')

test('an approved email waits out a suspension and then goes out as the exact email that was approved', async () => {
  start(queueCampaign.id)
  await tick()

  // Approvals are on, so the engine composed and stopped.
  const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?')
    .get(queueCampaign.id, queueLead.id)
  assert.ok(draft, 'no draft was queued, so there is nothing to approve')
  assert.equal(draft.status, 'pending')
  assert.equal(outbound(queueBox.id).length, 0)

  // Suspend first, then approve — approving runs a tick of its own, which is
  // precisely the tick that must not send.
  const suspend = await approver.client.put(`/api/mailboxes/${queueBox.id}/suspend`, { reason: 'Deliverability check' })
  assert.equal(suspend.status, 200)
  assert.equal(rowOf(queueBox.id).is_suspended, 1)

  const approved = await approver.client.post(`/api/drafts/${draft.id}/approve`)
  assert.equal(approved.status, 200)
  assert.equal(approved.body.sent, false, 'the approval tick sent from a suspended mailbox')

  const held = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id)
  assert.equal(held.status, 'approved', 'the draft was cancelled rather than left queued')
  assert.equal(outbound(queueBox.id).length, 0, 'the engine sent from a mailbox the user had switched off')

  // Several ticks: "queued and unsent" has to survive more than one.
  await tick()
  await tick()
  assert.equal(outbound(queueBox.id).length, 0)
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'approved')

  // And the campaign says why it went quiet, in the mailbox's own words.
  const gated = db.prepare(
    "SELECT detail FROM events WHERE campaign_id = ? AND type = 'send_gated' ORDER BY id"
  ).all(queueCampaign.id).map((r) => r.detail).join(' | ')
  assert.match(gated, /suspended/i)
  assert.match(gated, /Deliverability check/)

  // Resume. The stored draft is captured *before* the send so the comparison is
  // against what the human approved, not against whatever ended up in the row.
  const approvedSubject = held.subject
  const approvedBody = held.body
  assert.ok(approvedBody.length > 20, 'the fixture body is too thin for the comparison to mean anything')

  const resume = await approver.client.del(`/api/mailboxes/${queueBox.id}/suspend`)
  assert.equal(resume.status, 200)
  assert.equal(rowOf(queueBox.id).is_suspended, 0)

  await tick()

  const sent = outbound(queueBox.id)
  assert.equal(sent.length, 1, 'the resumed mailbox sent nothing, or sent twice')
  assert.equal(sent[0].subject, approvedSubject, 'a different subject went out from the one that was approved')
  assert.equal(sent[0].body, approvedBody, 'the engine re-composed the email instead of sending the approved one')
  assert.equal(sent[0].to_email, 'queue-lead@acme.test')
  assert.equal(sent[0].from_email, 'queue.sender@sandbox.local')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'sent')

  // No second draft was written for this lead: a replacement composed alongside
  // the approved one is the failure mode this whole section exists for.
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM drafts WHERE campaign_id = ? AND lead_id = ?')
      .get(queueCampaign.id, queueLead.id).n, 1,
  )

  // The trail names both halves, so a teammate is not left guessing.
  const trail = db.prepare("SELECT type FROM events WHERE user_id = ? AND type LIKE 'mailbox_%suspended'")
    .all(approver.user.id).map((r) => r.type)
  assert.ok(trail.includes('mailbox_suspended'))
  assert.ok(trail.includes('mailbox_unsuspended'))
})

// ============================================================================
// 4. A label is a label
// ============================================================================
//
// Docs/email-account-tags/assign.md AC 8: "Given tags are only labels, when
// they are assigned, then nothing about sending changes — no limit, no warm-up,
// no campaign attachment moves." A tag table joined into the fleet serialiser
// is exactly the sort of thing that grows a filter somewhere in the send path
// six months later, so the claim is worth a tick rather than an inspection.

const tagBox = sandbox(owner.user.id, 'tagged.sender@sandbox.local')
const tagCampaign = draftCampaign(owner.user.id, 'Label audit', tagBox.id)
attach(owner.user.id, tagCampaign.id, 'tag-lead-1@acme.test')
attach(owner.user.id, tagCampaign.id, 'tag-lead-2@acme.test')

// The columns that decide whether and how much a mailbox may send.
const SENDING_COLUMNS = [
  'daily_limit', 'message_per_day', 'status', 'is_suspended',
  'warmup_enabled', 'warmup_daily_count', 'warmup_ramp_enabled', 'warmup_ramp_step',
  'warmup_target_reply_rate', 'warmup_auto_adjust', 'client_id',
]
const sendingShape = (id) => {
  const row = rowOf(id)
  return Object.fromEntries(SENDING_COLUMNS.map((c) => [c, row[c]]))
}

test('assigning a mailbox label changes the chips and the filter, and nothing about sending', async () => {
  start(tagCampaign.id)
  await tick()
  const before = outbound(tagBox.id).length
  assert.equal(before, 2, 'the baseline tick did not send, so "unchanged" would be vacuous')
  const shapeBefore = sendingShape(tagBox.id)
  const capBefore = dailyCap(rowOf(tagBox.id))

  const made = await owner.client.post('/api/tags', { appliesTo: 'mailbox', name: 'Winners' })
  assert.equal(made.status, 200)
  const winners = made.body.data.id
  const other = (await owner.client.post('/api/tags', { appliesTo: 'mailbox', name: 'Retired' })).body.data.id

  const assigned = await owner.client.post('/api/tags/assign', { mailboxIds: [tagBox.id], tagIds: [winners] })
  assert.equal(assigned.status, 200)
  assert.equal(assigned.body.assigned, 1)

  // What the user is meant to see: the chip on the row, and a filter that
  // matches it (assign.md AC 6, which nothing covered).
  const fleet = await owner.client.get('/api/mailboxes/fleet?limit=100')
  const row = fleet.body.data.find((r) => r.id === tagBox.id)
  assert.deepEqual(row.tags.map((t) => t.name), ['Winners'])
  assert.ok(/^#[0-9a-f]{6}$/.test(row.tags[0].color), 'a chip colour that cannot be rendered')

  const filtered = await owner.client.get(`/api/mailboxes/fleet?tagId=${winners}`)
  assert.deepEqual(filtered.body.data.map((r) => r.id), [tagBox.id])
  const emptyFilter = await owner.client.get(`/api/mailboxes/fleet?tagId=${other}`)
  assert.equal(emptyFilter.body.data.length, 0)
  assert.match(emptyFilter.body.emptyReason, /No mailboxes match/, 'a filtered-empty list read as a first-run empty state')

  // What must not have moved.
  assert.deepEqual(sendingShape(tagBox.id), shapeBefore, 'a label changed a sending setting')
  assert.equal(dailyCap(rowOf(tagBox.id)), capBefore)
  assert.equal(
    db.prepare('SELECT mailbox_id FROM campaigns WHERE id = ?').get(tagCampaign.id).mailbox_id, tagBox.id,
    'a label moved a campaign attachment',
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(tagCampaign.id).n, 0,
  )

  // And the engine still sends exactly as it did: two new leads, two sends.
  attach(owner.user.id, tagCampaign.id, 'tag-lead-3@acme.test')
  attach(owner.user.id, tagCampaign.id, 'tag-lead-4@acme.test')
  await tick()
  assert.equal(outbound(tagBox.id).length - before, 2, 'tagging the mailbox changed what left the building')

  // Removing the label is the mirror: the mapping goes, the label stays with a
  // usage count of zero, and sending is untouched again (remove.md AC 1, AC 6).
  const removed = await owner.client.del('/api/tags/assign', { mailboxIds: [tagBox.id], tagIds: [winners] })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.removed, 1)
  const master = await owner.client.get('/api/mailboxes/tags')
  const still = master.body.data.find((t) => t.id === winners)
  assert.ok(still, 'removing the last mapping deleted the label itself')
  assert.equal(still.mailboxCount, 0)
  assert.deepEqual(sendingShape(tagBox.id), shapeBefore)
})

// ============================================================================
// 5. The supplier seam — smart-senders with a supplier that actually answers
// ============================================================================
//
// Every existing test in tests/parity-senders.test.js runs with no marketplace
// configured, which exercises the honest-unconfigured path and none of the
// filtering, tolerance and stripping the specs' backend DoDs name. These drive
// `__setSupplierForTests` so there is a payload to filter.
//
// Nothing below ticks the engine, and nothing below creates a Gmail mailbox.

const UNCONFIGURED = async () => ({ ok: false, reason: 'unconfigured', payload: null })
test.afterEach(() => __setSupplierForTests(UNCONFIGURED))

test('domain search filters the supplier’s list server-side: price, availability and relevance', async () => {
  __setSupplierForTests(async () => ({
    ok: true, reason: '', payload: {
      data: [
        { domain: 'techbuilddemo.com', price: 9, currency: 'USD' },
        { domain: 'techbuilddemo.io', price: 25, currency: 'USD' },        // over the ceiling
        { domain: 'techbuilddemo.net', price: 4, available: false },       // not for sale
        { domain: 'somethingelse.com', price: 3 },                          // irrelevant upsell
        { domain: 'techbuilddemo.co' },                                     // no price at all
        { domain: 'not a domain', price: 1 },                               // malformed
      ],
    },
  }))

  const res = await owner.client.get('/api/senders/domains/search?vendor_id=2&q=techbuilddemo')
  assert.equal(res.status, 200)
  assert.equal(res.body.live, true)
  const names = res.body.data.map((r) => r.domain).sort()
  assert.deepEqual(names, ['techbuilddemo.co', 'techbuilddemo.com'],
    'the supplier upsold past the ceiling, the relevance filter or the availability filter')
  // A row with no price is kept and labelled rather than dropped — the UI reads
  // "price shown at checkout" (search-domain.md AC 1).
  assert.equal(res.body.data.find((r) => r.domain === 'techbuilddemo.co').price, null)
  assert.equal(res.body.price_ceiling, 15)

  // The marketplace key never reaches the client, whatever the supplier said.
  assert.equal(res.text.includes(process.env.SENDERS_API_KEY), false, 'the marketplace key leaked to the client')
  assert.equal(res.text.includes('supplier.invalid'), false, 'the supplier base URL leaked to the client')
})

test('a vendor with no price and no description survives the list, unknown fields and all', async () => {
  __setSupplierForTests(async () => ({
    ok: true, reason: '', payload: {
      data: [
        { id: 'thin-vendor' },
        { id: 'rich-vendor', name: 'Big Registrar', currency: 'EUR', region: 'EU', extras: { included: ['dns'] } },
      ],
    },
  }))

  const res = await owner.client.get('/api/senders/vendors')
  assert.equal(res.status, 200)
  const thin = res.body.data.find((v) => v.vendor_id === 'thin-vendor')
  const rich = res.body.data.find((v) => v.vendor_id === 'rich-vendor')
  assert.ok(thin, 'a vendor with only an id was dropped')
  assert.equal(thin.name, 'thin-vendor', 'a nameless vendor must still be selectable by its id')
  assert.equal(thin.currency, 'USD')
  assert.equal(rich.details.region, 'EU', 'unknown supplier fields were discarded')
  assert.deepEqual(rich.details.extras.included, ['dns'])

  // get-vendors.md AC 7: prices may show, but the Buy action is disabled until
  // a payment method exists — and Harry never holds one, so this is what the UI
  // reads. Nothing here takes a purchase decision.
  assert.equal(res.body.billing_on_file, false)
})

test('a purchased-domain response that is nothing but names is stored, dated and joined to Harry’s mailboxes', async () => {
  // domain-list.md §5 DoD: "A response containing only domain names is handled
  // without error" and the mailbox join is subdomain-aware.
  sandbox(owner.user.id, 'news@sub.harry-audit-domain.com')
  __setSupplierForTests(async () => ({
    ok: true, reason: '', payload: { data: ['harry-audit-domain.com', 'idle-audit-domain.com'] },
  }))

  const res = await owner.client.get('/api/senders/domains')
  assert.equal(res.status, 200)
  assert.equal(res.body.stale, false)
  assert.ok(res.body.as_of, 'a successful read recorded no "as of"')

  const used = res.body.data.find((d) => d.domain === 'harry-audit-domain.com')
  const idle = res.body.data.find((d) => d.domain === 'idle-audit-domain.com')
  assert.ok(used && idle, 'a bare-string supplier row was dropped')
  assert.equal(used.mailbox_count, 1, 'a mailbox on a subdomain did not count towards its domain')
  assert.equal(used.unused, false)
  assert.equal(idle.mailbox_count, 0)
  assert.equal(idle.unused, true, 'a paid domain doing nothing was not surfaced')
  assert.equal(used.expires_at, null, 'a supplier that gave no date was quoted one anyway')
})

test('supplier mailbox suggestions off the domain being bought are dropped and counted', async () => {
  __setSupplierForTests(async () => ({
    ok: true, reason: '', payload: {
      data: [
        { mailbox: 'ada@wanted-audit.com', first_name: 'Ada', last_name: 'Lovelace' },
        { mailbox: 'eve@elsewhere-audit.com' },   // off-domain
        { mailbox: 'not valid!@wanted-audit.com' }, // malformed local part
      ],
    },
  }))

  const res = await owner.client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '2', domains: { 'wanted-audit.com': { count: 3 } },
  })
  assert.equal(res.status, 200)
  const group = res.body.data[0]
  assert.equal(group.domain, 'wanted-audit.com')
  assert.equal(group.source, 'vendor')
  assert.deepEqual(group.suggestions.map((s) => s.mailbox), ['ada@wanted-audit.com'],
    'a supplier slipped an address onto a domain the user is not buying')
  assert.ok(res.body.dropped >= 2, 'the dropped rows were absorbed silently')
  assert.equal(res.body.editable, true)

  // Nothing is stored by a suggestion: it is a proposal, not a purchase.
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM sender_orders WHERE workspace_id = ?').get(owner.user.id).n, 0,
  )
})

test('a supplier failure produces the same shape as an empty result and names a real person', async () => {
  __setSupplierForTests(async () => ({ ok: false, reason: 'timeout', payload: null }))
  const res = await owner.client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '2', domains: [{ domain_name: 'fallback-audit.com', count: 2 }],
  })
  assert.equal(res.status, 200)
  const group = res.body.data[0]
  assert.equal(group.source, 'harry', 'a locally derived list was passed off as the supplier’s')
  assert.equal(group.suggestions.length, 2, 'a supplier timeout blocked the flow instead of falling back')
  assert.ok(group.suggestions.every((s) => s.mailbox.endsWith('@fallback-audit.com')))
  // auto-generate.md AC 4: the names lean on somebody actually in the
  // workspace, never an invented persona.
  assert.ok(res.body.identity.first_name)
  assert.match(res.body.identity.source, /workspace/)

  // And the count bound is enforced server-side, not only in the UI (AC 5).
  const absurd = await owner.client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '2', domains: [{ domain_name: 'fallback-audit.com', count: 500 }],
  })
  assert.equal(absurd.status, 422)
  assert.match(absurd.body.message, /count/)
})

test('reconciling a pending order reads, never writes — and the supplier’s password never lands anywhere', async () => {
  const ref = 'HTM-ORD-AUDIT2-RECON'
  db.prepare(
    `INSERT INTO sender_orders
       (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
     VALUES (?, '2', ?, 'audit2-recon-key', 'pending', 'forward-audit.com', ?, '[]', 12.5, 'USD', 'owner@example.com')`
  ).run(owner.user.id, ref, JSON.stringify(['recon-audit.com']))

  const calls = []
  __setSupplierForTests(async (path, options) => {
    calls.push({ path, method: options?.method || 'GET' })
    return {
      ok: true, reason: '', payload: {
        data: {
          order_id: ref, status: 'completed', domain: 'recon-audit.com',
          expires_at: '2031-04-05T00:00:00Z',
          email_accounts: [{ address: 'Ada@Recon-Audit.com', password: 'hunter2-supplier-secret' }],
        },
      },
    }
  })

  const res = await owner.client.get(`/api/senders/orders/${ref}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.reconciled, true)
  assert.equal(res.body.data.status, 'placed', 'the supplier said completed and the order stayed pending')
  assert.equal(res.body.auto_retry, false)

  // Read only. A reconciliation that POSTs is a reconciliation that can buy the
  // same domain twice (order-details.md §5 DoD).
  assert.ok(calls.length, 'the supplier was never consulted')
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET'], 'reconciliation wrote to the supplier')

  // The credential is stripped before a row is constructed, absent from the
  // response, and absent from the stored order.
  assert.equal(res.text.includes('hunter2-supplier-secret'), false, 'the password came back in the response')
  assert.equal(res.body.credentials, undefined, 'credentials were served without being asked for')
  const stored = db.prepare('SELECT mailboxes FROM sender_orders WHERE order_ref = ?').get(ref).mailboxes
  assert.equal(stored.includes('hunter2-supplier-secret'), false, 'the password was written to the database')
  assert.equal(/"password"/.test(stored), false)
  assert.match(stored, /ada@recon-audit\.com/, 'the address was lost along with the password')

  // The expiry the supplier gave is what the order reports, read back from the
  // domain rows the order created rather than invented.
  assert.equal(res.body.data.expires_at, '2031-04-05T00:00:00Z')
  assert.equal(res.body.data.expired, false)

  // The status move is in the activity trail (order-details.md §5 DoD).
  const moved = db.prepare("SELECT detail FROM events WHERE user_id = ? AND type = 'sender_order_status'")
    .all(owner.user.id).map((r) => r.detail).join(' | ')
  assert.match(moved, new RegExp(`${ref}.*pending`))
  assert.match(moved, /placed/)

  // Revealing is an explicit act, and the act is logged while the value is not.
  const revealed = await owner.client.get(`/api/senders/orders/${ref}?reveal=1`)
  assert.equal(revealed.status, 200)
  assert.deepEqual(revealed.body.credentials, [{ address: 'ada@recon-audit.com', credential: 'hunter2-supplier-secret' }])
  const reveals = db.prepare("SELECT detail FROM events WHERE user_id = ? AND type = 'sender_credential_revealed'")
    .all(owner.user.id)
  assert.equal(reveals.length, 1)
  assert.equal(reveals[0].detail.includes('hunter2-supplier-secret'), false, 'the trail recorded the credential itself')

  // A reference from another workspace is the same 404 as one that never
  // existed, so nothing here confirms the reference exists elsewhere.
  const theirs = await stranger.client.get(`/api/senders/orders/${ref}`)
  const unknown = await stranger.client.get('/api/senders/orders/HTM-ORD-NOSUCHREF')
  assert.equal(theirs.status, 404)
  assert.equal(theirs.status, unknown.status)
  assert.deepEqual(theirs.body, unknown.body)
})

// ============================================================================
// 6. Auto-adjusted warm-up binds the send path, not just the panel
// ============================================================================
//
// Docs/email-accounts/warmup-settings.md AC 6. `server/upkeep.js` tunes
// `warmup_daily_count` off bounce telemetry; tests/upkeep.test.js already
// proves the arithmetic and the trail entry. What nobody asserted is the join
// that the original defect was made of: that the number upkeep writes is the
// number `pacing.dailyCap` — and therefore the gate stack, the mailer and the
// fleet list — will actually use.
//
// GMAIL FIXTURES START HERE. Nothing below this line ticks the engine.

const DAY = 86_400_000
const sqlTime = (daysAgo = 0) =>
  new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 19).replace('T', ' ')
const dayString = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10)

test('an automatic warm-up back-off lands on the send path, not only in the trail', async () => {
  const info = db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, daily_limit, created_at, status,
                            warmup_enabled, warmup_auto_adjust, warmup_ramp_enabled, warmup_daily_count, warmup_ramp_step)
     VALUES (?, 'gmail', 'autotune@example.com', 'Auto', 40, ?, 'connected', 1, 1, 1, 30, 5)`
  ).run(owner.user.id, sqlTime(60))
  const id = Number(info.lastInsertRowid)

  // Before: the count the user chose is what everything quotes.
  assert.equal(dailyCap(rowOf(id)), 30)
  const before = await owner.client.get(`/api/mailboxes/${id}`)
  assert.equal(before.body.data.sending.cap, 30)
  assert.equal(before.body.data.warmupDetails.dailyCountToday, 30)

  // Yesterday's evidence: 100 sends, 12 of them bounced. Well over the 5%
  // back-off threshold and well over the ten-send minimum.
  db.prepare('INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox) VALUES (?, ?, 100, 2, 12, 88)')
    .run(id, dayString(1))

  await jobs.adjustWarmup()

  const tuned = rowOf(id).warmup_daily_count
  assert.equal(tuned, 20, 'the back-off is bounded and stepped: 30 − (5 × 2)')
  assert.match(
    db.prepare("SELECT detail FROM events WHERE type = 'warmup_adjusted' AND user_id = ? ORDER BY id DESC LIMIT 1")
      .get(owner.user.id).detail,
    /autotune@example\.com/,
    'the reduction was silent',
  )

  // The join that matters. Not "the panel shows 20" — the send path uses 20.
  const fresh = rowOf(id)
  assert.equal(dailyCap(fresh), tuned, 'upkeep wrote a number the engine does not read')
  assert.equal(remainingToday(fresh), tuned)

  const after = await owner.client.get(`/api/mailboxes/${id}`)
  assert.equal(after.body.data.sending.cap, tuned, 'the screen and the send path quote two numbers')
  assert.equal(after.body.data.sending.pacingCap, dailyCap(fresh))
  assert.equal(after.body.data.sending.remainingToday, tuned)
  assert.equal(after.body.data.warmupDetails.dailyCountToday, tuned)

  const fleet = await owner.client.get('/api/mailboxes/fleet?limit=100')
  const listed = fleet.body.data.find((r) => r.id === id)
  assert.equal(listed.sending.cap, tuned, 'the fleet list quotes a third number')
  assert.equal(listed.remainingToday, tuned)

  // And the warm-up route agrees with all of them.
  const warm = await owner.client.put(`/api/mailboxes/${id}/warmup`, {})
  assert.equal(warm.status, 200)
  assert.equal(warm.body.data.effectiveDailyCap, dailyCap(rowOf(id)))
  assert.equal(warm.body.data.dailyCount, tuned, 'the route reported a count the row does not hold')
})

test('ramp-up off means "do not climb past the count you chose", not "start there on day one"', async () => {
  // Docs/email-accounts/warmup-settings.md AC 3 and TC-7 read "the daily figure
  // stays flat at `total_warmup_per_day` ... every day, verified across three
  // simulated days". Harry's own first-fortnight floor is not switchable — a
  // brand-new mailbox is held to 10 whatever the warm-up route was told, which
  // is the whole reason the ramp exists. The figure is flat from day one
  // onwards, not from day zero. The divergence is now recorded in the spec's
  // §2; this pins the arithmetic behind it.
  const make = (address, daysAgo) => {
    const info = db.prepare(
      `INSERT INTO mailboxes (user_id, provider, email, display_name, daily_limit, created_at, status,
                              warmup_enabled, warmup_ramp_enabled, warmup_daily_count, warmup_ramp_step)
       VALUES (?, 'gmail', ?, 'Flat', 50, ?, 'connected', 1, 0, 15, 5)`
    ).run(owner.user.id, address, sqlTime(daysAgo))
    return rowOf(Number(info.lastInsertRowid))
  }

  assert.equal(dailyCap(make('flat-day0@example.com', 0)), 10, 'the connection-day floor is 10, and it is not switchable')
  for (const [day, address] of [[1, 'flat-day1@example.com'], [2, 'flat-day2@example.com'], [9, 'flat-day9@example.com']]) {
    assert.equal(dailyCap(make(address, day)), 15, `day ${day}: the figure climbed past the count the user chose`)
  }

  // And the route reports the same number it will send at, on the day that
  // differs — which is the only thing that would make the divergence dangerous.
  const day0 = db.prepare("SELECT id FROM mailboxes WHERE email = 'flat-day0@example.com'").get().id
  const res = await owner.client.put(`/api/mailboxes/${day0}/warmup`, { is_rampup_enabled: false, total_warmup_per_day: 15 })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.effectiveDailyCap, 10, 'the panel promised 15 while the mailbox would send 10')
  assert.equal(res.body.data.dailyCount, 15, 'the setting the user chose was not kept')
  assert.equal(res.body.data.effectiveDailyCap, dailyCap(rowOf(day0)))
})

test('a suspended mailbox is skipped by auto-adjust, and its ramp position is preserved', async () => {
  // suspend.md §5 DoD: "Warm-up ramp position is preserved across a
  // suspension". The stored count is the ramp position, and a background job
  // that kept tuning a mailbox nobody is sending from would move it.
  const info = db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, daily_limit, created_at, status,
                            warmup_enabled, warmup_auto_adjust, warmup_ramp_enabled, warmup_daily_count, warmup_ramp_step)
     VALUES (?, 'gmail', 'paused-tune@example.com', 'Paused', 40, ?, 'connected', 1, 1, 1, 25, 5)`
  ).run(owner.user.id, sqlTime(60))
  const id = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox) VALUES (?, ?, 100, 2, 12, 88)')
    .run(id, dayString(1))

  const suspended = await owner.client.put(`/api/mailboxes/${id}/suspend`, { reason: 'Investigating' })
  assert.equal(suspended.status, 200)

  await jobs.adjustWarmup()
  assert.equal(rowOf(id).warmup_daily_count, 25, 'the ramp moved while the mailbox was switched off')

  // The panel reports the pause honestly rather than as warm-up being off.
  const detail = await owner.client.get(`/api/mailboxes/${id}`)
  assert.equal(detail.body.data.warmupDetails.status, 'PAUSED')
  assert.match(detail.body.data.warmupDetails.blockedReason, /Investigating/)

  // Resuming puts the same position back, neither restarted nor jumped to the
  // ceiling (unsuspend.md AC 2).
  const resumed = await owner.client.del(`/api/mailboxes/${id}/suspend`)
  assert.equal(resumed.status, 200)
  assert.equal(rowOf(id).warmup_daily_count, 25)
  assert.equal(dailyCap(rowOf(id)), 25)
  assert.notEqual(dailyCap(rowOf(id)), 40, 'the resume handed the mailbox its full allowance')
})
