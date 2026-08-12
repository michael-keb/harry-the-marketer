// Placement tests that actually happen.
//
// server/parity/deliverability.js built the whole surface — 28 routes, the
// tables, the reports, the schedule — and then stopped at the edge of the tick
// loop, exactly as the other parity features did. The result was worse than
// missing, because it was *confident*: POST /tests/manual answered "1 seed
// send(s) queued through the normal sending rhythm" and queued nothing. No
// `messages` row, `send_status` stuck on `pending` forever, `sent_today`
// unmoved, and `current_run_no` on an automated schedule stuck at 0 for the
// life of the test. Work reported as queued that no code path could ever
// perform is the defect this file exists to remove.
//
// Three rules, all of which the surface already promised in prose:
//
//   1. **A seed is a real send.** It goes through `server/mailer.js` like every
//      other email, so it inherits the suppression check, the daily allowance,
//      the working-hours window and the send telemetry. Nothing here calls
//      `gmailSend` directly; a send path that goes around the mailer is a send
//      path that forgets the never-contact list.
//   2. **A seed is not outreach.** The row the mailer writes is stamped
//      `send_status = 'test'` the moment it exists, which is the value
//      `metrics.js` REAL_SEND already excludes. Running a placement test must
//      not move a single campaign figure.
//   3. **Nothing is claimed that was not observed.** With no deliverability
//      provider and no reachable seed inbox, Harry can watch a seed leave and
//      cannot watch it land. So `send_status` is driven all the way to a
//      terminal value and `placement` is written only where the outcome is
//      actually known — a send that never left is `missing`; a send that left
//      stays blank until something reports where it went. A fabricated
//      `inbox` would be the same lie in a new column.

import { db, logEvent } from './db.js'
import { recordTelemetry } from './telemetry.js'
import { sendEmail, SuppressedError } from './mailer.js'
import { canSendNow } from './pacing.js'
import { parsePlaybook } from './playbook.js'
import { composeStepSample, exampleLead } from './ai.js'

// Bounded per tick for the same reason dispatchScheduled is: the tick runs
// every 20 seconds and a job that tries to drain an unbounded queue holds the
// pass open while the engine waits behind it.
const SEED_BATCH = 20
const SCHEDULE_BATCH = 25

// `send_status` on deliverability_test_senders. The column has no CHECK
// constraint, so the vocabulary is written down here instead.
//
//   awaiting_seeds — no seed inbox to send to. Deliberately NOT `pending`:
//                    pending is a promise the tick would keep, and there is
//                    nothing here for it to keep.
//   pending        — a seed address exists and the tick will send to it.
//   sending        — claimed by a tick. The claim is what stops two overlapping
//                    passes sending the same seed twice.
//   sent / failed / suppressed — terminal.
export const SEED_STATUS = {
  awaiting: 'awaiting_seeds',
  pending: 'pending',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  suppressed: 'suppressed',
}

const TERMINAL = new Set([SEED_STATUS.sent, SEED_STATUS.failed, SEED_STATUS.suppressed])

// SQLite writes `datetime('now')` as 'YYYY-MM-DD HH:MM:SS' in UTC with no zone
// marker, which Date.parse reads as local time. Every comparison against a
// stored timestamp goes through here so that mistake is made in one place and
// then not made.
function sqlTimeMs(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
  return Number.isFinite(ms) ? ms : 0
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// The fields the schema has no column for — campaign, sequence step, provider
// id, description and the user's own seed inboxes — live in the `setup` cache
// row that deliverability.js writes at create time. One reader, here, so the
// schedule job and the send job cannot disagree about what a test was for.
export function setupOf(testId) {
  const row = db.prepare(
    "SELECT payload FROM deliverability_reports WHERE test_id = ? AND run_no = 1 AND kind = 'setup' AND ref = ''"
  ).get(testId)
  try {
    const parsed = JSON.parse(row?.payload || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function seedEmailsOf(testId) {
  const seeds = setupOf(testId).seedEmails
  return Array.isArray(seeds) ? seeds.filter(Boolean).map(String) : []
}

// ---------------------------------------------------------------------------
// sender rows
// ---------------------------------------------------------------------------

// One row per (sending mailbox × seed inbox), because that is the pair a
// placement result is about: "mail from A landed in B's spam folder" is not
// answerable by a row that names only A.
//
// Shared by the create routes and by the schedule job below, so run 1 and run 7
// of the same test are built by the same code.
export function createRunSenders({ testId, wsId, runNo, mailboxIds, seedEmails, providerId = '' }) {
  const ins = db.prepare(
    `INSERT INTO deliverability_test_senders
       (test_id, run_no, mailbox_id, sender_email, seed_email, provider_id, send_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const find = db.prepare('SELECT email FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
  let queued = 0
  for (const mailboxId of mailboxIds) {
    const mailbox = find.get(mailboxId, wsId)
    const from = mailbox ? mailbox.email : ''
    if (!seedEmails.length) {
      // Still one row per mailbox, so the sender list and the reply-header
      // lookup answer as they always did — but labelled with the reason rather
      // than with a state that implies a send is coming.
      ins.run(testId, runNo, mailboxId, from, '', providerId, SEED_STATUS.awaiting)
      continue
    }
    for (const seed of seedEmails) {
      ins.run(testId, runNo, mailboxId, from, seed, providerId, SEED_STATUS.pending)
      queued += 1
    }
  }
  return queued
}

// A run whose sends cannot start is not 'running'. The history view reads this
// string directly, and "running" on a test that will never move is the same
// class of untruth as `seedsQueued: 1` on a test that sends nothing.
export function runStatusFor(seedCount) {
  return seedCount ? 'running' : SEED_STATUS.awaiting
}

// ---------------------------------------------------------------------------
// the schedule
// ---------------------------------------------------------------------------

// Is this automated test due for its next run?
//
// Due-ness is measured from the LAST RUN'S start, not from `schedule_start_time`
// plus N × every_days. That is deliberate: a workspace whose server was off for
// a month would otherwise owe four runs and fire one per 20-second tick until
// it caught up — the "replayed in a storm" the spec's definition of done rules
// out. Measuring from the last run means a missed cadence is caught up exactly
// once and then resumes.
function nextRunDue(test, now) {
  const last = db.prepare(
    'SELECT started_at FROM deliverability_test_runs WHERE test_id = ? ORDER BY run_no DESC LIMIT 1'
  ).get(test.id)
  if (!last) return true
  const startedAt = sqlTimeMs(last.started_at)
  if (!startedAt) return false
  return now - startedAt >= Math.max(1, test.every_days || 1) * 86_400_000
}

// Open the runs that have come due, and retire the schedules that have ended.
export async function openDueRuns(now = Date.now()) {
  const nowIso = new Date(now).toISOString()
  const candidates = db.prepare(
    `SELECT * FROM deliverability_tests
      WHERE type = 'automated' AND status = 'active' AND COALESCE(deleted_at, '') = ''
        AND schedule_start_time != '' AND schedule_start_time <= ?
      ORDER BY id LIMIT ?`
  ).all(nowIso, SCHEDULE_BATCH)
  if (!candidates.length) return {}

  let opened = 0
  let ended = 0
  for (const test of candidates) {
    // Past its end date: the schedule is over, and saying so is the job too.
    if (test.test_end_date && test.test_end_date <= nowIso) {
      const closed = db.prepare(
        "UPDATE deliverability_tests SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).run(test.id).changes
      if (closed) {
        ended += 1
        logEvent(test.workspace_id, {
          type: 'deliverability_test_completed',
          detail: `${test.name} (#${test.id}) reached its end date after ${test.current_run_no} run(s)`,
        })
      }
      continue
    }
    if (!nextRunDue(test, now)) continue

    // Claim the run by advancing the counter conditionally on the value we
    // read. An overlapping tick sees `changes === 0` and walks away, which is
    // what makes "the tick runs a due schedule exactly once even if two ticks
    // overlap" true rather than hoped for.
    const runNo = test.current_run_no + 1
    const claimed = db.prepare(
      "UPDATE deliverability_tests SET current_run_no = ?, updated_at = datetime('now') WHERE id = ? AND current_run_no = ?"
    ).run(runNo, test.id, test.current_run_no).changes
    if (!claimed) continue

    const seedEmails = seedEmailsOf(test.id)
    const mailboxIds = jsonArray(test.mailbox_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)

    db.prepare(
      'INSERT OR IGNORE INTO deliverability_test_runs (test_id, run_no, status) VALUES (?, ?, ?)'
    ).run(test.id, runNo, runStatusFor(seedEmails.length))
    const queued = createRunSenders({
      testId: test.id,
      wsId: test.workspace_id,
      runNo,
      mailboxIds,
      seedEmails,
      providerId: setupOf(test.id).providerId || '',
    })

    // Settle the status against what was actually queued, not against what was
    // asked for. `createRunSenders` writes one row per (mailbox × seed), so a
    // schedule with seed inboxes but no mailbox attached queues nothing — and
    // the seed count alone said 'running'. That left a run marked live that no
    // code path could ever move, which is the same class of untruth this file's
    // header exists to rule out. The count is only known after the call, so the
    // status is corrected after it.
    db.prepare('UPDATE deliverability_test_runs SET status = ? WHERE test_id = ? AND run_no = ? AND status != ?')
      .run(runStatusFor(queued), test.id, runNo, 'completed')

    logEvent(test.workspace_id, {
      type: 'deliverability_test_run_started',
      detail: queued
        ? `${test.name} (#${test.id}) run ${runNo}: ${queued} seed send(s) queued`
        : `${test.name} (#${test.id}) run ${runNo} opened with no seed inboxes — nothing to send`,
    })
    recordTelemetry('deliverability', { op: 'run_opened', ok: true, detail: `test ${test.id} run ${runNo} seeds ${queued}` })
    opened += 1
  }

  const parts = []
  if (opened) parts.push(`${opened} placement run(s) opened`)
  if (ended) parts.push(`${ended} schedule(s) reached their end date`)
  return { did: parts.join('; ') }
}

// ---------------------------------------------------------------------------
// the sends
// ---------------------------------------------------------------------------

// What the seed actually says.
//
// When the test names a campaign and one of its Send steps, the seed carries
// that step's own copy — a placement test on content the campaign will never
// send proves nothing about the campaign. `exampleLead` is the same neutral
// stand-in the campaign test-send route uses, so no real prospect's details
// leave the building in a test email. If anything about that fails, the seed
// still goes: a plain, clearly-labelled body is worth more than no test.
async function composeSeed(test, setup) {
  const fallback = {
    subject: `[Placement test] ${test.name}`,
    body:
      `This is an inbox-placement seed sent by Harry.\n\n` +
      `Test: ${test.name} (#${test.id}), run ${test.current_run_no || 1}.\n` +
      `Nothing is expected in reply — it is here so you can see which folder it landed in.`,
    campaign: null,
  }
  if (!setup.campaignId) return fallback

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?')
    .get(setup.campaignId, test.workspace_id)
  if (!campaign) return fallback
  if (!setup.sequenceStepId) return { ...fallback, campaign }

  try {
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(test.workspace_id)
    const graph = parsePlaybook(campaign.mermaid || '')
    const composed = await composeStepSample({
      graph,
      nodeId: setup.sequenceStepId,
      lead: exampleLead(null),
      businessContext: owner?.business_context || '',
      senderName: owner?.name || '',
      meetingLink: owner?.meeting_link || '',
      workspaceId: test.workspace_id,
    })
    return { subject: composed.subject, body: composed.body, campaign }
  } catch (err) {
    recordTelemetry('deliverability', {
      op: 'seed_compose', ok: false, detail: String(err?.message || err).slice(0, 160),
    })
    return { ...fallback, campaign }
  }
}

function settle(senderId, status, placement = '') {
  db.prepare('UPDATE deliverability_test_senders SET send_status = ?, placement = ? WHERE id = ?')
    .run(status, placement, senderId)
}

// Send the seeds that are due, one claimed row at a time.
export async function dispatchSeedSends(now = Date.now()) {
  const due = db.prepare(
    `SELECT s.*, t.workspace_id, t.name AS test_name, t.current_run_no
       FROM deliverability_test_senders s
       JOIN deliverability_tests t ON t.id = s.test_id
      WHERE s.send_status = ? AND s.seed_email != ''
        AND t.status = 'active' AND COALESCE(t.deleted_at, '') = ''
      ORDER BY s.id LIMIT ?`
  ).all(SEED_STATUS.pending, SEED_BATCH)
  if (!due.length) return settleRuns()

  // One compose per test per pass rather than one per seed: every seed in a run
  // is the same email to a different inbox, and composing it ten times would be
  // ten model calls for one result.
  const composed = new Map()
  let sent = 0

  for (const row of due) {
    const claimed = db.prepare(
      'UPDATE deliverability_test_senders SET send_status = ? WHERE id = ? AND send_status = ?'
    ).run(SEED_STATUS.sending, row.id, SEED_STATUS.pending).changes
    if (!claimed) continue

    const mailbox = row.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(row.mailbox_id)
      : null
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.workspace_id)

    // No mailbox left to send from, or it has been taken out of service. The
    // copy is not coming — and `missing` is the enum's word for exactly that.
    if (!mailbox || !user || mailbox.is_suspended) {
      settle(row.id, SEED_STATUS.failed, 'missing')
      continue
    }

    // The sending rhythm applies to a seed as much as to a prospect: a
    // placement test that fires outside working hours or past the daily cap is
    // testing a pattern the campaign will never use. Not a failure — put it
    // back and let a later tick take it.
    const gate = canSendNow(user, mailbox, now)
    if (!gate.ok) {
      db.prepare('UPDATE deliverability_test_senders SET send_status = ? WHERE id = ? AND send_status = ?')
        .run(SEED_STATUS.pending, row.id, SEED_STATUS.sending)
      continue
    }

    if (!composed.has(row.test_id)) {
      const test = db.prepare('SELECT * FROM deliverability_tests WHERE id = ?').get(row.test_id)
      composed.set(row.test_id, await composeSeed(test, setupOf(row.test_id)))
    }
    const seed = composed.get(row.test_id)

    // No campaign named? Then the message row carries none. `sendEmail` only
    // reads `user_id` off it for the suppression check and the two tracking
    // flags, and a seed wants neither pixel nor rewritten link — those change
    // what a spam filter sees, which is the very thing being measured.
    const campaign = seed.campaign || {
      id: null, user_id: row.workspace_id, track_opens: 0, track_clicks: 0,
    }

    try {
      const result = await sendEmail({
        mailbox,
        user,
        campaign,
        // A seed inbox is not a lead and must never become one. `sendEmail`
        // reads only `id` and `email`, and a null id keeps the message row out
        // of every per-lead figure in the product.
        lead: { id: null, email: row.seed_email },
        nodeId: '',
        subject: seed.subject,
        body: seed.body,
      })

      // Stamped immediately, on the row the mailer just wrote. `test` is the
      // value metrics.js REAL_SEND already excludes, so a placement test cannot
      // move a campaign's sent count, open rate or reply rate.
      db.prepare("UPDATE messages SET send_status = 'test' WHERE provider_message_id = ?")
        .run(result.providerMessageId)

      // Left the building. Where it landed is a different question, and one
      // nothing here can answer — so `placement` stays empty rather than
      // guessing `inbox`.
      settle(row.id, SEED_STATUS.sent, '')
      sent += 1
    } catch (err) {
      const suppressed = err instanceof SuppressedError
      settle(row.id, suppressed ? SEED_STATUS.suppressed : SEED_STATUS.failed, 'missing')
      logEvent(row.workspace_id, {
        type: suppressed ? 'send_suppressed' : 'error',
        detail: suppressed
          ? `placement seed to ${row.seed_email} cancelled — ${err.message}`
          : `placement seed to ${row.seed_email} failed: ${String(err?.message || err).slice(0, 160)}`,
      })
      recordTelemetry('deliverability', {
        op: 'seed_send', ok: false, detail: String(err?.message || err).slice(0, 160),
      })
    }
  }

  const closed = settleRuns()
  const parts = []
  if (sent) parts.push(`${sent} placement seed(s) sent`)
  if (closed.did) parts.push(closed.did)
  return { did: parts.join('; ') }
}

// ---------------------------------------------------------------------------
// closing a run
// ---------------------------------------------------------------------------

// A run is finished when none of its seeds are still waiting or in flight.
//
// The metrics written here are deliberately Harry's own key names, not the
// provider's. Writing `inboxCount: 0` and `adjustedTotalEmailCount: 10` would
// make the history view compute a 0% inbox rate and plot it as a trend — a
// measurement invented from the absence of one. `placementObserved` says how
// many seeds anything actually reported a folder for, which is zero until a
// provider does.
export function settleRuns() {
  const open = db.prepare(
    `SELECT r.test_id, r.run_no, t.type, t.name, t.workspace_id
       FROM deliverability_test_runs r
       JOIN deliverability_tests t ON t.id = r.test_id
      WHERE r.status = 'running' AND COALESCE(t.deleted_at, '') = ''`
  ).all()
  if (!open.length) return {}

  let closed = 0
  for (const run of open) {
    const rows = db.prepare(
      'SELECT send_status, placement FROM deliverability_test_senders WHERE test_id = ? AND run_no = ?'
    ).all(run.test_id, run.run_no)
    if (!rows.length) continue
    if (!rows.every((r) => TERMINAL.has(r.send_status))) continue

    const metrics = {
      seedsSent: rows.filter((r) => r.send_status === SEED_STATUS.sent).length,
      seedsFailed: rows.filter((r) => r.send_status === SEED_STATUS.failed).length,
      seedsSuppressed: rows.filter((r) => r.send_status === SEED_STATUS.suppressed).length,
      placementObserved: rows.filter((r) => r.placement && r.placement !== 'missing').length,
      placementSource: 'none',
    }
    const done = db.prepare(
      `UPDATE deliverability_test_runs
          SET status = 'completed', finished_at = datetime('now'), metrics = ?
        WHERE test_id = ? AND run_no = ? AND status = 'running'`
    ).run(JSON.stringify(metrics), run.test_id, run.run_no).changes
    if (!done) continue
    closed += 1

    // A manual test is one run by definition, so its run finishing is the test
    // finishing. An automated one stays active for its next cadence.
    if (run.type === 'manual') {
      db.prepare(
        "UPDATE deliverability_tests SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).run(run.test_id)
    }
    logEvent(run.workspace_id, {
      type: 'deliverability_test_run_finished',
      detail: `${run.name} (#${run.test_id}) run ${run.run_no}: ${metrics.seedsSent} sent, ` +
        `${metrics.seedsFailed + metrics.seedsSuppressed} not sent, placement not yet observed`,
    })
  }
  return { did: closed ? `${closed} placement run(s) finished sending` : '' }
}
