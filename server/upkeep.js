// Periodic work that is nobody's request.
//
// The parity modules built the storage, the routes and the screens for five
// features and then stopped at the edge of the tick loop, because the loop
// lives in engine.js and they could not safely edit it. That left them inert:
// a webhook you could configure and never receive, a reply you could schedule
// and never send, a placement test that answered "1 seed send queued" and sent
// nothing, a warm-up chart with no writer behind it. Webhooks are handled at
// the source (see `onEvent` in db.js); the rest are jobs, and jobs belong here.
//
// The deliverability jobs are thin wrappers here and thick in
// server/deliverability-runs.js, because a placement run is a small state
// machine and this file is a list of jobs, not a home for one.
//
// Every job follows the same three rules:
//   1. It never throws into the tick. A failed job is telemetry and a log line,
//      never a reason the engine stops sending email.
//   2. It is idempotent. The tick runs every 20 seconds and may overlap a slow
//      previous run, so each job claims its work with a conditional UPDATE
//      before acting on it rather than reading-then-writing.
//   3. It does nothing surprising. Nothing here sends an email that a human has
//      not already approved — a queued reply was written by a person who ticked
//      the confirmation; this only releases it at the time they chose.

import { db, logEvent } from './db.js'
import { recordTelemetry } from './telemetry.js'
import { notify } from './alerts.js'
import { gmailRecentInbound } from './google.js'
import { outlookRecentInbound } from './microsoft.js'
import { sendEmail, SuppressedError } from './mailer.js'
import { canSendNow } from './pacing.js'
import { openDueRuns, dispatchSeedSends } from './deliverability-runs.js'

const isoNow = () => new Date().toISOString()

// Runs one job, absorbs its failure, and records how it went. A job that throws
// must not take the other three — or the engine — down with it.
async function job(name, fn) {
  const t0 = Date.now()
  try {
    const result = (await fn()) || {}
    if (result.did) {
      recordTelemetry('upkeep', { op: name, ok: true, ms: Date.now() - t0, detail: String(result.did) })
    }
    return result
  } catch (err) {
    recordTelemetry('upkeep', { op: name, ok: false, ms: Date.now() - t0, detail: String(err?.message || err).slice(0, 200) })
    console.warn(`[upkeep] ${name} failed:`, err?.message || err)
    return {}
  }
}

// ---- scheduled sends ---------------------------------------------------------

// A manual reply or forward the user chose to send later. It was composed by a
// person and confirmed by a person; the only thing outstanding is the clock.
async function dispatchScheduled() {
  const due = db.prepare(
    `SELECT * FROM messages
      WHERE direction = 'out' AND send_status = 'queued'
        AND scheduled_at != '' AND scheduled_at <= ?
      ORDER BY scheduled_at LIMIT 25`
  ).all(isoNow())
  if (!due.length) return {}

  let sent = 0
  for (const msg of due) {
    // Claim it first. If another overlapping tick got here, `changes` is 0 and
    // we skip — this is what stops a slow tick sending the same email twice.
    const claimed = db.prepare(
      "UPDATE messages SET send_status = 'sending' WHERE id = ? AND send_status = 'queued'"
    ).run(msg.id).changes
    if (!claimed) continue

    const campaign = msg.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(msg.campaign_id) : null
    const lead = msg.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(msg.lead_id) : null
    const mailbox = msg.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(msg.mailbox_id) : null
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(msg.user_id)

    if (!campaign || !lead || !mailbox || !user) {
      db.prepare("UPDATE messages SET send_status = 'failed' WHERE id = ?").run(msg.id)
      continue
    }

    // The sending rhythm still applies — "send at 2pm" is the user's intent,
    // not permission to ignore the working-hours window or the daily cap.
    if (!canSendNow(user, mailbox).ok) {
      db.prepare("UPDATE messages SET send_status = 'queued' WHERE id = ?").run(msg.id)
      continue
    }

    try {
      // The copied recipients ride along. The scheduling route stores them on
      // the queued row explicitly "so they survive the wait", and then this
      // call dropped them: `sendEmail` defaults `cc` and `bcc` to empty, so a
      // reply scheduled for tomorrow with two colleagues copied went out to the
      // lead alone. Exactly the defect already fixed on the immediate path,
      // one layer down — and invisible, because the test for it asserted the
      // queued row rather than the delivered one.
      const copies = (value) => String(value || '').split(',').map((a) => a.trim()).filter(Boolean)
      await sendEmail({
        mailbox, user, campaign, lead,
        nodeId: msg.node_id || '',
        subject: msg.subject,
        body: msg.body,
        cc: copies(msg.cc_emails),
        bcc: copies(msg.bcc_emails),
      })
      // `sendEmail` writes its own `messages` row — the real one, with the
      // provider id, thread and tracking token. Keeping this one as well would
      // put the same email in the thread twice, so the intent row is retired
      // once the thing it intended has happened. Failures below keep their row
      // precisely because nothing replaced it.
      db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id)
      logEvent(msg.user_id, {
        campaignId: msg.campaign_id,
        leadId: msg.lead_id,
        type: 'scheduled_sent',
        detail: `sent the reply scheduled for ${msg.scheduled_at}`,
      })
      sent++
    } catch (err) {
      const suppressed = err instanceof SuppressedError
      db.prepare('UPDATE messages SET send_status = ? WHERE id = ?')
        .run(suppressed ? 'cancelled' : 'failed', msg.id)
      logEvent(msg.user_id, {
        campaignId: msg.campaign_id,
        leadId: msg.lead_id,
        type: suppressed ? 'send_suppressed' : 'error',
        detail: suppressed
          ? `scheduled reply cancelled — ${err.suppression?.message || 'suppressed'}`
          : `scheduled send failed: ${String(err?.message || err).slice(0, 160)}`,
      })
    }
  }
  return { did: sent ? `${sent} scheduled message(s) sent` : '' }
}

// ---- reminders ---------------------------------------------------------------

// A reminder is a promise to look at a thread again. Nothing here reopens or
// reroutes anything: it tells the person, once, and marks it told.
async function fireDueReminders() {
  const due = db.prepare(
    `SELECT * FROM lead_reminders
      WHERE status = 'pending' AND reminder_at <= ? ORDER BY reminder_at LIMIT 50`
  ).all(isoNow())
  if (!due.length) return {}

  let fired = 0
  for (const reminder of due) {
    const claimed = db.prepare(
      "UPDATE lead_reminders SET status = 'fired' WHERE id = ? AND status = 'pending'"
    ).run(reminder.id).changes
    if (!claimed) continue

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(reminder.lead_id)
    const who = lead ? (`${lead.first_name} ${lead.last_name}`.trim() || lead.email) : 'a lead'
    logEvent(reminder.workspace_id, {
      campaignId: reminder.campaign_id,
      leadId: reminder.lead_id,
      type: 'reminder_due',
      detail: reminder.note ? `${who} — ${reminder.note}` : `Reminder about ${who}`,
    })
    notify(reminder.workspace_id, {
      title: 'Reminder due',
      text: reminder.note ? `${who} — ${reminder.note}` : `You asked to look at ${who} again.`,
      link: '/app/inbox',
    })
    fired++
  }
  return { did: fired ? `${fired} reminder(s) fired` : '' }
}

// ---- overdue tasks -----------------------------------------------------------

// A task that has just slipped past its due date. Announced once — the `events`
// row is the guard, so a task cannot nag every twenty seconds forever.
async function announceOverdueTasks() {
  const overdue = db.prepare(
    `SELECT t.* FROM lead_tasks t
      WHERE t.status = 'open' AND t.due_at != '' AND t.due_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.user_id = t.workspace_id AND e.type = 'task_overdue'
             AND e.detail LIKE '#' || t.id || ' %')
      ORDER BY t.due_at LIMIT 25`
  ).all(isoNow())
  if (!overdue.length) return {}

  for (const task of overdue) {
    logEvent(task.workspace_id, {
      leadId: task.lead_id,
      campaignId: task.campaign_id,
      type: 'task_overdue',
      detail: `#${task.id} ${task.title}`,
    })
    notify(task.workspace_id, {
      title: 'Task overdue',
      text: `"${task.title}" was due ${task.due_at.slice(0, 10)}.`,
      link: '/app',
    })
  }
  return { did: `${overdue.length} task(s) went overdue` }
}

// ---- warm-up statistics ------------------------------------------------------

// `warmup_stats` had readers and no writer.
//
// server/parity/mailboxes.js served the warm-up panel from it and `adjustWarmup`
// below decided the ramp from it, and the only INSERTs in the repository were in
// test files. So the panel reported `warmupRunning: true`, `daysOfHistory: 0`,
// every daily figure zero — and then graded that as healthy. Zeros presented as
// measurements, which is precisely what the spec forbids. And the ramp could
// never move, because it refuses to judge fewer than ten sends and there were
// never any.
//
// This is the writer. It rolls the last few days up from `messages`, which is
// where the sends and replies already are, so the figures are a reading of real
// activity rather than a parallel ledger that can drift from it.
const ROLLUP_DAYS = 3

// What counts as having left the mailbox.
//
// This is deliberately NOT metrics.js REAL_SEND, and the difference is the
// point. REAL_SEND answers "what is outreach?" and so excludes test sends and
// forwards — they are real emails but they are not campaign activity. Warm-up
// asks a different question, "what load did this mailbox put on its provider?",
// and a test send and a forward are load. Only the two states that never
// reached a provider are excluded here. Two questions, two clauses, both
// written down.
const LEFT_THE_MAILBOX = "COALESCE(send_status,'') NOT IN ('cancelled','failed','queued','sending')"

// Day buckets follow the workspace's own timezone — the same one pacing.js
// opens and closes the sending window on, and the same one the warm-up panel
// renders in. Bucketing in UTC here and in local time there would make the
// panel's own totals disagree with its own rows.
function dayIn(tz, at) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

async function rollUpWarmupStats() {
  // Everything recent, in one read. The window is small and bounded, so this
  // recomputes rather than accumulates: a rollup that adds to yesterday's row
  // every twenty seconds is a rollup that triples yesterday by lunchtime.
  const rows = db.prepare(
    `SELECT m.mailbox_id, m.direction, COALESCE(m.send_status,'') send_status, m.created_at,
            mb.user_id, COALESCE(u.send_timezone, '') tz
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       JOIN users u ON u.id = mb.user_id
      WHERE m.created_at >= datetime('now', ?)`
  ).all(`-${ROLLUP_DAYS + 1} days`)
  if (!rows.length) return {}

  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const buckets = new Map()
  for (const row of rows) {
    const at = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z')
    if (!Number.isFinite(at)) continue
    const day = dayIn(row.tz || hostZone, at)
    const key = `${row.mailbox_id}|${day}`
    let b = buckets.get(key)
    if (!b) {
      b = { mailboxId: row.mailbox_id, day, sent: 0, received: 0, spam: 0 }
      buckets.set(key, b)
    }
    if (row.direction === 'in') {
      b.received += 1
      continue
    }
    // A bounce still left the mailbox — it is a send that came back, so it
    // counts in both columns.
    if (!['cancelled', 'failed', 'queued', 'sending'].includes(row.send_status)) b.sent += 1
    // Harry has no spam-complaint feed. Docs/email-accounts/warmup-stats.md §5
    // says so and names the substitute: "spam and complaint signals come from
    // bounce and complaint telemetry rather than from an external warm-up pool,
    // which Harry does not have". A hard bounce is the one deliverability
    // rejection Harry genuinely observes, so it is what fills this column — and
    // the API says which signal it is rather than implying a spam-folder count.
    if (row.send_status === 'bounced') b.spam += 1
  }

  // UNIQUE (mailbox_id, day) makes this an upsert, so a tick that overlaps the
  // previous one writes the same answer twice instead of two rows.
  const up = db.prepare(
    `INSERT INTO warmup_stats (mailbox_id, day, sent, received, spam, inbox, reply_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (mailbox_id, day) DO UPDATE SET
       sent = excluded.sent, received = excluded.received, spam = excluded.spam,
       inbox = excluded.inbox, reply_rate = excluded.reply_rate`
  )
  let written = 0
  for (const b of buckets.values()) {
    // A day with nothing in it gets no row. That is what makes `daysOfHistory`
    // mean "days we have evidence for" instead of "days since the table was
    // created" — the distinction the panel's honest empty state rests on.
    if (!b.sent && !b.received) continue
    const delivered = Math.max(0, b.sent - b.spam)
    const replyRate = b.sent ? Math.round((b.received / b.sent) * 1000) / 10 : 0
    up.run(b.mailboxId, b.day, b.sent, b.received, b.spam, delivered, replyRate)
    written += 1
  }
  return { did: written ? `${written} mailbox-day(s) of warm-up history written` : '' }
}

// ---- warm-up -----------------------------------------------------------------

// Warm-up ramps a new mailbox up gradually, and backs it off when the mailbox
// is being treated badly. It can only ever TIGHTEN the cap — pacing.js remains
// the authority on how much a mailbox may send, and this never overrides it.
async function adjustWarmup() {
  const mailboxes = db.prepare(
    `SELECT * FROM mailboxes
      WHERE deleted_at IS NULL AND warmup_enabled = 1 AND warmup_auto_adjust = 1 AND is_suspended = 0`
  ).all()
  if (!mailboxes.length) return {}

  const today = new Date().toISOString().slice(0, 10)
  let changed = 0
  for (const mb of mailboxes) {
    // Yesterday's evidence, not today's half-finished day.
    const recent = db.prepare(
      `SELECT COALESCE(SUM(sent), 0) sent, COALESCE(SUM(spam), 0) spam, COALESCE(SUM(received), 0) received
         FROM warmup_stats WHERE mailbox_id = ? AND day < ? AND day >= date(?, '-7 days')`
    ).get(mb.id, today, today)
    if (!recent || recent.sent < 10) continue // too little to draw a conclusion from

    const spamRate = recent.spam / recent.sent
    const step = Math.max(1, mb.warmup_ramp_step || 2)
    let next = mb.warmup_daily_count

    if (spamRate > 0.05) {
      // Landing in spam. Back off hard and say so — a silent reduction looks
      // like the product throttling for no reason.
      next = Math.max(5, mb.warmup_daily_count - step * 2)
    } else if (mb.warmup_ramp_enabled && spamRate < 0.01) {
      next = Math.min(mb.daily_limit, mb.warmup_daily_count + step)
    }

    if (next === mb.warmup_daily_count) continue
    db.prepare('UPDATE mailboxes SET warmup_daily_count = ? WHERE id = ?').run(next, mb.id)
    logEvent(mb.user_id, {
      type: 'warmup_adjusted',
      detail: `${mb.email}: ${mb.warmup_daily_count} → ${next}/day (${(spamRate * 100).toFixed(1)}% spam over ${recent.sent} sends)`,
    })
    changed++
  }
  return { did: changed ? `${changed} mailbox warm-up target(s) adjusted` : '' }
}

// ---- untracked replies -------------------------------------------------------

// Mail that arrived in a connected mailbox. Prefer attaching it to the campaign
// conversation it belongs to; only genuine orphans go to the untracked queue.
//
// Known-lead replies used to be skipped here on the assumption that the
// per-thread engine sync would catch them. That assumption fails when the send
// went from a rotated/pinned mailbox (sync looked at the wrong account) or the
// lead is no longer in `waiting` — and the reply vanished from Harry entirely.
// Exported so tests can drive the matcher without a live Gmail call.
function findTestSendOut(mailbox, msg) {
  const from = String(msg.fromEmail || '').toLowerCase().trim()
  if (msg.threadId) {
    const byThread = db.prepare(
      `SELECT * FROM messages WHERE user_id = ? AND mailbox_id = ? AND direction = 'out'
         AND send_status = 'test' AND thread_id = ? ORDER BY id DESC LIMIT 1`
    ).get(mailbox.user_id, mailbox.id, msg.threadId)
    if (byThread) return byThread
  }
  if (!from) return null
  return db.prepare(
    `SELECT * FROM messages WHERE user_id = ? AND mailbox_id = ? AND direction = 'out'
       AND send_status = 'test' AND lower(trim(to_email)) = ? ORDER BY id DESC LIMIT 1`
  ).get(mailbox.user_id, mailbox.id, from) || null
}

function storeInboundReply({ mailbox, msg, campaignId, leadId, cl }) {
  db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
     VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`
  ).run(
    mailbox.user_id, campaignId, leadId, mailbox.id,
    msg.subject || '', String(msg.body || '').slice(0, 20000),
    msg.fromEmail || '', msg.toEmail || mailbox.email,
    msg.providerMessageId, msg.threadId || cl?.thread_id || ''
  )
  if (cl && !cl.thread_id && msg.threadId) {
    db.prepare('UPDATE campaign_leads SET thread_id = ? WHERE id = ?').run(msg.threadId, cl.id)
  }
  logEvent(mailbox.user_id, {
    campaignId, leadId, type: 'reply',
    detail: String(msg.body || msg.subject || '').slice(0, 120),
  })
}

export function ingestRecentInbound(mailbox, msg) {
  if (!msg?.providerMessageId) return null

  const known = db.prepare('SELECT 1 FROM messages WHERE provider_message_id = ?').get(msg.providerMessageId)
  if (known) return 'known'

  const seen = db.prepare('SELECT 1 FROM unmatched_messages WHERE provider_message_id = ?').get(msg.providerMessageId)
  if (seen) return 'seen'

  const from = String(msg.fromEmail || '').toLowerCase().trim()
  const lead = from
    ? db.prepare('SELECT * FROM leads WHERE user_id = ? AND lower(trim(email)) = ?').get(mailbox.user_id, from)
    : null

  if (lead) {
    // Prefer the enrolment that already owns this provider thread.
    let cl = msg.threadId
      ? db.prepare(
          `SELECT cl.* FROM campaign_leads cl
             JOIN campaigns c ON c.id = cl.campaign_id
            WHERE cl.lead_id = ? AND cl.thread_id = ? AND c.user_id = ?
            ORDER BY cl.id DESC LIMIT 1`
        ).get(lead.id, msg.threadId, mailbox.user_id)
      : null

    // A reply to a campaign test send shares the Gmail thread but not a
    // campaign_leads.thread_id — match via the stored test outbound instead.
    if (!cl) {
      const testOut = findTestSendOut(mailbox, msg)
      if (testOut?.campaign_id) {
        cl = db.prepare(
          `SELECT cl.* FROM campaign_leads cl
             JOIN campaigns c ON c.id = cl.campaign_id
            WHERE cl.lead_id = ? AND cl.campaign_id = ? AND c.user_id = ?
              AND COALESCE(cl.completed_at, '') = ''
            ORDER BY cl.id DESC LIMIT 1`
        ).get(lead.id, testOut.campaign_id, mailbox.user_id)
        if (!cl) {
          db.prepare(
            'INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, ?, ?)'
          ).run(testOut.campaign_id, lead.id, 'waiting', msg.threadId || testOut.thread_id || '')
          cl = db.prepare(
            'SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?'
          ).get(testOut.campaign_id, lead.id)
        }
      }
    }

    // Otherwise any open conversation with this lead that was sent from this
    // mailbox — rotation means the campaign's primary mailbox is often wrong.
    // Test sends count too: they carry no lead_id but name the recipient in
    // to_email, which is how a confirmed test to a real lead is matched.
    if (!cl) {
      cl = db.prepare(
        `SELECT cl.* FROM campaign_leads cl
           JOIN campaigns c ON c.id = cl.campaign_id
          WHERE cl.lead_id = ? AND c.user_id = ?
            AND COALESCE(cl.completed_at, '') = ''
            AND EXISTS (
              SELECT 1 FROM messages m
               WHERE m.campaign_id = cl.campaign_id AND m.direction = 'out' AND m.mailbox_id = ?
                 AND (m.lead_id = cl.lead_id
                      OR (m.send_status = 'test' AND lower(trim(m.to_email)) = ?))
            )
          ORDER BY cl.id DESC LIMIT 1`
      ).get(lead.id, mailbox.user_id, mailbox.id, from)
    }

    if (cl) {
      storeInboundReply({
        mailbox, msg, campaignId: cl.campaign_id, leadId: lead.id, cl,
      })
      return 'attached'
    }
  }

  // Reply to a test send from an address that is not a lead — still record it
  // so the Untracked folder can surface it, with the campaign named for context.
  const testOut = findTestSendOut(mailbox, msg)
  if (testOut) {
    db.prepare(
      `INSERT INTO unmatched_messages
         (workspace_id, mailbox_id, from_email, subject, body, thread_id, provider_message_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mailbox.user_id, mailbox.id, msg.fromEmail || '',
      msg.subject || `[TEST reply] ${String(testOut.subject || '').slice(0, 180)}`,
      String(msg.body || '').slice(0, 20000), msg.threadId || testOut.thread_id || '',
      msg.providerMessageId, msg.receivedAt || isoNow()
    )
    return 'untracked'
  }

  db.prepare(
    `INSERT INTO unmatched_messages
       (workspace_id, mailbox_id, from_email, subject, body, thread_id, provider_message_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mailbox.user_id, mailbox.id, msg.fromEmail || '', msg.subject || '',
    String(msg.body || '').slice(0, 20000), msg.threadId || '', msg.providerMessageId,
    msg.receivedAt || isoNow())
  return 'untracked'
}

async function syncMailboxInbound(mailbox, { withinDays = 2, max = 25 } = {}) {
  let inbound = []
  inbound = mailbox.provider === 'outlook'
    ? await outlookRecentInbound(mailbox, { withinDays, max })
    : await gmailRecentInbound(mailbox, { withinDays, max })

  let attached = 0
  let untracked = 0
  for (const msg of inbound) {
    const result = ingestRecentInbound(mailbox, msg)
    if (result === 'attached') attached++
    else if (result === 'untracked') untracked++
  }
  db.prepare("UPDATE mailboxes SET last_sync_at = datetime('now'), last_error = '' WHERE id = ?").run(mailbox.id)
  return { attached, untracked, scanned: inbound.length }
}

// One in-flight pull per mailbox — Inbox's 10s poll and "Sync replies" used to
// stack concurrent Gmail fetches and leave the button on Syncing… for minutes.
const inboundSyncInFlight = new Map()

// On-demand pull for one mailbox — used by the fleet "Sync replies" action.
export async function pullMailboxInbound(mailbox, opts = {}) {
  if (!mailbox.refresh_token) {
    const full = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(mailbox.id)
    if (full) mailbox = full
  }
  const id = mailbox.id
  const existing = inboundSyncInFlight.get(id)
  if (existing) return existing

  const run = (async () => {
    try {
      return await syncMailboxInbound(mailbox, { withinDays: 3, max: 20, ...opts })
    } finally {
      inboundSyncInFlight.delete(id)
    }
  })()
  inboundSyncInFlight.set(id, run)
  return run
}

/** Pull recent inbound for every connected Gmail/Outlook mailbox in a workspace. */
export async function pullWorkspaceInbound(wsId, opts = {}) {
  const mailboxes = db.prepare(
    `SELECT * FROM mailboxes
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND provider IN ('gmail','outlook')
        AND status = 'connected'
        AND is_suspended = 0
        AND COALESCE(refresh_token,'') != ''`
  ).all(wsId)
  let scanned = 0
  let attached = 0
  let untracked = 0
  const errors = []
  for (const mb of mailboxes) {
    try {
      const result = await pullMailboxInbound(mb, opts)
      scanned += result.scanned || 0
      attached += result.attached || 0
      untracked += result.untracked || 0
    } catch (err) {
      const detail = String(err?.message || err).slice(0, 300)
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(detail, mb.id)
      errors.push({ mailboxId: mb.id, email: mb.email, error: detail })
    }
  }
  return { mailboxes: mailboxes.length, scanned, attached, untracked, errors }
}

async function pullUnmatched() {
  const mailboxes = db.prepare(
    "SELECT * FROM mailboxes WHERE deleted_at IS NULL AND provider IN ('gmail','outlook') AND status = 'connected' AND is_suspended = 0"
  ).all()
  if (!mailboxes.length) return {}

  let untracked = 0
  let attached = 0
  for (const mb of mailboxes) {
    try {
      const result = await syncMailboxInbound(mb)
      attached += result.attached
      untracked += result.untracked
    } catch (err) {
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?')
        .run(String(err?.message || err).slice(0, 300), mb.id)
      continue
    }
  }
  const parts = []
  if (attached) parts.push(`${attached} campaign repl(ies) attached`)
  if (untracked) parts.push(`${untracked} untracked repl(ies) recorded`)
  return { did: parts.join(', ') }
}

// ---- the whole pass ----------------------------------------------------------

export async function runUpkeep() {
  // The rollup runs before the ramp reads it, in its own await, because the
  // ramp's whole input is the table the rollup writes. Everything after is
  // independent and goes in parallel as before.
  const first = await job('warmup_rollup', rollUpWarmupStats)
  const results = await Promise.all([
    job('scheduled_sends', dispatchScheduled),
    job('reminders', fireDueReminders),
    job('overdue_tasks', announceOverdueTasks),
    job('warmup', adjustWarmup),
    job('untracked_replies', pullUnmatched),
    // Placement tests: open the runs that have come due, then send the seeds
    // that are waiting. Both claim their work with a conditional UPDATE and
    // both absorb their own failure, so neither can stop a campaign sending.
    job('deliverability_runs', openDueRuns),
    job('deliverability_seeds', dispatchSeedSends),
  ])
  return [first, ...results].filter((r) => r.did).map((r) => r.did)
}

// Exported individually so tests can drive one job without the clock or the
// others' side effects.
export const jobs = {
  dispatchScheduled,
  fireDueReminders,
  announceOverdueTasks,
  rollUpWarmupStats,
  adjustWarmup,
  pullUnmatched,
  pullMailboxInbound,
  pullWorkspaceInbound,
  ingestRecentInbound,
  openDueRuns,
  dispatchSeedSends,
}
