// Two defects that a green test suite hid, and the tests that would have caught
// them. Both are the same shape of mistake: a setting that changed what the
// product *said* and nothing about what it *did*.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox } from './helpers/parity-harness.js'

setup('send-settings')
// The legacy route lives on the real router, behind the real `requireUser` —
// which is the whole point of testing it there. So this test signs in properly
// rather than injecting a fake `req.user` the router would ignore.
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { buildHtmlBody, withOptOutFooter, pixelUrl } = await import('../server/tracking.js')

const owner = seedUser(db, 'owner@sendsettings.test')

// ---- tracking settings must reach the wire ----------------------------------

test('open tracking off means no pixel — the setting is not decorative', () => {
  const on = buildHtmlBody({ body: 'Hello', token: 'tok1', trackOpens: true, trackClicks: true })
  const off = buildHtmlBody({ body: 'Hello', token: 'tok1', trackOpens: false, trackClicks: true })

  assert.ok(on.includes(pixelUrl('tok1')), 'tracked: pixel present')
  assert.ok(!off.includes(pixelUrl('tok1')), 'untracked: no pixel')
  assert.ok(!off.includes('/t/o/'), 'no open-tracking URL of any form')
})

test('click tracking off means links are not rewritten through the redirector', () => {
  const body = 'Read this: https://example.com/page'
  const on = buildHtmlBody({ body, token: 'tok2', trackOpens: true, trackClicks: true })
  const off = buildHtmlBody({ body, token: 'tok2', trackOpens: true, trackClicks: false })

  assert.ok(on.includes('/t/c/'), 'tracked: click redirector present')
  assert.ok(!off.includes('/t/c/'), 'untracked: no click redirector')
  // Still a working link — not tracking is the ask, not breaking the email.
  assert.ok(off.includes('href="https://example.com/page"'))
})

test('the unsubscribe link survives every tracking setting', () => {
  // Suppression and the right to leave are not campaign preferences. If a
  // future setting makes this optional, this test is the objection.
  for (const flags of [
    { trackOpens: true, trackClicks: true },
    { trackOpens: false, trackClicks: false },
  ]) {
    const html = buildHtmlBody({ body: 'Hi', token: 'tok3', ...flags })
    assert.ok(html.includes('/t/u/tok3'), `unsubscribe present with ${JSON.stringify(flags)}`)
  }
  assert.match(withOptOutFooter('Hi', 'tok3'), /Unsubscribe here: .*\/t\/u\/tok3/)
})

test('defaults are unchanged, so a campaign nobody configured behaves as before', () => {
  const html = buildHtmlBody({ body: 'Hi', token: 'tok4' })
  assert.ok(html.includes(pixelUrl('tok4')))
  assert.ok(html.includes('/t/u/tok4'))
})

// ---- STOPPED is terminal on every route that can write status ---------------

test('a permanently stopped campaign cannot be restarted through the legacy route', async () => {
  const mailbox = seedMailbox(db, owner.id, 'stop@example.com')
  const campaign = seedCampaign(db, owner.id, 'Stopped campaign', mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'archived', status_reason = 'STOPPED' WHERE id = ?").run(campaign.id)

  // Drive the real router, because the hole was that ONE route guarded this
  // and the other did not. Testing the guarded one proved nothing.
  const express = (await import('express')).default
  const { api } = await import('../server/routes.js')
  const { authRouter } = await import('../server/auth.js')
  const app = express()
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

  const login = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner.email }),
  })
  const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
  assert.ok(cookie, 'signed in')

  const res = await fetch(`${base}/api/campaigns/${campaign.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'running' }),
  })
  const body = await res.json().catch(() => ({}))
  await new Promise((r) => server.close(r))

  assert.equal(res.status, 409, `restart refused, got ${res.status} ${JSON.stringify(body)}`)
  assert.equal(body.code, 'CAMPAIGN_STOPPED')

  const after = db.prepare('SELECT status, status_reason FROM campaigns WHERE id = ?').get(campaign.id)
  assert.equal(after.status, 'archived', 'and it stayed stopped')
  assert.equal(after.status_reason, 'STOPPED', 'the reason was not quietly cleared')
})

// ---- the approval route, driven over real HTTP -------------------------------

// A `ReferenceError` in the approve handler shipped while the whole suite was
// green, because every approval test until now exercised `drafts.js` directly
// or mounted modules bare — nothing drove `POST /api/drafts/:id/approve`
// through the real router. A missing import is invisible to a test that never
// executes the line.
test('approving a draft works, and refuses a recipient who has since been suppressed', async () => {
  const express = (await import('express')).default
  const { api } = await import('../server/routes.js')
  const { authRouter } = await import('../server/auth.js')

  const mailbox = seedMailbox(db, owner.id, 'approve@example.com')
  const campaign = seedCampaign(db, owner.id, 'Approval campaign', mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)

  const ok = seedLead(db, owner.id, 'fine@allowed.test')
  const blocked = seedLead(db, owner.id, 'later@blocked-after.test')
  for (const lead of [ok, blocked]) {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'waiting')")
      .run(campaign.id, lead.id)
    db.prepare(
      `INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status)
       VALUES (?, ?, ?, 'A', 'Hello', 'Body', 'pending')`
    ).run(owner.id, campaign.id, lead.id)
  }
  const draftId = (lead) => db.prepare('SELECT id FROM drafts WHERE lead_id = ?').get(lead.id).id

  const app = express()
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
  const login = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner.email }),
  })
  const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]

  const approve = (id) => fetch(`${base}/api/drafts/${id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
  })

  // The happy path — this is the assertion the ReferenceError would fail.
  const good = await approve(draftId(ok))
  const goodBody = await good.json().catch(() => ({}))
  assert.equal(good.status, 200, `approval succeeds, got ${good.status} ${JSON.stringify(goodBody)}`)

  // Blocked between composing and approving: the queue must stop offering it.
  db.prepare(
    "INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, 'blocked-after.test', 1, 'manual')"
  ).run(owner.id)
  // Approving the first draft ran a tick, and the tick paused this campaign
  // because its playbook is empty — correct behaviour, but it would mask the
  // check under test behind a 400 about the campaign's status.
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)
  const refused = await approve(draftId(blocked))
  const refusedBody = await refused.json().catch(() => ({}))
  await new Promise((r) => server.close(r))

  assert.equal(refused.status, 409, `suppressed approval refused, got ${refused.status} ${JSON.stringify(refusedBody)}`)
  assert.equal(refusedBody.code, 'SUPPRESSED')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM drafts WHERE lead_id = ?').get(blocked.id).n, 0,
    'and the draft is withdrawn rather than left approvable'
  )
})
