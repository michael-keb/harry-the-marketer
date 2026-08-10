// Mailbox fleet management and sender health — server/parity/mailboxes.js.
//
// The things worth proving here are the ones a support ticket would be about:
// the fleet list tells the truth and can be filtered down to the one broken
// mailbox; suspension really does take a mailbox out of every send path and
// really does come back; warm-up settings cannot be used to lift the daily cap;
// the warm-up chart has no holes in it; and no secret ever leaves the server.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedMailbox, seedCampaign, mount } from './helpers/parity-harness.js'

setup('mailboxes')                 // MUST precede any ../server import
const { db } = await import('../server/db.js')
const { register, sendableMailboxes, reputationScore, sanitizeSignature } = await import('../server/parity/mailboxes.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

const DAY = 86_400_000
const isoDay = (offset = 0) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const sqlTime = (offset = 0) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 19).replace('T', ' ')

// A Gmail mailbox with a chosen connection date, so the pacing ramp is at a
// known point. `daysAgo: 6` puts it mid-ramp; 60 puts it at full volume.
function seedGmail(wsId, address, { daysAgo = 0, limit = 50, secret = '' } = {}) {
  const info = db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, daily_limit, created_at, access_token, refresh_token)
     VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?)`
  ).run(wsId, address, address.split('@')[0], limit, sqlTime(-daysAgo), secret, secret)
  return db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(info.lastInsertRowid)
}

const eventsFor = (type) =>
  db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = ?').get(owner.id, type).n

// The fleet fixture, shared by the listing and filtering tests.
const healthy = seedGmail(owner.id, 'healthy@example.com', { daysAgo: 60 })
const ramping = seedGmail(owner.id, 'ramping@example.com', { daysAgo: 6, secret: 'ULTRA-SECRET-TOKEN' })
const broken = seedGmail(owner.id, 'broken@example.com', { daysAgo: 60 })
db.prepare("UPDATE mailboxes SET status = 'error', last_error = 'Token revoked by user', refresh_token = '' WHERE id = ?")
  .run(broken.id)
const sandbox = seedMailbox(db, owner.id, 'sandbox.sender@sandbox.local')
const foreign = seedGmail(stranger.id, 'not-yours@example.com', { daysAgo: 3 })

// One campaign so campaignCount and "in use" mean something.
const campaign = seedCampaign(db, owner.id, 'Q3 outbound', healthy.id)
db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)

// ---- fleet listing ----------------------------------------------------------

test('fleet list carries the documented fields for every mailbox', async () => {
  const res = await client.get('/api/mailboxes/fleet')
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 4)
  assert.equal(res.body.data.length, 4)

  const row = res.body.data.find((r) => r.fromEmail === 'healthy@example.com')
  for (const field of ['fromName', 'fromEmail', 'type', 'messagePerDay', 'dailySentCount',
    'isSmtpSuccess', 'isImapSuccess', 'campaignCount', 'tags', 'warmupDetails']) {
    assert.ok(field in row, `missing ${field}`)
  }
  assert.equal(row.type, 'GMAIL')
  assert.equal(row.messagePerDay, 50)
  assert.equal(row.campaignCount, 1)
  assert.equal(row.isSmtpSuccess, true)

  // A broken mailbox reports the specific failure text, not a bare error state.
  const bad = res.body.data.find((r) => r.fromEmail === 'broken@example.com')
  assert.equal(bad.isSmtpSuccess, false)
  assert.equal(bad.smtpFailureError, 'Token revoked by user')
  assert.equal(bad.isImapSuccess, false)

  // Another workspace's mailbox is never in the list.
  assert.equal(res.body.data.some((r) => r.fromEmail === 'not-yours@example.com'), false)
})

test('fleet list filters combine and name what emptied them', async () => {
  const brokenOnly = await client.get('/api/mailboxes/fleet?isSmtpSuccess=false')
  assert.equal(brokenOnly.body.data.length, 1)
  assert.equal(brokenOnly.body.data[0].fromEmail, 'broken@example.com')

  const unused = await client.get('/api/mailboxes/fleet?isInUse=false')
  assert.equal(unused.body.data.every((r) => r.campaignCount === 0), true)
  assert.equal(unused.body.data.length, 3)

  const gmailOnly = await client.get('/api/mailboxes/fleet?provider=gmail')
  assert.equal(gmailOnly.body.data.length, 3)

  const partial = await client.get('/api/mailboxes/fleet?q=ramp')
  assert.equal(partial.body.data.length, 1)
  assert.equal(partial.body.data[0].fromEmail, 'ramping@example.com')

  // Combined filters that match nothing say which filter emptied the list,
  // which is a different state from a workspace with no mailboxes at all.
  const empty = await client.get('/api/mailboxes/fleet?provider=gmail&q=nosuchaddress')
  assert.equal(empty.body.data.length, 0)
  assert.match(empty.body.emptyReason, /No mailboxes match/)
  assert.deepEqual(empty.body.filters, ['provider=gmail', 'matching "nosuchaddress"'])
})

test('campaign ids are joined only when asked for', async () => {
  const lean = await client.get('/api/mailboxes/fleet')
  assert.equal('campaignIds' in lean.body.data[0], false)

  const full = await client.get('/api/mailboxes/fleet?withCampaigns=true')
  const row = full.body.data.find((r) => r.fromEmail === 'healthy@example.com')
  assert.deepEqual(row.campaignIds, [campaign.id])
  assert.equal(row.campaigns[0].name, 'Q3 outbound')
})

test('a limit above the documented ceiling is refused, naming the field', async () => {
  const res = await client.get('/api/mailboxes/fleet?limit=500')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'limit')
  assert.match(res.body.message, /less than or equal to 100/)
})

test('fleet list pages without duplicating or dropping a row', async () => {
  const first = await client.get('/api/mailboxes/fleet?limit=2&offset=0')
  const second = await client.get('/api/mailboxes/fleet?limit=2&offset=2')
  assert.equal(first.body.hasMore, true)
  assert.equal(second.body.hasMore, false)
  const ids = [...first.body.data, ...second.body.data].map((r) => r.id)
  assert.equal(new Set(ids).size, 4)
})

// ---- secrets ----------------------------------------------------------------

test('no token, password or secret appears in any response body', async () => {
  const bodies = [
    await client.get('/api/mailboxes/fleet?withCampaigns=true'),
    await client.get(`/api/mailboxes/${ramping.id}?withCampaigns=true`),
    await client.get(`/api/mailboxes/${ramping.id}/warmup-stats`),
    await client.post(`/api/mailboxes/${ramping.id}/test`),
  ]
  for (const res of bodies) {
    const text = JSON.stringify(res.body)
    assert.equal(text.includes('ULTRA-SECRET-TOKEN'), false, 'raw secret leaked')
    assert.equal(text.includes(Buffer.from('ULTRA-SECRET-TOKEN').toString('base64')), false, 'base64 secret leaked')
    assert.equal(/"(password|refresh_token|access_token|refreshToken|accessToken)"/.test(text), false, 'secret key present')
  }
})

test('an SMTP add validates every field but stores no password', async () => {
  const missingName = await client.post('/api/mailboxes', { type: 'SMTP' })
  assert.equal(missingName.status, 422)
  assert.equal(missingName.body.field, 'from_name')

  const stringPort = await client.post('/api/mailboxes', {
    type: 'SMTP', from_name: 'Sales', from_email: 'sales@yourdomain.com', user_name: 'sales',
    password: 'hunter2-should-never-persist',
    smtp_host: 'smtp.yourdomain.com', smtp_port: '587', imap_host: 'imap.yourdomain.com', imap_port: 993,
  })
  assert.equal(stringPort.status, 422)
  assert.equal(stringPort.body.field, 'smtp_port')

  const valid = await client.post('/api/mailboxes', {
    type: 'SMTP', from_name: 'Sales', from_email: 'sales@yourdomain.com', user_name: 'sales',
    password: 'hunter2-should-never-persist',
    smtp_host: 'smtp.yourdomain.com', smtp_port: 587, imap_host: 'imap.yourdomain.com', imap_port: 993,
  })
  assert.equal(valid.status, 501)
  assert.equal(valid.body.stored, false)
  assert.equal(JSON.stringify(valid.body).includes('hunter2'), false)
  // Nothing was written anywhere: not a mailbox row, not an events row.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE email = 'sales@yourdomain.com'").get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE detail LIKE '%hunter2%'").get().n, 0)
})

test('a credential field on the update route is refused outright', async () => {
  const res = await client.patch(`/api/mailboxes/${healthy.id}`, { fromName: 'Nope', password: 'letmein' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'password')
  assert.match(res.body.message, /reconnect/i)
  // The legitimate field in the same body was not applied either.
  assert.equal(db.prepare('SELECT display_name d FROM mailboxes WHERE id = ?').get(healthy.id).d, 'healthy')
})

// ---- update -----------------------------------------------------------------

test('update is partial and leaves omitted fields untouched', async () => {
  const first = await client.patch(`/api/mailboxes/${healthy.id}`, {
    signature: '<p>Regards<script>steal()</script><a href="javascript:evil()">x</a></p>',
    trackingDomain: 'links.example.com',
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.data.signature.includes('script'), false)
  assert.equal(first.body.data.signature.includes('javascript:'), false)
  assert.equal(first.body.data.trackingDomain, 'links.example.com')

  const second = await client.patch(`/api/mailboxes/${healthy.id}`, { fromName: 'Sales — Harry' })
  assert.equal(second.body.data.fromName, 'Sales — Harry')
  assert.equal(second.body.data.trackingDomain, 'links.example.com', 'omitted field was wiped')
  assert.equal(second.body.data.signature.startsWith('<p>'), true)

  const nothing = await client.patch(`/api/mailboxes/${healthy.id}`, {})
  assert.equal(nothing.status, 422)
  assert.match(nothing.body.message, /Nothing to update/)

  const badDomain = await client.patch(`/api/mailboxes/${healthy.id}`, { custom_tracking_url: 'not a domain' })
  assert.equal(badDomain.status, 422)
  assert.equal(badDomain.body.field, 'custom_tracking_url')
  // The working tracking domain survived the rejected save.
  assert.equal(db.prepare('SELECT tracking_domain t FROM mailboxes WHERE id = ?').get(healthy.id).t, 'links.example.com')
})

test('raising the daily limit moves the ceiling but not today’s warm-up figure', async () => {
  const before = await client.get(`/api/mailboxes/${ramping.id}`)
  const capBefore = before.body.data.sending.cap
  assert.ok(before.body.data.warmupDetails.status === 'ACTIVE')

  const res = await client.patch(`/api/mailboxes/${ramping.id}`, { max_email_per_day: 200 })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.messagePerDay, 200)
  // The ramp is a function of the connection date, so today's figure is
  // unchanged: a limit rise can never turn a warm mailbox into a cold blast.
  assert.equal(res.body.data.sending.cap, capBefore)
  assert.ok(res.body.data.warmupDetails.warmupMaxCount > capBefore)

  // Put it back so later tests read the original 50/day fixture.
  await client.patch(`/api/mailboxes/${ramping.id}`, { max_email_per_day: 50 })
})

test('a daily limit outside the sane range is a field-level 422', async () => {
  const res = await client.patch(`/api/mailboxes/${healthy.id}`, { max_email_per_day: -5 })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'max_email_per_day')
})

// ---- suspend / unsuspend ----------------------------------------------------

test('suspend and unsuspend round-trip, idempotently', async () => {
  const suspend = await client.put(`/api/mailboxes/${broken.id}/suspend`, { reason: 'Investigating bounces' })
  assert.equal(suspend.status, 200)
  assert.equal(suspend.body.success, true)
  assert.equal(suspend.body.data.accountId, broken.id)
  assert.equal(suspend.body.data.isSuspended, true)
  assert.equal(suspend.body.data.reason, 'Investigating bounces')

  const detail = await client.get(`/api/mailboxes/${broken.id}`)
  assert.equal(detail.body.data.isSuspended, true)
  assert.equal(detail.body.data.sendable, false)
  assert.match(detail.body.data.sending.reason, /suspended — Investigating bounces/)
  // Suspension pauses warm-up rather than resetting it.
  assert.equal(detail.body.data.warmupDetails.status, 'PAUSED')

  // Suspending twice changes nothing and must not claim it did.
  const events = eventsFor('mailbox_suspended')
  const again = await client.put(`/api/mailboxes/${broken.id}/suspend`)
  assert.equal(again.status, 200)
  assert.equal(again.body.changed, false)
  assert.equal(again.body.data.isSuspended, true)
  assert.equal(eventsFor('mailbox_suspended'), events, 'a no-op wrote an activity-trail entry')

  const resume = await client.del(`/api/mailboxes/${broken.id}/suspend`)
  assert.equal(resume.status, 200)
  assert.equal(resume.body.data.isSuspended, false)
  // Resume and the connection re-check are one request; this mailbox's token is
  // still revoked, so it comes back active-but-unhealthy rather than "Connected".
  assert.equal(resume.body.connection.ok, false)
  assert.match(resume.body.connection.smtpFailureError, /Token revoked/)

  const resumeAgain = await client.del(`/api/mailboxes/${broken.id}/suspend`)
  assert.equal(resumeAgain.body.changed, false)
})

test('a suspended mailbox is excluded from the sendable fleet', async () => {
  const before = sendableMailboxes(owner.id).map((m) => m.email)
  assert.ok(before.includes('healthy@example.com'))

  await client.put(`/api/mailboxes/${healthy.id}/suspend`, { reason: 'Deliverability check' })

  const after = sendableMailboxes(owner.id).map((m) => m.email)
  assert.equal(after.includes('healthy@example.com'), false)

  const list = await client.get('/api/mailboxes/fleet?sendable=true')
  assert.equal(list.body.data.some((r) => r.fromEmail === 'healthy@example.com'), false)
  // It is excluded from sending, not detached: the campaign still has it.
  const row = (await client.get(`/api/mailboxes/${healthy.id}`)).body.data
  assert.equal(row.campaignCount, 1)
})

test('a campaign whose only mailbox is suspended reports why it is holding', async () => {
  const detail = await client.get(`/api/mailboxes/${healthy.id}`)
  const held = detail.body.data.deleteImpact.wouldHold
  assert.equal(held.length, 1)
  assert.equal(held[0].campaignId, campaign.id)
  assert.match(held[0].reason, /holding — suspended — Deliverability check/)
  assert.match(held[0].reason, /healthy@example\.com/)

  // Resuming clears it.
  await client.del(`/api/mailboxes/${healthy.id}/suspend`)
  const after = await client.get(`/api/mailboxes/${healthy.id}`)
  assert.deepEqual(after.body.data.deleteImpact.wouldHold, [])
  assert.equal(after.body.data.sendable, true)
})

// ---- warm-up settings -------------------------------------------------------

test('warm-up settings reject every out-of-range value, naming the field', async () => {
  const cases = [
    [{ total_warmup_per_day: 80 }, 'total_warmup_per_day'],
    [{ total_warmup_per_day: 0 }, 'total_warmup_per_day'],
    [{ daily_rampup: 2 }, 'daily_rampup'],
    [{ daily_rampup: 40 }, 'daily_rampup'],
    [{ reply_rate_percentage: 10 }, 'reply_rate_percentage'],
    [{ reply_rate_percentage: 140 }, 'reply_rate_percentage'],
  ]
  for (const [body, field] of cases) {
    const res = await client.put(`/api/mailboxes/${ramping.id}/warmup`, body)
    assert.equal(res.status, 422, `${JSON.stringify(body)} was accepted`)
    assert.equal(res.body.field, field)
  }
})

test('warm-up volume can never exceed the mailbox’s own daily limit', async () => {
  const small = seedGmail(owner.id, 'small-limit@example.com', { daysAgo: 60, limit: 30 })
  const res = await client.put(`/api/mailboxes/${small.id}/warmup`, {
    warmup_enabled: true, total_warmup_per_day: 50,
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'total_warmup_per_day')
  assert.match(res.body.message, /daily limit of 30/)
})

test('warm-up does not apply to sandbox mailboxes', async () => {
  const res = await client.put(`/api/mailboxes/${sandbox.id}/warmup`, { enabled: true, dailyCount: 20 })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'warmup')
  assert.match(res.body.message, /sandbox/)

  const stats = await client.get(`/api/mailboxes/${sandbox.id}/warmup-stats`)
  assert.equal(stats.status, 200)
  assert.equal(stats.body.warmupRunning, false)
  assert.deepEqual(stats.body.dailyStats, [], 'zeros were presented as measurements')
})

test('warm-up settings save and stay under the pacing cap', async () => {
  const res = await client.put(`/api/mailboxes/${ramping.id}/warmup`, {
    warmup_enabled: true, total_warmup_per_day: 20, daily_rampup: 5,
    reply_rate_percentage: 30, is_rampup_enabled: true,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.message, 'Warmup settings updated successfully')
  assert.equal(res.body.data.dailyCount, 20)
  assert.equal(res.body.data.targetReplyRate, 30)
  // The daily cap is the binding constraint: warm-up can only lower it.
  assert.ok(res.body.data.effectiveDailyCap <= res.body.data.pacingCap)
  assert.equal(res.body.data.effectiveDailyCap, Math.min(20, res.body.data.pacingCap))
  assert.equal(res.body.warmupDetails.status, 'ACTIVE')

  // Partial: changing only the reply rate leaves the daily count alone.
  const partial = await client.put(`/api/mailboxes/${ramping.id}/warmup`, { reply_rate_percentage: 40 })
  assert.equal(partial.body.data.dailyCount, 20)
  assert.equal(partial.body.data.targetReplyRate, 40)
})

// The panel used to answer `healthy: true` for a mailbox with `daysOfHistory: 0`
// — a verdict assembled entirely from the absence of data, on a table that at
// the time had no writer at all. These two prove the verdict now follows the
// evidence in both directions.
test('a mailbox with no warm-up history is reported as unmeasured, not as healthy', async () => {
  const fresh = seedGmail(owner.id, 'no-history@example.com', { daysAgo: 2 })
  const res = await client.get(`/api/mailboxes/${fresh.id}/warmup-stats`)

  assert.equal(res.status, 200)
  assert.equal(res.body.warmupRunning, true)
  assert.equal(res.body.daysOfHistory, 0)
  assert.equal(res.body.enoughData, false)
  assert.equal(res.body.guidance.healthy, null, 'a verdict from no data is not a verdict')
  assert.equal(res.body.guidance.verdict, 'not_enough_data')
  assert.match(res.body.guidance.summary, /Not enough history yet/)
  assert.deepEqual(res.body.guidance.actions, [], 'nothing to act on when nothing is known')
  // The dense series is still dense — a chart with holes reads as breakage —
  // but every row in it is a zero the response has just disclaimed.
  assert.equal(res.body.dailyStats.length, 7)
  assert.equal(res.body.dailyStats.every((d) => d.sent === 0), true)
})

test('once real rows exist the verdict follows them, and names what the spam figure counts', async () => {
  const measured = seedGmail(owner.id, 'measured@example.com', { daysAgo: 20 })
  // Past Harry's own ramp, so warm-up is running because the user asked for it.
  db.prepare('UPDATE mailboxes SET warmup_enabled = 1 WHERE id = ?').run(measured.id)
  const day = (back) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10)
  // A clean day: forty sends, none rejected, ten replies.
  db.prepare(
    'INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox, reply_rate) VALUES (?, ?, 40, 10, 0, 40, 25)'
  ).run(measured.id, day(1))

  const good = await client.get(`/api/mailboxes/${measured.id}/warmup-stats`)
  assert.equal(good.body.daysOfHistory, 1)
  assert.equal(good.body.enoughData, true)
  assert.equal(good.body.guidance.healthy, true)
  assert.equal(good.body.guidance.verdict, 'healthy')
  assert.equal(good.body.spamSource, 'bounces', 'the field says which signal it is, not just a number')

  // A bad day: six of forty came back, well past the 2% guidance.
  db.prepare(
    'INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox, reply_rate) VALUES (?, ?, 40, 2, 6, 34, 5)'
  ).run(measured.id, day(2))

  const bad = await client.get(`/api/mailboxes/${measured.id}/warmup-stats`)
  assert.equal(bad.body.enoughData, true)
  assert.equal(bad.body.guidance.healthy, false)
  assert.equal(bad.body.guidance.verdict, 'needs_attention')
  assert.ok(bad.body.guidance.spamRatePct > bad.body.guidance.spamThresholdPct)
  assert.ok(bad.body.guidance.actions.includes('Check SPF, DKIM and DMARC for this domain'))
})

test('the reputation formula is reproducible from fixed inputs', () => {
  assert.equal(reputationScore({ sent: 0, inbox: 0, spam: 0, received: 0 }), null)
  assert.equal(reputationScore({ sent: 100, inbox: 100, spam: 0, received: 30 }, 30), 100)
  assert.equal(reputationScore({ sent: 100, inbox: 100, spam: 0, received: 0 }, 30), 60)
  assert.equal(reputationScore({ sent: 100, inbox: 90, spam: 10, received: 30 }, 30), 74)
})

test('signature sanitising keeps the safe tags and drops the rest', () => {
  assert.equal(sanitizeSignature('<p>Hi</p><script>x()</script>'), '<p>Hi</p>')
  assert.equal(sanitizeSignature('<a href="https://x.test">x</a>'), '<a href="https://x.test" rel="noopener noreferrer">x</a>')
  assert.equal(sanitizeSignature('<a href="javascript:x()">x</a>'), '<a>x</a>')
  assert.equal(sanitizeSignature('<div onclick="x()">hi</div>'), '<div>hi</div>')
})

// ---- warm-up statistics -----------------------------------------------------

test('warm-up statistics come back as a dense date series', async () => {
  await client.put(`/api/mailboxes/${ramping.id}/warmup`, { warmup_enabled: true, total_warmup_per_day: 20 })
  // Two days of activity four days apart: the gap between them must come back
  // as zero rows, not as missing buckets.
  const insert = db.prepare(
    'INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox, reply_rate) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insert.run(ramping.id, isoDay(0), 20, 6, 2, 18, 30)
  insert.run(ramping.id, isoDay(-4), 10, 3, 0, 10, 30)

  const res = await client.get(`/api/mailboxes/${ramping.id}/warmup-stats?days=7&timezone=UTC`)
  assert.equal(res.status, 200)
  assert.equal(res.body.warmupRunning, true)
  assert.equal(res.body.dailyStats.length, 7, 'series is not dense')

  // Contiguous, ascending, no repeats, ending today.
  const dates = res.body.dailyStats.map((d) => d.date)
  assert.equal(new Set(dates).size, 7)
  assert.equal(dates[6], isoDay(0))
  for (let i = 1; i < dates.length; i += 1) {
    const gap = (Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)) / DAY
    assert.equal(gap, 1, `gap of ${gap} days before ${dates[i]}`)
  }

  // The quiet days are zero rows carrying every key, not holes.
  const quiet = res.body.dailyStats.filter((d) => d.date !== isoDay(0) && d.date !== isoDay(-4))
  assert.equal(quiet.length, 5)
  for (const d of quiet) {
    assert.deepEqual(
      { sent: d.sent, delivered: d.delivered, spam: d.spam, opened: d.opened, replied: d.replied },
      { sent: 0, delivered: 0, spam: 0, opened: 0, replied: 0 }
    )
  }

  assert.equal(res.body.totalSent, 30)
  assert.equal(res.body.spamCount, 2)
  assert.equal(res.body.daysOfHistory, 2)
  // The threshold is stated in words, with the actions the docs name.
  assert.ok(res.body.guidance.spamRatePct > res.body.guidance.spamThresholdPct)
  assert.equal(res.body.guidance.healthy, false)
  assert.ok(res.body.guidance.actions.some((a) => /SPF, DKIM and DMARC/.test(a)))
})

test('warm-up statistics say so honestly when warm-up is not running', async () => {
  const res = await client.get(`/api/mailboxes/${healthy.id}/warmup-stats`)
  assert.equal(res.status, 200)
  assert.equal(res.body.warmupRunning, false)
  assert.equal(res.body.status, 'INACTIVE')
  assert.deepEqual(res.body.dailyStats, [])
  assert.match(res.body.message, /not running/)
})

// ---- tags -------------------------------------------------------------------

test('the mailbox tag list is the master list, including unattached labels', async () => {
  db.prepare("INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'mailbox', 'Winners', '#b1fccf')")
    .run(owner.id)
  db.prepare("INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'lead', 'VIP', '#4f46e5')")
    .run(owner.id)
  db.prepare("INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'mailbox', 'Theirs', '#000000')")
    .run(stranger.id)

  const res = await client.get('/api/mailboxes/tags')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.map((t) => t.name), ['Winners'])
  assert.equal(res.body.data[0].mailboxCount, 0, 'an unattached label was hidden')

  // Attaching it makes it filterable on the fleet list.
  const tagId = res.body.data[0].id
  db.prepare('INSERT INTO mailbox_tag_map (workspace_id, mailbox_id, tag_id) VALUES (?, ?, ?)')
    .run(owner.id, healthy.id, tagId)
  const filtered = await client.get(`/api/mailboxes/fleet?tagId=${tagId}`)
  assert.equal(filtered.body.data.length, 1)
  assert.equal(filtered.body.data[0].tags[0].name, 'Winners')
})

// ---- isolation and id validation --------------------------------------------

test('a mailbox from another workspace 404s everywhere and leaks nothing', async () => {
  const calls = [
    await client.get(`/api/mailboxes/${foreign.id}`),
    await client.patch(`/api/mailboxes/${foreign.id}`, { fromName: 'Mine now' }),
    await client.put(`/api/mailboxes/${foreign.id}/suspend`),
    await client.del(`/api/mailboxes/${foreign.id}/suspend`),
    await client.put(`/api/mailboxes/${foreign.id}/warmup`, { enabled: true }),
    await client.get(`/api/mailboxes/${foreign.id}/warmup-stats`),
    await client.post(`/api/mailboxes/${foreign.id}/test`),
  ]
  for (const res of calls) {
    assert.equal(res.status, 404)
    assert.equal(JSON.stringify(res.body).includes('not-yours@example.com'), false)
  }
  // Nothing was changed on the way past.
  const untouched = db.prepare('SELECT display_name d, is_suspended s FROM mailboxes WHERE id = ?').get(foreign.id)
  assert.equal(untouched.d, 'not-yours')
  assert.equal(untouched.s, 0)
})

test('a non-numeric id is a validation failure, not a lookup', async () => {
  for (const path of ['', '/warmup-stats']) {
    const res = await client.get(`/api/mailboxes/abc${path}`)
    assert.equal(res.status, 422)
    assert.equal(res.body.field, 'id')
  }
  const suspend = await client.put('/api/mailboxes/abc/suspend')
  assert.equal(suspend.status, 422)
  assert.equal(suspend.body.field, 'id')
})

// ---- adding a mailbox -------------------------------------------------------

test('connecting Gmail never writes a row from the request body', async () => {
  // Whether Google is configured depends on the machine's .env, so both paths
  // are asserted: honest degradation naming the missing variable, or a redirect
  // into the consent flow. Neither creates a mailbox from posted data, and
  // neither accepts a token — OAuth belongs to server/google.js.
  const res = await client.post('/api/mailboxes', { type: 'GMAIL', from_email: 'new@example.com' })
  if (res.status === 503) {
    assert.equal(res.body.configured, false)
    assert.equal(res.body.errorCode, 'GOOGLE_NOT_CONFIGURED')
    assert.ok(res.body.missing.length > 0)
    assert.match(res.body.message, /GOOGLE_CLIENT_(ID|SECRET)/)
  } else {
    assert.equal(res.status, 200)
    assert.equal(res.body.next, 'consent')
    // The consent URL may carry the address as a reconnect hint (?email=…);
    // what matters is that it points into the OAuth flow and nothing else.
    assert.ok(String(res.body.consentUrl).startsWith('/api/google/connect'))
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE email = 'new@example.com'").get().n, 0)

  const withToken = await client.post('/api/mailboxes', {
    type: 'GMAIL', from_email: 'new@example.com', refresh_token: 'should-be-refused',
  })
  assert.equal(withToken.status, 422)
  assert.equal(withToken.body.field, 'refresh_token')
})

test('an unknown provider type is a field-level 422', async () => {
  const res = await client.post('/api/mailboxes', { type: 'YAHOO' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'type')
})

test('a sandbox mailbox can be added and refuses a duplicate', async () => {
  const res = await client.post('/api/mailboxes', { type: 'SANDBOX', fromName: 'Test Sender' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.fromEmail, 'test.sender@sandbox.local')
  assert.equal(res.body.data.type, 'SANDBOX')
  assert.equal(res.body.data.warmupDetails.appliesTo, false)

  const again = await client.post('/api/mailboxes', { type: 'SANDBOX', fromName: 'Test Sender' })
  assert.equal(again.status, 409)
})
