// Inbox — unified reply inbox and lead triage (Docs/inbox, 25 endpoints).
//
// SmartLead ships ten near-identical list endpoints (archived, assigned,
// important, inbox-replies, reminders, scheduled, sent, snoozed, unread,
// views). Seven of the backlog files independently name the same Harry route,
// `GET /api/inbox/threads`, so this module builds ONE list with a validated
// `state` enum and shared filters rather than ten routes that would drift.
// `PATCH /api/inbox/threads/:id` is likewise the single mutation for read,
// archived, snoozed and important state, with `PATCH /api/inbox/threads` as
// its bulk sibling.
//
// What a "thread" is here
// ----------------------
// Harry has no threads table. A thread is the set of `messages` rows sharing a
// `thread_id` inside one workspace, and its id is the id of the thread's
// earliest message — an integer that never changes, because messages are only
// ever appended. Any message id in the thread is accepted and normalised to
// that anchor, so a deep link from a notification still resolves.
//
// Thread state is stored per message (schema.js puts archived_at, snoozed_until,
// is_important, read_at on `messages`) and read back as an aggregate:
//
//   read      every inbound message has read_at            MIN(read_at) != ''
//   archived  every message has archived_at                MIN(archived_at) != ''
//   snoozed   every message is snoozed into the future     MIN(snoozed_until) > now
//   important any message is starred                       MAX(is_important) = 1
//
// That is not an accident of convenience. A new inbound reply arrives with
// those columns at their defaults, so it drags the thread back to unread,
// unarchived and awake without engine.js having to know this module exists —
// which is exactly what the specs demand ("the new reply wins", "a live
// conversation can never sit hidden"). A manual star uses MAX and therefore
// survives, as get-important.md requires.
//
// Snooze expiry is evaluated at read time against `now`, never by a job, so it
// cannot drift. `is_overdue` on a reminder and `reply_age_hours` on a thread
// are derived the same way, following the rule Harry already applies to stages.
//
// Deliberate divergences, stated where the source is silent or contradictory:
//
//  * forward — Docs/campaigns/forward-email.md documents no request fields at
//    all and ships an empty `{}` sample with its own warning not to build
//    against it. Harry defines its own explicit contract instead:
//    { to, cc, bcc, subject, note, includeThread, confirm }. The forwarded
//    chain is assembled server-side from stored messages so a client cannot
//    inject content into it, and the tracking pixel and click wrappers are
//    stripped before it leaves.
//
//  * nothing sends without the user's OK — both send paths in this module
//    (manual reply, forward) refuse without an explicit `confirm: true`. There
//    is no other path here that puts mail on the wire.
//
//  * suppression is unconditional — `POST /api/blocked-domains` has no bypass
//    flag, and any request carrying one (`ignoreBlockList`,
//    `ignoreUnsubscribeList`, `ignoreGlobalBlockList`, `force`) is refused 422
//    rather than quietly ignored, so a caller cannot believe it worked.
//
//  * revenue — schema.js declares `revenue_amount` as REAL. The spec asks for
//    minor units to avoid floating-point drift, so the API takes `amount` in
//    major units and stores integral minor units in that column; totals are
//    summed in minor units and only divided on the way out.

import { db } from '../db.js'
import { blockMatch, suppressionFor } from '../suppression.js'
import { campaignCtx, routeReply } from '../engine.js'
import { sendEmail } from '../mailer.js'
import { sendManualSms, SuppressedError } from '../channels/send.js'
import { toE164 } from '../channels/phone.js'
import { pullWorkspaceInbound } from '../upkeep.js'
import {
  HttpError, invalid, notFound, handler,
  str, int, bool, oneOf, idList, email as emailField,
  page, paged, owned, tx, nowIso, audit, meter,
} from './http.js'
import { rateLimit } from '../security.js'
import { sessionUid } from '../auth.js'

// ---------------------------------------------------------------- constants --

// The one state enum. Ten SmartLead list endpoints collapse into these; an
// unknown value is a 422 naming `state` rather than a silently empty list.
export const INBOX_STATES = [
  'active',     // inbox-replies: has a reply, not archived, not snoozed
  'all',        // every thread regardless of state
  'archived',
  'assigned',   // assigned to `assignee` (defaults to the caller)
  'important',
  'reminders',  // has a pending reminder
  'scheduled',  // queued outbound messages (message rows, not threads)
  'sent',       // outbound messages already dispatched (message rows)
  'snoozed',
  'unread',
]

// Message-row states rather than thread-row states. Documented on the response
// as `rowType` so a client never has to guess which shape it received.
const MESSAGE_STATES = new Set(['scheduled', 'sent'])

// How long a message may sit in 'sending' before DELETE /scheduled/:id treats
// it as stranded (process killed mid-send) and lets the user reclaim it. Any
// genuine send resolves to sent/failed in seconds; fifteen minutes is well
// clear of that and of a slow provider round-trip.
const SENDING_STALE_MS = 15 * 60 * 1000

// The `lead_tasks.priority` CHECK constraint, restated where the inbox-side
// task route can see it. Kept identical to PRIORITIES in server/parity/notes.js
// on purpose: two routes writing one column must agree on what it accepts.
const TASK_PRIORITIES = ['low', 'medium', 'high']

const SORTS = [
  'reply_desc', 'reply_asc',
  'sent_desc', 'sent_asc',
  'scheduled_asc', 'scheduled_desc',
  'reminder_asc', 'reminder_desc',
]

// Ceilings from get-messages.md. Exceeding one returns the documented
// field / provided_count / max_allowed shape so the UI can name what to remove.
const CEILINGS = {
  campaignId: 5,
  mailboxId: 20,
  categoryId: 10,
  assignee: 10,
  search: 30,
}

// get-sent.md documents its own, wider campaign ceiling — 15 rather than the
// replies endpoint's 5 — and says so explicitly ("this endpoint's ceiling,
// wider than the replies endpoint's 5"). Collapsing ten endpoints into one list
// must not quietly impose the tightest cap on the state that was allowed the
// loosest, because that turns a documented capability into a 422.
const STATE_CEILINGS = {
  sent: { campaignId: 15 },
}

// The engagement statuses every list spec names, and what each one means over
// the columns Harry actually has. `Not Replied` is the one worth stating: the
// specs define it as *opened with no reply*, not "no reply", and get-sent.md's
// whole user story is finding those people.
const EMAIL_STATUSES = {
  Opened: "COALESCE(opened_at,'') != ''",
  Clicked: "COALESCE(clicked_at,'') != ''",
  Replied: 'inbound_count > 0',
  'Not Replied': "COALESCE(opened_at,'') != '' AND inbound_count = 0",
  Unsubscribed: "LOWER(COALESCE(lead_status,'')) = 'unsubscribed'",
  Bounced: "LOWER(COALESCE(lead_status,'')) = 'bounced'",
  // Accepted: it left, and nothing has come back — no open, no click, no reply.
  Accepted: "outbound_count > 0 AND COALESCE(opened_at,'') = '' AND COALESCE(clicked_at,'') = '' AND inbound_count = 0",
}

// Harry's own wording for a provider failure, with a next step attached, so no
// raw provider string ever reaches the UI (reply-status.md).
const STATUS_MESSAGE = {
  queued: 'Waiting for its slot in the sending rhythm.',
  sending: 'Handing this to the mailbox now.',
  sent: 'Delivered to the mailbox provider.',
  failed: 'The mailbox refused this message. Reconnect the mailbox and try again.',
  cancelled: 'Cancelled before it was sent.',
}

// ---------------------------------------------------------------- utilities --

const now = () => new Date()

function ceiling(field, count, limits = CEILINGS) {
  const max = limits[field]
  if (max !== undefined && count > max) {
    throw new HttpError(422, {
      error: 'validation_failed',
      field,
      message: `${field} may contain at most ${max} values`,
      provided_count: count,
      max_allowed: max,
    })
  }
}

// Query-string list: `?campaignId=1&campaignId=2` or `?campaignId=1,2`.
function queryIds(query, field, limits = CEILINGS) {
  const raw = query?.[field]
  if (raw === undefined || raw === null || raw === '') return []
  const parts = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean)
  ceiling(field, parts.length, limits)
  const ids = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n <= 0) throw invalid(field, `${field} contains an invalid id: ${part}`)
    if (!ids.includes(n)) ids.push(n)
  }
  return ids
}

// Suppression is unconditional. A caller that asks to skip it is told no,
// rather than having the flag silently dropped.
const BYPASS_FIELDS = ['ignoreBlockList', 'ignoreUnsubscribeList', 'ignoreGlobalBlockList', 'ignoreDuplicateLeadsInOtherCampaign', 'force']
function refuseBypass(body) {
  for (const field of BYPASS_FIELDS) {
    if (body && body[field] !== undefined) {
      throw invalid(field, 'Suppression cannot be bypassed — remove this field')
    }
  }
}

function domainOf(address) {
  const at = String(address || '').lastIndexOf('@')
  return at < 0 ? '' : String(address).slice(at + 1).toLowerCase()
}

// Delegates to server/suppression.js. This used to be its own query matching
// only the exact address or its immediate domain — which is precisely how a
// forward reached `ana@mail.competitor.com` while `competitor.com` was blocked.
// Five modules had five predicates and they disagreed; there is now one.
export function isBlocked(wsId, address) {
  return Boolean(blockMatch(wsId, String(address || '').trim().toLowerCase()))
}

function assertNotBlocked(wsId, address, field = 'to') {
  if (isBlocked(wsId, address)) {
    throw invalid(field, `${address} is on this workspace's block list`)
  }
}

// Everyone who may be an assignee: the workspace owner plus their team.
function memberEmails(wsId) {
  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(wsId)
  const team = db.prepare('SELECT email FROM team_members WHERE owner_id = ?').all(wsId)
  return [owner?.email, ...team.map((t) => t.email)].filter(Boolean).map((e) => e.toLowerCase())
}

// campaign_leads has no workspace column; ownership runs through the campaign.
function ownedPairing(id, wsId) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw notFound('conversation')
  const row = db.prepare(
    `SELECT cl.* FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
     WHERE cl.id = ? AND c.user_id = ?`
  ).get(n, wsId)
  if (!row) throw notFound('conversation')
  return row
}

// The grouping key: the thread id, or a synthetic per-message key for the
// messages that never got one, so unrelated strays are not lumped together.
const TKEY = "CASE WHEN COALESCE(m.thread_id,'') = '' THEN 'm:' || m.id ELSE m.thread_id END"

// Accepts any message id in a thread and returns the thread's anchor.
function resolveThread(wsId, id) {
  const msg = owned('messages', id, wsId, 'conversation')
  const tkey = msg.thread_id ? msg.thread_id : `m:${msg.id}`
  const messages = msg.thread_id
    ? db.prepare('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY id').all(wsId, msg.thread_id)
    : [msg]
  return { tkey, anchorId: messages[0].id, messages }
}

function threadState(messages, at = now()) {
  const inbound = messages.filter((m) => m.direction === 'in')
  const minRead = inbound.length ? inbound.map((m) => m.read_at || '').sort()[0] : null
  const minArchived = messages.map((m) => m.archived_at || '').sort()[0]
  const minSnoozed = messages.map((m) => m.snoozed_until || '').sort()[0]
  const snoozedActive = !!minSnoozed && Date.parse(minSnoozed) > at.getTime()
  return {
    is_read: inbound.length === 0 ? true : !!minRead,
    is_archived: !!minArchived,
    archived_at: minArchived || '',
    is_snoozed: snoozedActive,
    snoozed_until: snoozedActive ? minSnoozed : '',
    is_important: messages.some((m) => m.is_important),
  }
}

// Reminders hang off the thread key; overdue is derived, never stored.
function remindersFor(wsId, tkey, at = now()) {
  return db.prepare(
    'SELECT * FROM lead_reminders WHERE workspace_id = ? AND thread_id = ? ORDER BY reminder_at, id'
  ).all(wsId, tkey).map((r) => ({ ...r, is_overdue: r.status === 'pending' && Date.parse(r.reminder_at) < at.getTime() }))
}

// Reasons are stored as a JSON array. A row written before the column existed
// reads as '' — an empty list, not a crash and not a null the client has to
// special-case.
function parseReasons(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : []
  } catch {
    return []
  }
}

const minor = (major) => Math.round(Number(major) * 100)
const major = (minorUnits) => Math.round(Number(minorUnits || 0)) / 100

// A recorded zero and nothing recorded are different answers (update-revenue.md
// TC-6 and TC-7), and `revenue_amount` alone cannot tell them apart because its
// default is 0. `revenue_updated_at` is the discriminator: a write sets it, a
// clear empties it again, and the events trail keeps who did which.
const revenueOf = (row) => ({
  amount: major(row?.revenue_amount),
  amount_minor: Math.round(row?.revenue_amount || 0),
  currency: row?.revenue_currency || 'USD',
  recorded: !!row?.revenue_updated_at,
  updated_at: row?.revenue_updated_at || '',
})

// The single status a row reports, read in the same order the filter would
// match it, so `email_status` on a row and `emailStatus` as a filter can never
// disagree about what that row is.
function emailStatusOf(row) {
  if (String(row.lead_status || '').toLowerCase() === 'unsubscribed') return 'Unsubscribed'
  if (String(row.lead_status || '').toLowerCase() === 'bounced') return 'Bounced'
  if (row.inbound_count > 0) return 'Replied'
  if (row.clicked_at) return 'Clicked'
  if (row.opened_at) return 'Not Replied'
  if (row.outbound_count > 0) return 'Accepted'
  return ''
}

// Single value or array, case-insensitive, against the seven statuses every
// list spec names. An unknown one is a 422 listing the valid values rather than
// a silently empty list (get-sent.md TC-8).
function emailStatuses(source) {
  const raw = source?.emailStatus
  if (raw === undefined || raw === null || raw === '') return []
  const parts = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean)
  const valid = Object.keys(EMAIL_STATUSES)
  const out = []
  for (const part of parts) {
    const match = valid.find((v) => v.toLowerCase() === part.toLowerCase())
    if (!match) throw invalid('emailStatus', `emailStatus must be one of: ${valid.join(', ')}`)
    if (!out.includes(match)) out.push(match)
  }
  return out
}

// ------------------------------------------------------------- the one list --

// Shared filter parsing, used by the ad-hoc route and by a saved view alike so
// a view is a stored argument list rather than a second query engine.
function parseFilters(source, wsId) {
  const state = oneOf(source, 'state', INBOX_STATES, { fallback: 'active' })
  // get-reminders.md names REMINDER_TIME_ASC the recommended default ("overdue
  // and earliest first — this is the recommended order for a daily review"), so
  // the reminders state gets it rather than inheriting the replies default.
  const defaultSort = MESSAGE_STATES.has(state)
    ? (state === 'scheduled' ? 'scheduled_asc' : 'sent_desc')
    : state === 'reminders' ? 'reminder_asc' : 'reply_desc'
  const sort = oneOf(source, 'sort', SORTS, { fallback: defaultSort })
  const search = str(source, 'search', { max: 5000, fallback: '' })
  if (search.length > CEILINGS.search) ceiling('search', search.length)
  const limits = { ...CEILINGS, ...(STATE_CEILINGS[state] || {}) }

  const filters = {
    state,
    sort,
    search,
    campaignId: queryIds(source, 'campaignId', limits),
    mailboxId: queryIds(source, 'mailboxId', limits),
    categoryId: queryIds(source, 'categoryId', limits),
    intent: str(source, 'intent', { max: 120, fallback: '' }),
    assignee: str(source, 'assignee', { max: 320, fallback: '' }),
    // "Leads sitting at node X" — get-views.md's `subSequenceId`, which in Harry
    // is a playbook node rather than a separate sequence object. A view saved on
    // it must empty itself as leads advance, which is the point of TC-10.
    nodeId: str(source, 'nodeId', { max: 120, fallback: '' }),
    // Refused rather than ignored on the message folders. Every predicate in
    // EMAIL_STATUSES is written against thread-level aggregates —
    // `inbound_count`, `outbound_count`, `lead_status` — which `listMessages`
    // does not compute, so `state=sent&emailStatus=Replied` parsed cleanly,
    // validated, and then filtered nothing. A filter that silently does nothing
    // is worse than one that is unavailable: the list looks filtered and is
    // not. Saying so is the honest interim until the message query grows the
    // same aggregates.
    emailStatus: (() => {
      const parsed = emailStatuses(source)
      if (parsed.length && MESSAGE_STATES.has(state)) {
        throw invalid('emailStatus', `emailStatus filters conversations, not individual emails — it cannot be combined with state=${state}`)
      }
      return parsed
    })(),
    unread: source?.unread === undefined ? null : bool(source, 'unread'),
    important: source?.important === undefined ? null : bool(source, 'important'),
    hasReminder: source?.hasReminder === undefined ? null : bool(source, 'hasReminder'),
    repliedFrom: str(source, 'repliedFrom', { max: 40, fallback: '' }),
    repliedTo: str(source, 'repliedTo', { max: 40, fallback: '' }),
  }
  for (const field of ['repliedFrom', 'repliedTo']) {
    if (filters[field] && Number.isNaN(Date.parse(filters[field]))) {
      throw invalid(field, `${field} must be an ISO 8601 datetime`)
    }
  }
  // Every id in a filter must resolve inside the workspace — a stale id is a
  // named 422, never a silently unfiltered list.
  for (const id of filters.campaignId) if (!db.prepare('SELECT 1 FROM campaigns WHERE id = ? AND user_id = ?').get(id, wsId)) throw invalid('campaignId', `No such campaign: ${id}`)
  for (const id of filters.mailboxId) if (!db.prepare('SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, wsId)) throw invalid('mailboxId', `No such mailbox: ${id}`)
  for (const id of filters.categoryId) if (!db.prepare('SELECT 1 FROM lead_categories WHERE id = ? AND workspace_id = ?').get(id, wsId)) throw invalid('categoryId', `No such category: ${id}`)
  return filters
}

const THREAD_CTE = `
WITH t AS (
  SELECT
    ${TKEY} AS tkey,
    MIN(m.id) AS id,
    MAX(m.id) AS last_message_id,
    MAX(CASE WHEN m.direction = 'in'  THEN m.id ELSE 0 END) AS last_inbound_id,
    MAX(CASE WHEN m.direction = 'out' THEN m.id ELSE 0 END) AS last_outbound_id,
    MAX(COALESCE(m.campaign_id, 0)) AS campaign_id,
    MAX(COALESCE(m.lead_id, 0)) AS lead_id,
    MAX(COALESCE(m.mailbox_id, 0)) AS mailbox_id,
    COUNT(*) AS message_count,
    SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) AS inbound_count,
    SUM(CASE WHEN m.direction = 'out' THEN 1 ELSE 0 END) AS outbound_count,
    -- Engagement is a property of the conversation, not of one email: an open
    -- on the second follow-up still means this person opened.
    MAX(COALESCE(m.opened_at, '')) AS opened_at,
    MAX(COALESCE(m.clicked_at, '')) AS clicked_at,
    MIN(CASE WHEN m.direction = 'in' THEN COALESCE(m.read_at, '') END) AS min_read_at,
    MIN(COALESCE(m.archived_at, '')) AS min_archived_at,
    MIN(COALESCE(m.snoozed_until, '')) AS min_snoozed_until,
    MAX(COALESCE(m.is_important, 0)) AS is_important,
    -- The thread's importance is its most important message: one reply saying
    -- "budget approved" makes the whole conversation worth opening, and MAX is
    -- what stops a later "thanks!" burying it again.
    MAX(COALESCE(m.importance_score, 0)) AS importance_score
  FROM messages m
  WHERE m.user_id = ?
  GROUP BY tkey
)`

// One WITH, two CTEs: `t` groups the messages into threads, `r` decorates them.
// Every filter, the cursor and the count then run against `r`, so the list and
// the badge are literally the same predicate over the same rows.
function threadSelect(wsId) {
  return `${THREAD_CTE}, r AS (
SELECT
  t.*,
  CASE WHEN t.last_inbound_id  > 0 THEN t.last_inbound_id  ELSE t.last_message_id END AS reply_key,
  CASE WHEN t.last_outbound_id > 0 THEN t.last_outbound_id ELSE t.last_message_id END AS sent_key,
  lm.subject AS last_subject, lm.body AS last_body, lm.created_at AS last_at,
  lm.direction AS last_direction, lm.from_email AS last_from, lm.to_email AS last_to,
  lm.channel AS last_channel,
  im.created_at AS last_reply_at, im.intent AS last_intent,
  im.importance_reasons AS last_importance_reasons,
  om.created_at AS last_sent_at,
  l.email AS lead_email, l.first_name, l.last_name, l.company, l.title, l.status AS lead_status,
  c.name AS campaign_name, c.status AS campaign_status,
  mb.email AS mailbox_email,
  cl.id AS campaign_lead_id, cl.state AS lead_state, cl.node_id, cl.outcome,
  cl.assigned_email, cl.category_id, cl.revenue_amount, cl.revenue_currency, cl.revenue_updated_at,
  cl.paused_at, cl.resume_at,
  (SELECT MIN(r.reminder_at) FROM lead_reminders r
    WHERE r.workspace_id = ${Number(wsId)} AND r.thread_id = t.tkey AND r.status = 'pending') AS reminder_at
FROM t
JOIN messages lm ON lm.id = t.last_message_id
LEFT JOIN messages im ON im.id = t.last_inbound_id
LEFT JOIN messages om ON om.id = t.last_outbound_id
LEFT JOIN leads l ON l.id = t.lead_id
LEFT JOIN campaigns c ON c.id = t.campaign_id
LEFT JOIN mailboxes mb ON mb.id = t.mailbox_id
LEFT JOIN campaign_leads cl ON cl.campaign_id = t.campaign_id AND cl.lead_id = t.lead_id
)`
}

// Builds the WHERE clause shared by the list and the count, so a badge can
// never disagree with the list it counts.
function threadPredicate(filters, wsId, callerEmail, at) {
  const nowStr = at.toISOString()
  const where = []
  const args = []
  const notArchived = "COALESCE(min_archived_at,'') = ''"
  const notSnoozed = `(COALESCE(min_snoozed_until,'') = '' OR min_snoozed_until <= '${nowStr}')`
  const unread = "(inbound_count > 0 AND COALESCE(min_read_at,'') = '')"

  switch (filters.state) {
    case 'active':
      where.push('inbound_count > 0', notArchived, notSnoozed); break
    case 'unread':
      where.push(unread, notArchived, notSnoozed); break
    case 'archived':
      where.push("COALESCE(min_archived_at,'') != ''"); break
    case 'snoozed':
      where.push(`COALESCE(min_snoozed_until,'') != '' AND min_snoozed_until > '${nowStr}'`); break
    case 'important':
      where.push('is_important = 1', notArchived); break
    case 'assigned':
      where.push(notArchived, notSnoozed, "LOWER(COALESCE(assigned_email,'')) = ?")
      args.push((filters.assignee && filters.assignee !== 'me' ? filters.assignee : callerEmail).toLowerCase())
      break
    case 'reminders':
      where.push('reminder_at IS NOT NULL', notArchived); break
    case 'all':
    default:
      break
  }

  if (filters.state !== 'assigned' && filters.assignee) {
    if (filters.assignee === 'none') where.push("COALESCE(assigned_email,'') = ''")
    else {
      where.push("LOWER(COALESCE(assigned_email,'')) = ?")
      args.push((filters.assignee === 'me' ? callerEmail : filters.assignee).toLowerCase())
    }
  }
  if (filters.campaignId.length) { where.push(`campaign_id IN (${filters.campaignId.map(() => '?').join(',')})`); args.push(...filters.campaignId) }
  if (filters.mailboxId.length) { where.push(`mailbox_id IN (${filters.mailboxId.map(() => '?').join(',')})`); args.push(...filters.mailboxId) }
  if (filters.categoryId.length) { where.push(`category_id IN (${filters.categoryId.map(() => '?').join(',')})`); args.push(...filters.categoryId) }
  if (filters.intent) { where.push("LOWER(COALESCE(last_intent,'')) = ?"); args.push(filters.intent.toLowerCase()) }
  if (filters.nodeId) { where.push("COALESCE(node_id,'') = ?"); args.push(filters.nodeId) }
  // Several statuses OR together: "opened or clicked" is one segment, not two
  // requests (get-sent.md TC-7).
  if (filters.emailStatus.length) {
    where.push(`(${filters.emailStatus.map((s) => `(${EMAIL_STATUSES[s]})`).join(' OR ')})`)
  }
  if (filters.unread === true) where.push(unread)
  if (filters.unread === false) where.push(`NOT ${unread}`)
  if (filters.important === true) where.push('is_important = 1')
  if (filters.important === false) where.push('is_important = 0')
  if (filters.hasReminder === true) where.push('reminder_at IS NOT NULL')
  if (filters.hasReminder === false) where.push('reminder_at IS NULL')
  // Compare like with like. `last_reply_at` comes from `messages.created_at`,
  // which SQLite writes as 'YYYY-MM-DD HH:MM:SS' — no 'T', no zone. Comparing
  // that against an ISO string is a *string* comparison where ' ' < 'T', so
  // `repliedFrom = today 00:00` matched nothing and `repliedTo = today 00:00`
  // matched everything. datetime() normalises both sides instead.
  if (filters.repliedFrom) { where.push("datetime(last_reply_at) >= datetime(?)"); args.push(new Date(filters.repliedFrom).toISOString()) }
  if (filters.repliedTo) { where.push("datetime(last_reply_at) <= datetime(?)"); args.push(new Date(filters.repliedTo).toISOString()) }
  if (filters.search) {
    const like = `%${filters.search.toLowerCase()}%`
    where.push(`(LOWER(COALESCE(lead_email,'')) LIKE ? OR LOWER(COALESCE(first_name,'')) LIKE ?
      OR LOWER(COALESCE(last_name,'')) LIKE ? OR LOWER(COALESCE(company,'')) LIKE ?
      OR LOWER(COALESCE(last_subject,'')) LIKE ? OR LOWER(COALESCE(last_body,'')) LIKE ?)`)
    args.push(like, like, like, like, like, like)
  }
  return { where, args }
}

function sortColumn(sort) {
  if (sort.startsWith('sent')) return 'sent_key'
  if (sort.startsWith('reminder')) return 'reminder_at'
  return 'reply_key'
}

function shapeThread(row, at) {
  const snoozedActive = !!row.min_snoozed_until && Date.parse(row.min_snoozed_until) > at.getTime()
  // One decimal, not whole hours. get-unread.md TC-9 asks for "waiting 2.5
  // hours" against a reply received two and a half hours ago; rounding to the
  // nearest hour reported 3 and made the ordering rationale ("answer people in
  // the order that keeps them warm") unverifiable for anything under an hour.
  const replyAgeHours = row.last_reply_at
    ? Math.max(0, Math.round((at.getTime() - Date.parse(row.last_reply_at + 'Z')) / 36e5 * 10) / 10)
    : null
  return {
    rowType: 'thread',
    id: row.id,
    threadKey: row.tkey,
    channel: row.last_channel || 'email',
    campaign_lead_map_id: row.campaign_lead_id || null,
    campaignId: row.campaign_id || null,
    campaign: row.campaign_id ? { id: row.campaign_id, name: row.campaign_name, status: row.campaign_status } : null,
    mailbox: row.mailbox_id ? { id: row.mailbox_id, email: row.mailbox_email } : null,
    lead: row.lead_id
      ? { id: row.lead_id, email: row.lead_email, first_name: row.first_name, last_name: row.last_name, company: row.company, title: row.title, status: row.lead_status }
      : null,
    last_message: {
      id: row.last_message_id,
      subject: row.last_subject,
      body: row.last_body,
      direction: row.last_direction,
      sent_from: row.last_from,
      sent_to: row.last_to,
      at: row.last_at,
    },
    last_reply_at: row.last_reply_at || '',
    last_sent_at: row.last_sent_at || '',
    reply_age_hours: replyAgeHours,
    intent: row.last_intent || '',
    message_count: row.message_count,
    is_read: row.inbound_count === 0 ? true : !!row.min_read_at,
    is_important: !!row.is_important,
    importance_score: row.importance_score || 0,
    importance_reasons: parseReasons(row.last_importance_reasons),
    is_archived: !!row.min_archived_at,
    is_snoozed: snoozedActive,
    snoozed_until: snoozedActive ? row.min_snoozed_until : '',
    reminder_at: row.reminder_at || '',
    is_overdue_reminder: !!row.reminder_at && Date.parse(row.reminder_at) < at.getTime(),
    assigned_to: row.assigned_email || '',
    category_id: row.category_id || null,
    lead_state: row.lead_state || '',
    node_id: row.node_id || '',
    outcome: row.outcome || '',
    revenue: row.campaign_lead_id ? revenueOf(row) : null,
    email_status: emailStatusOf(row),
    cursor_key: null, // filled by listThreads
  }
}

function listThreads(wsId, callerEmail, filters, { limit, cursor }) {
  const at = now()
  const { where, args } = threadPredicate(filters, wsId, callerEmail, at)
  const col = sortColumn(filters.sort)
  const desc = filters.sort.endsWith('_desc')
  const prefix = threadSelect(wsId)

  const countSql = `${prefix} SELECT COUNT(*) AS n FROM r${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
  const total = db.prepare(countSql).get(wsId, ...args).n

  const pageWhere = [...where]
  const pageArgs = [...args]
  if (cursor) {
    // Keyset, not offset: a reply landing mid-scroll re-sorts to the top of
    // page one and cannot duplicate or skip a row on the page being read.
    pageWhere.push(`${col} ${desc ? '<' : '>'} ?`)
    pageArgs.push(cursor)
  }
  const sql = `${prefix} SELECT * FROM r${pageWhere.length ? ` WHERE ${pageWhere.join(' AND ')}` : ''}
    ORDER BY ${col} ${desc ? 'DESC' : 'ASC'} LIMIT ?`
  const rows = db.prepare(sql).all(wsId, ...pageArgs, limit + 1)
  const out = rows.map((r) => {
    const shaped = shapeThread(r, at)
    shaped.cursor_key = r[col]
    return shaped
  })
  return { ...paged(out, limit, 'cursor_key'), total_count: total }
}

// scheduled and sent are lists of outbound messages, not of conversations —
// cancelling a queued send needs a message id, and a "sent" list of threads
// would hide the second and third emails in the same thread.
function listMessages(wsId, filters, { limit, cursor }) {
  const scheduled = filters.state === 'scheduled'
  const where = ["m.user_id = ?", "m.direction = 'out'"]
  const args = [wsId]
  if (scheduled) where.push("COALESCE(m.send_status,'') = 'queued'")
  else where.push("COALESCE(m.send_status,'') != 'queued'", "COALESCE(m.send_status,'') != 'cancelled'")
  if (filters.campaignId.length) { where.push(`m.campaign_id IN (${filters.campaignId.map(() => '?').join(',')})`); args.push(...filters.campaignId) }
  if (filters.mailboxId.length) { where.push(`m.mailbox_id IN (${filters.mailboxId.map(() => '?').join(',')})`); args.push(...filters.mailboxId) }
  if (filters.search) {
    const like = `%${filters.search.toLowerCase()}%`
    where.push("(LOWER(COALESCE(m.subject,'')) LIKE ? OR LOWER(COALESCE(m.body,'')) LIKE ? OR LOWER(COALESCE(m.to_email,'')) LIKE ?)")
    args.push(like, like, like)
  }

  const base = `FROM messages m
    LEFT JOIN leads l ON l.id = m.lead_id
    LEFT JOIN campaigns c ON c.id = m.campaign_id
    LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE ${where.join(' AND ')}`
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args).n

  const desc = filters.sort.endsWith('_desc')
  const pageWhere = []
  const pageArgs = [...args]
  if (cursor) {
    if (scheduled) {
      // Ordered by (scheduled_at, id); the cursor is the last row's id and its
      // time is looked up so the comparison stays a true tuple comparison.
      const prev = db.prepare("SELECT COALESCE(scheduled_at,'') AS k, id FROM messages WHERE id = ? AND user_id = ?").get(cursor, wsId)
      if (prev) {
        pageWhere.push(desc
          ? "(COALESCE(m.scheduled_at,'') < ? OR (COALESCE(m.scheduled_at,'') = ? AND m.id < ?))"
          : "(COALESCE(m.scheduled_at,'') > ? OR (COALESCE(m.scheduled_at,'') = ? AND m.id > ?))")
        pageArgs.push(prev.k, prev.k, prev.id)
      }
    } else {
      pageWhere.push(`m.id ${desc ? '<' : '>'} ?`)
      pageArgs.push(cursor)
    }
  }
  const order = scheduled
    ? `ORDER BY COALESCE(m.scheduled_at,'') ${desc ? 'DESC' : 'ASC'}, m.id ${desc ? 'DESC' : 'ASC'}`
    : `ORDER BY m.id ${desc ? 'DESC' : 'ASC'}`
  const sql = `SELECT m.*, l.email AS lead_email, l.first_name, l.last_name, l.company,
      c.name AS campaign_name, mb.email AS mailbox_email
    ${base}${pageWhere.length ? ` AND ${pageWhere.join(' AND ')}` : ''} ${order} LIMIT ?`
  const rows = db.prepare(sql).all(...pageArgs, limit + 1)

  const at = now()
  const out = rows.map((m) => ({
    rowType: 'message',
    id: m.id,
    cursor_key: m.id,
    threadKey: m.thread_id || `m:${m.id}`,
    campaign: m.campaign_id ? { id: m.campaign_id, name: m.campaign_name } : null,
    mailbox: m.mailbox_id ? { id: m.mailbox_id, email: m.mailbox_email } : null,
    lead: m.lead_id ? { id: m.lead_id, email: m.lead_email, first_name: m.first_name, last_name: m.last_name, company: m.company } : null,
    subject: m.subject,
    body: m.body,
    sent_from: m.from_email,
    sent_to: m.to_email,
    sequence_number: m.sequence_number || 0,
    manual_reply: !!m.manual_reply,
    forwarded_to: m.forwarded_to || '',
    scheduled_at: m.scheduled_at || '',
    is_overdue: scheduled && !!m.scheduled_at && Date.parse(m.scheduled_at) < at.getTime(),
    send_status: m.send_status || (m.provider_message_id ? 'sent' : ''),
    stats: {
      opened_at: m.opened_at || '',
      clicked_at: m.clicked_at || '',
      // "not opened" and "we cannot know" are different answers (get-sent.md).
      open_tracking_known: !!m.tracking_token,
    },
    created_at: m.created_at,
  }))
  return { ...paged(out, limit, 'cursor_key'), total_count: total }
}

// The unread predicate, in one place, so the badge and the list agree.
function unreadCount(wsId, callerEmail) {
  const filters = parseFilters({ state: 'unread' }, wsId)
  const at = now()
  const { where, args } = threadPredicate(filters, wsId, callerEmail, at)
  const sql = `${threadSelect(wsId)} SELECT COUNT(*) AS n FROM r WHERE ${where.join(' AND ')}`
  return db.prepare(sql).get(wsId, ...args).n
}

// ------------------------------------------------------------ state writing --

// One writer for read / archived / snoozed / important. Every column lives on
// `messages`, so a thread-level change writes every row of the thread inside
// one transaction — a half-archived thread is not a state this can produce.
//
// Each conversation is its own unit of success or failure, though. This used to
// wrap the whole loop in a single transaction, which made a batch
// all-or-nothing: select five conversations, have one turn out to be deleted,
// and the 404 rolled back the four that had worked. The results were then built
// with a literal `ok: true` on every row — so a batch that had silently done
// nothing was indistinguishable from one that had done everything.
//
// The transaction moved inside the loop rather than disappearing. A thread stays
// atomic across its own messages, which is the guarantee worth keeping. A batch
// does not, because the conversations in it are unrelated and one being gone
// says nothing about the others.
function applyThreadState(wsId, actor, anchorIds, patch) {
  const results = []
  // Two ids in the same conversation are one piece of work, and resolution is
  // what reveals that — so the de-duplication happens here rather than in the
  // caller, which only has raw message ids to go on.
  const done = new Set()
  for (const id of anchorIds) {
    try {
      tx(() => {
        const { messages, anchorId } = resolveThread(wsId, id)
        if (done.has(anchorId)) return
        done.add(anchorId)
        const ids = messages.map((m) => m.id)
        const marks = ids.map(() => '?').join(',')
        if (patch.read !== undefined) {
          if (patch.read) db.prepare(`UPDATE messages SET is_read = 1, read_at = ?, read_by = ? WHERE id IN (${marks})`).run(nowIso(), actor, ...ids)
          else db.prepare(`UPDATE messages SET is_read = 0, read_at = '', read_by = '' WHERE id IN (${marks})`).run(...ids)
        }
        if (patch.archived !== undefined) {
          if (patch.archived) db.prepare(`UPDATE messages SET archived_at = ?, archived_by = ? WHERE id IN (${marks})`).run(nowIso(), actor, ...ids)
          else db.prepare(`UPDATE messages SET archived_at = '', archived_by = '' WHERE id IN (${marks})`).run(...ids)
        }
        if (patch.snoozedUntil !== undefined) {
          if (patch.snoozedUntil) db.prepare(`UPDATE messages SET snoozed_until = ?, snoozed_by = ? WHERE id IN (${marks})`).run(patch.snoozedUntil, actor, ...ids)
          else db.prepare(`UPDATE messages SET snoozed_until = '', snoozed_by = '' WHERE id IN (${marks})`).run(...ids)
        }
        if (patch.important !== undefined) {
          // The actor is recorded for un-starring as well as starring. It is not
          // only attribution: `important_by` is what tells the automatic scorer
          // a person has already ruled here, and clearing it on un-star would
          // let the next re-score put the star straight back.
          db.prepare(`UPDATE messages SET is_important = ?, important_by = ? WHERE id IN (${marks})`)
            .run(patch.important ? 1 : 0, actor, ...ids)
        }
        const after = db.prepare(`SELECT * FROM messages WHERE id IN (${marks}) ORDER BY id`).all(...ids)
        results.push({ id: messages[0].id, ok: true, ...threadState(after) })
      })
    } catch (err) {
      // The row carries its own verdict. `resolveThread` throws the same
      // not-found this surface throws everywhere else, so a caller sees the
      // familiar status and message against the id that caused it rather than
      // against the batch.
      results.push({
        id: Number(id),
        ok: false,
        status: err?.status ?? 500,
        error: err?.body?.error ?? 'server_error',
        message: err?.body?.message ?? 'That conversation could not be updated',
      })
    }
  }
  return results
}

function readStatePatch(body) {
  const patch = {}
  if (body?.read !== undefined) {
    if (typeof body.read !== 'boolean') throw invalid('read', 'read must be a boolean value')
    patch.read = body.read
  }
  if (body?.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw invalid('archived', 'archived must be a boolean value')
    patch.archived = body.archived
  }
  if (body?.important !== undefined) {
    if (typeof body.important !== 'boolean') throw invalid('important', 'important must be a boolean value')
    patch.important = body.important
  }
  if (body?.snoozedUntil !== undefined) {
    if (body.snoozedUntil === null || body.snoozedUntil === '') patch.snoozedUntil = ''
    else {
      const when = new Date(String(body.snoozedUntil))
      if (Number.isNaN(when.getTime())) throw invalid('snoozedUntil', 'snoozedUntil must be an ISO 8601 datetime or null')
      patch.snoozedUntil = when.toISOString()
    }
  }
  if (Object.keys(patch).length === 0) {
    throw invalid('read', 'Send at least one of read, archived, important or snoozedUntil')
  }
  return patch
}

const patchSummary = (patch) => Object.entries(patch).map(([k, v]) => `${k}=${v === '' ? 'null' : v}`).join(' ')

// ------------------------------------------------------------------- routes --

export function register(api) {
  // ---- on-demand provider sync (Inbox polls this every ~10s) ---------------
  // Pulls recent Gmail/Outlook replies into Harry now, instead of waiting for
  // the engine upkeep pass. Scoped to the caller's workspace only.
  // Tight cap: the Inbox client polls this every ~10s. Without a dedicated
  // limit a logged-in loop burns the workspace's Gmail quota and disables reply
  // sync fleet-wide. 30/min is well above honest polling and well below abuse.
  api.post('/inbox/sync', rateLimit({
    windowMs: 60_000,
    max: 30,
    key: 'inbox-sync',
    by: (req) => sessionUid(req) || req.wsId,
    message: 'Sync is rate-limited — wait a moment and try again',
  }), handler(async (req) => {
    const t0 = Date.now()
    const result = await pullWorkspaceInbound(req.wsId)
    meter('inbox.sync', Date.now() - t0, true,
      `mailboxes=${result.mailboxes} attached=${result.attached} untracked=${result.untracked}`)
    if (result.attached || result.untracked) {
      audit(req, {
        type: 'inbox_synced',
        detail: `${result.mailboxes} mailbox(es) — scanned ${result.scanned}, attached ${result.attached}, untracked ${result.untracked}`,
      })
    }
    return { ok: true, ...result }
  }))

  // ---- the one list ---------------------------------------------------------

  api.get('/inbox/threads', handler(async (req) => {
    const t0 = Date.now()
    // A saved view is a stored argument list expanded here, so a view and an
    // ad-hoc filter set travel the exact same query path.
    let source = req.query
    if (req.query.viewId !== undefined && req.query.viewId !== '') {
      const view = owned('inbox_views', req.query.viewId, req.wsId, 'view')
      let stored = {}
      try { stored = JSON.parse(view.filters || '{}') } catch { stored = {} }
      source = { ...stored, ...req.query }
      delete source.viewId
    }
    const filters = parseFilters(source, req.wsId)
    const { limit, cursor } = page(req.query, { defaultLimit: 20, maxLimit: 20 })
    const result = MESSAGE_STATES.has(filters.state)
      ? listMessages(req.wsId, filters, { limit, cursor })
      : listThreads(req.wsId, req.user.email, filters, { limit, cursor })
    meter('inbox.threads', Date.now() - t0, true, `state=${filters.state} n=${result.items.length}`)
    return { ...result, state: filters.state, sort: filters.sort, limit }
  }))

  api.get('/inbox/unread-count', handler((req) => ({ count: unreadCount(req.wsId, req.user.email) })))

  api.get('/inbox/threads/:id', handler((req) => {
    const { tkey, anchorId, messages } = resolveThread(req.wsId, req.params.id)
    // A GET never marks anything read: a prefetch must not clear a badge.
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    const lead = anchor.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(anchor.lead_id, req.wsId) : null
    const campaign = anchor.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(anchor.campaign_id, req.wsId) : null
    const cl = campaign && lead
      ? db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
      : null
    // An SMS thread carries the sender it speaks through, so the composer can
    // name the number a reply leaves from.
    const channel = messages.some((m) => m.channel === 'sms') ? 'sms' : 'email'
    const accountRow = channel === 'sms'
      ? (() => {
        const withAccount = messages.find((m) => m.channel_account_id)
        return withAccount
          ? db.prepare('SELECT id, provider, display_name, phone_number, status, is_suspended FROM channel_accounts WHERE id = ? AND workspace_id = ?')
            .get(withAccount.channel_account_id, req.wsId)
          : null
      })()
      : null
    return {
      id: anchorId,
      threadKey: tkey,
      channel,
      smsAccount: accountRow ? {
        id: accountRow.id,
        provider: accountRow.provider,
        displayName: accountRow.display_name || '',
        phoneNumber: accountRow.phone_number || '',
        sendable: accountRow.status === 'connected' && !accountRow.is_suspended,
      } : null,
      ...threadState(messages),
      lead,
      campaign: campaign ? { id: campaign.id, name: campaign.name, status: campaign.status } : null,
      campaignLead: cl ? { ...cl, revenue: revenueOf(cl) } : null,
      reminders: remindersFor(req.wsId, tkey),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        channel: m.channel || 'email',
        subject: m.subject,
        body: m.body,
        from_email: m.from_email,
        to_email: m.to_email,
        // Who else got it. The spec asks for copied recipients to be "recorded
        // in the thread view", and a reply that quietly went to three people is
        // exactly the thing you need to see when picking the conversation up.
        cc_emails: m.cc_emails || '',
        bcc_emails: m.bcc_emails || '',
        // Always as a pair. The score alone is the thing the spec rules out.
        importance_score: m.importance_score || 0,
        importance_reasons: parseReasons(m.importance_reasons),
        intent: m.intent || '',
        node_id: m.node_id || '',
        sequence_number: m.sequence_number || 0,
        manual_reply: !!m.manual_reply,
        forwarded_to: m.forwarded_to || '',
        forwarded_at: m.forwarded_at || '',
        scheduled_at: m.scheduled_at || '',
        send_status: m.send_status || (m.direction === 'out' && m.provider_message_id ? 'sent' : ''),
        opened_at: m.opened_at || '',
        clicked_at: m.clicked_at || '',
        read_at: m.read_at || '',
        created_at: m.created_at,
      })),
    }
  }))

  // ---- read / archive / snooze / important ---------------------------------

  api.patch('/inbox/threads/:id', handler((req) => {
    const patch = readStatePatch(req.body)
    const { anchorId } = resolveThread(req.wsId, req.params.id)
    const [result] = applyThreadState(req.wsId, req.user.email, [anchorId], patch)
    const anchor = db.prepare('SELECT * FROM messages WHERE id = ?').get(anchorId)
    audit(req, {
      campaignId: anchor.campaign_id, leadId: anchor.lead_id,
      type: 'inbox_state', detail: `${patchSummary(patch)} by ${req.user.email}`,
    })
    return { ok: true, ...result, updated_at: nowIso() }
  }))

  // Bulk sibling.
  //
  // Ownership is still checked for every id before anything is written, and one
  // id the caller does not own still refuses the whole call. That is deliberate
  // and it is why this diverges from mark-read.md TC-9, which asks for partial
  // success with a per-row 404: an id outside the workspace is not a stale row,
  // it is a question about somebody else's data, and answering "that one
  // failed, the rest worked" confirms the others exist. TC-9's own premise — a
  // conversation deleted mid-batch — is not reachable here anyway, because
  // Harry has no route that deletes one; archiving is as far as it goes.
  //
  // What did change is that the per-row results are now real. Each conversation
  // gets its own transaction, so a row that vanishes underneath the write (a
  // cascade from a deleted campaign or lead, say) fails alone instead of
  // rolling back the other forty-nine, and `updated` counts what actually
  // changed rather than being a hardcoded `ok: true` on every row.
  api.patch('/inbox/threads', handler((req) => {
    const patch = readStatePatch(req.body)
    const ids = idList(req.body, 'ids', { required: true, max: 500 })
    for (const id of ids) resolveThread(req.wsId, id) // throws 404 on anything not ours
    const results = applyThreadState(req.wsId, req.user.email, [...new Set(ids)], patch)
    const updated = results.filter((r) => r.ok).length
    const failed = results.length - updated
    audit(req, {
      type: 'inbox_state_bulk',
      detail: `${patchSummary(patch)} on ${updated} thread${updated === 1 ? '' : 's'}` +
        `${failed ? ` (${failed} could not be updated)` : ''} by ${req.user.email}`,
    })
    return {
      // `ok` is about the request, which was understood and acted on. Whether
      // every row succeeded is `updated` and `failed` — collapsing those into
      // one boolean is what hid this in the first place.
      ok: true,
      requested: results.length,
      updated,
      failed,
      results,
      updated_at: nowIso(),
    }
  }))

  // ---- saved views ----------------------------------------------------------

  api.get('/inbox/views', handler((req) => {
    const rows = db.prepare('SELECT * FROM inbox_views WHERE workspace_id = ? ORDER BY sort, id').all(req.wsId)
    return rows.map((v) => {
      let filters = {}
      try { filters = JSON.parse(v.filters || '{}') } catch { filters = {} }
      // A view whose campaign was deleted is reported broken, never silently
      // run unfiltered.
      const broken = []
      for (const id of [].concat(filters.campaignId || [])) {
        if (!db.prepare('SELECT 1 FROM campaigns WHERE id = ? AND user_id = ?').get(id, req.wsId)) broken.push(`campaignId:${id}`)
      }
      for (const id of [].concat(filters.mailboxId || [])) {
        if (!db.prepare('SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, req.wsId)) broken.push(`mailboxId:${id}`)
      }
      return { ...v, filters, is_broken: broken.length > 0, broken }
    })
  }))

  api.post('/inbox/views', handler((req) => {
    const name = str(req.body, 'name', { required: true, max: 80 })
    const filters = validateViewFilters(req.body?.filters, req.wsId)
    if (db.prepare('SELECT 1 FROM inbox_views WHERE workspace_id = ? AND name = ?').get(req.wsId, name)) {
      throw invalid('name', 'A view with that name already exists')
    }
    const info = tx(() => db.prepare(
      'INSERT INTO inbox_views (workspace_id, name, filters, is_shared, created_by, sort) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.wsId, name, JSON.stringify(filters), bool(req.body, 'isShared', true) ? 1 : 0, req.user.email, int(req.body, 'sort', { fallback: 0 })))
    audit(req, { type: 'inbox_view_created', detail: `${name} by ${req.user.email}` })
    return db.prepare('SELECT * FROM inbox_views WHERE id = ?').get(info.lastInsertRowid)
  }))

  api.patch('/inbox/views/:id', handler((req) => {
    const view = owned('inbox_views', req.params.id, req.wsId, 'view')
    const name = req.body?.name === undefined ? view.name : str(req.body, 'name', { required: true, max: 80 })
    if (name !== view.name && db.prepare('SELECT 1 FROM inbox_views WHERE workspace_id = ? AND name = ?').get(req.wsId, name)) {
      throw invalid('name', 'A view with that name already exists')
    }
    const filters = req.body?.filters === undefined ? view.filters : JSON.stringify(validateViewFilters(req.body.filters, req.wsId))
    tx(() => db.prepare("UPDATE inbox_views SET name = ?, filters = ?, is_shared = ?, sort = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, filters, req.body?.isShared === undefined ? view.is_shared : (bool(req.body, 'isShared') ? 1 : 0),
        req.body?.sort === undefined ? view.sort : int(req.body, 'sort', { fallback: 0 }), view.id))
    audit(req, { type: 'inbox_view_updated', detail: `${name} by ${req.user.email}` })
    return db.prepare('SELECT * FROM inbox_views WHERE id = ?').get(view.id)
  }))

  api.delete('/inbox/views/:id', handler((req) => {
    const view = owned('inbox_views', req.params.id, req.wsId, 'view')
    tx(() => db.prepare('DELETE FROM inbox_views WHERE id = ?').run(view.id))
    audit(req, { type: 'inbox_view_deleted', detail: `${view.name} by ${req.user.email}` })
    return { ok: true }
  }))

  // ---- untracked replies ----------------------------------------------------
  // A reply that matched no lead is never silently dropped; a human attaches
  // it or dismisses it, and both are recorded.

  api.get('/inbox/unmatched', handler((req) => {
    const { limit, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 100 })
    const status = oneOf(req.query, 'status', ['new', 'attached', 'dismissed', 'all'], { fallback: 'new' })
    const where = ['workspace_id = ?']
    const args = [req.wsId]
    if (status !== 'all') { where.push('status = ?'); args.push(status) }
    for (const [field, col] of [['from', 'from_email'], ['subject', 'subject']]) {
      const value = str(req.query, field, { max: 200, fallback: '' })
      if (value) { where.push(`LOWER(${col}) LIKE ?`); args.push(`%${value.toLowerCase()}%`) }
    }
    if (cursor) { where.push('id < ?'); args.push(cursor) }
    const withBody = bool(req.query, 'withBody', false)
    const rows = db.prepare(`SELECT * FROM unmatched_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1)
    const shaped = rows.map((r) => (withBody ? r : { ...r, body: '' }))
    return paged(shaped, limit)
  }))

  api.post('/inbox/unmatched/:id/attach', handler(async (req) => {
    const row = owned('unmatched_messages', req.params.id, req.wsId, 'message')
    if (row.status !== 'new') throw invalid('id', `That message was already ${row.status}`)
    const leadId = int(req.body, 'leadId', { required: true, min: 1 })
    const campaignId = req.body?.campaignId ? int(req.body, 'campaignId', { min: 1 }) : 0
    const lead = owned('leads', leadId, req.wsId, 'lead')
    const campaign = campaignId ? owned('campaigns', campaignId, req.wsId, 'campaign') : null

    let messageId = null
    tx(() => {
      if (campaign) {
        // Attaching creates the pairing if it is missing, so the reply has
        // somewhere to live — but never creates a campaign.
        db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, ?, ?)')
          .run(campaign.id, lead.id, 'waiting', row.thread_id || '')
      }
      // Intent is left empty on purpose: the engine's own classifier picks it
      // up on the next tick, so an attached reply and a matched one are
      // classified by exactly one code path.
      const info = db.prepare(
        `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id, intent)
         VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, '')`
      ).run(req.wsId, campaign ? campaign.id : null, lead.id, row.mailbox_id, row.subject, row.body, row.from_email, '', row.provider_message_id, row.thread_id || '')
      messageId = Number(info.lastInsertRowid)
      db.prepare("UPDATE unmatched_messages SET status = 'attached', attached_lead_id = ?, resolved_by = ? WHERE id = ?")
        .run(lead.id, req.user.email, row.id)
    })
    audit(req, { campaignId: campaign?.id ?? null, leadId: lead.id, type: 'unmatched_attached', detail: `${row.from_email} by ${req.user.email}` })
    return { ok: true, messageId, leadId: lead.id, campaignId: campaign?.id ?? null }
  }))

  api.post('/inbox/unmatched/:id/dismiss', handler((req) => {
    const row = owned('unmatched_messages', req.params.id, req.wsId, 'message')
    if (row.status !== 'new') throw invalid('id', `That message was already ${row.status}`)
    tx(() => db.prepare("UPDATE unmatched_messages SET status = 'dismissed', resolved_by = ? WHERE id = ?").run(req.user.email, row.id))
    audit(req, { type: 'unmatched_dismissed', detail: `${row.from_email} by ${req.user.email}` })
    return { ok: true }
  }))

  // ---- reminders ------------------------------------------------------------

  api.post('/inbox/threads/:id/reminders', handler((req) => {
    const { tkey, anchorId, messages } = resolveThread(req.wsId, req.params.id)
    const note = str(req.body, 'note', { required: true, max: 2000 })
    const remindAtRaw = str(req.body, 'remindAt', { required: true, max: 40 })
    const remindAt = new Date(remindAtRaw)
    if (Number.isNaN(remindAt.getTime())) throw invalid('remindAt', 'remindAt must be an ISO 8601 datetime')
    let messageId = anchorId
    if (req.body?.messageId !== undefined) {
      messageId = int(req.body, 'messageId', { required: true, min: 1 })
      // The anchoring message must belong to this thread, not merely to the
      // workspace — otherwise the reminder points somewhere else entirely.
      if (!messages.some((m) => m.id === messageId)) throw invalid('messageId', 'messageId is not part of this conversation')
    }
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    if (!anchor.lead_id) throw invalid('id', 'That conversation is not attached to a lead')
    const info = tx(() => db.prepare(
      `INSERT INTO lead_reminders (workspace_id, lead_id, campaign_id, message_id, thread_id, reminder_at, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.wsId, anchor.lead_id, anchor.campaign_id, messageId, tkey, remindAt.toISOString(), note, req.user.email))
    audit(req, { campaignId: anchor.campaign_id, leadId: anchor.lead_id, type: 'reminder_set', detail: `${remindAt.toISOString()} by ${req.user.email}` })
    const row = db.prepare('SELECT * FROM lead_reminders WHERE id = ?').get(info.lastInsertRowid)
    return { ...row, is_overdue: Date.parse(row.reminder_at) < Date.now() }
  }))

  api.get('/reminders', handler((req) => {
    const { limit, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    const status = oneOf(req.query, 'status', ['pending', 'fired', 'cleared', 'all'], { fallback: 'pending' })
    const due = oneOf(req.query, 'due', ['overdue', 'today', 'all'], { fallback: 'all' })
    // REMINDER_TIME_ASC is the default because the view exists for a daily
    // review of what you are already late on; DESC exists so the order can be
    // reversed exactly, which is what get-reminders.md TC-7 asserts.
    const sort = oneOf(req.query, 'sort', ['reminder_asc', 'reminder_desc'], { fallback: 'reminder_asc' })
    const desc = sort === 'reminder_desc'
    const at = now()
    const where = ['workspace_id = ?']
    const args = [req.wsId]
    if (status !== 'all') { where.push('status = ?'); args.push(status) }
    if (due === 'overdue') { where.push('reminder_at < ?'); args.push(at.toISOString()) }
    if (due === 'today') {
      where.push('reminder_at >= ? AND reminder_at < ?')
      const start = new Date(at); start.setUTCHours(0, 0, 0, 0)
      const end = new Date(start.getTime() + 864e5)
      args.push(start.toISOString(), end.toISOString())
    }
    // Keyset on the tuple the rows are actually ordered by. The cursor used to
    // be `id > ?` regardless of order, which skipped and repeated rows the
    // moment reminder times and insertion order disagreed — and they always do,
    // because reminders are set for the future in whatever order people choose.
    if (cursor) {
      const prev = db.prepare('SELECT reminder_at, id FROM lead_reminders WHERE id = ? AND workspace_id = ?').get(cursor, req.wsId)
      if (prev) {
        where.push(desc
          ? '(reminder_at < ? OR (reminder_at = ? AND id < ?))'
          : '(reminder_at > ? OR (reminder_at = ? AND id > ?))')
        args.push(prev.reminder_at, prev.reminder_at, prev.id)
      }
    }
    const dir = desc ? 'DESC' : 'ASC'
    const rows = db.prepare(`SELECT * FROM lead_reminders WHERE ${where.join(' AND ')} ORDER BY reminder_at ${dir}, id ${dir} LIMIT ?`).all(...args, limit + 1)
    // Overdue is derived at read time and never stored, so it cannot drift.
    return paged(rows.map((r) => ({ ...r, is_overdue: r.status === 'pending' && Date.parse(r.reminder_at) < at.getTime() })), limit)
  }))

  api.patch('/reminders/:id', handler((req) => {
    const row = owned('lead_reminders', req.params.id, req.wsId, 'reminder')
    let remindAt = row.reminder_at
    if (req.body?.remindAt !== undefined) {
      const parsed = new Date(String(req.body.remindAt))
      if (Number.isNaN(parsed.getTime())) throw invalid('remindAt', 'remindAt must be an ISO 8601 datetime')
      remindAt = parsed.toISOString()
    }
    const note = req.body?.note === undefined ? row.note : str(req.body, 'note', { required: true, max: 2000 })
    const status = req.body?.status === undefined ? row.status : oneOf(req.body, 'status', ['pending', 'fired', 'cleared'], { required: true })
    tx(() => db.prepare('UPDATE lead_reminders SET reminder_at = ?, note = ?, status = ? WHERE id = ?').run(remindAt, note, status, row.id))
    audit(req, { campaignId: row.campaign_id, leadId: row.lead_id, type: 'reminder_updated', detail: `${status} ${remindAt} by ${req.user.email}` })
    const after = db.prepare('SELECT * FROM lead_reminders WHERE id = ?').get(row.id)
    return { ...after, is_overdue: after.status === 'pending' && Date.parse(after.reminder_at) < Date.now() }
  }))

  api.delete('/reminders/:id', handler((req) => {
    const row = owned('lead_reminders', req.params.id, req.wsId, 'reminder')
    tx(() => db.prepare('DELETE FROM lead_reminders WHERE id = ?').run(row.id))
    audit(req, { campaignId: row.campaign_id, leadId: row.lead_id, type: 'reminder_cancelled', detail: `by ${req.user.email}` })
    return { ok: true }
  }))

  // ---- sending: manual reply and forward ------------------------------------
  // Both refuse without `confirm: true`. That flag is the human OK the standing
  // rule requires; there is no other way to put mail on the wire from here.

  api.post('/inbox/threads/:id/reply', handler(async (req) => {
    refuseBypass(req.body)
    const { tkey, messages } = resolveThread(req.wsId, req.params.id)
    const body = str(req.body, 'body', { required: true, max: 50000 })
    if (req.body?.confirm !== true) throw invalid('confirm', 'Nothing sends without your OK — send confirm: true')

    // ---- SMS thread: the reply is a text, sent through the thread's own
    // channel account. No subject, no copies, no scheduling — a text is a text.
    if (messages.some((m) => m.channel === 'sms')) {
      if (body.length > 1600) throw invalid('body', 'An SMS reply can be at most 1600 characters')
      for (const field of ['cc', 'bcc', 'subject', 'sendAt']) {
        if (req.body?.[field] !== undefined && req.body[field] !== '' && req.body[field] !== null) {
          throw invalid(field, `${field} does not apply to an SMS reply`)
        }
      }
      refuseAttachments(req.body)
      const smsAnchor = messages.find((m) => m.channel_account_id) || messages[0]
      const account = smsAnchor.channel_account_id
        ? db.prepare('SELECT * FROM channel_accounts WHERE id = ? AND workspace_id = ?')
          .get(smsAnchor.channel_account_id, req.wsId)
        : null
      if (!account || account.deleted_at) {
        throw invalid('id', 'This conversation has no connected SMS sender — reconnect one under Settings → Connections')
      }
      // The other party's number: the thread key is `sms:{account}:{phone}`,
      // written by both send paths and the webhook alike.
      const keyPhone = tkey.startsWith('sms:') ? tkey.split(':')[2] : ''
      const lastIn = [...messages].reverse().find((m) => m.direction === 'in')
      const to = toE164(keyPhone || lastIn?.from_email || '')
      if (!to) throw invalid('id', 'This conversation has no phone number to reply to')
      const smsLead = smsAnchor.lead_id
        ? db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(smsAnchor.lead_id, req.wsId)
        : null

      let sent
      try {
        sent = await sendManualSms({
          wsId: req.wsId,
          account,
          lead: smsLead,
          to,
          body,
          threadId: smsAnchor.thread_id || '',
          campaignId: smsAnchor.campaign_id || null,
        })
      } catch (err) {
        // A refusal is a 422 naming the conversation, not a crash.
        if (err instanceof SuppressedError) throw invalid('id', err.message)
        throw err
      }
      audit(req, {
        campaignId: smsAnchor.campaign_id, leadId: smsAnchor.lead_id,
        type: 'manual_reply', detail: `sms → ${to} by ${req.user.email}`,
      })
      meter('inbox.reply', 0, true, `sms:${account.phone_number || account.id}`)
      return { ok: true, scheduled: false, channel: 'sms', messageId: sent.messageId, threadId: sent.threadId, cc: [], bcc: [] }
    }
    // reply.md asks for attachments. This route used to read no such field, so
    // a composer that sent one got a 200 and an email with nothing attached —
    // the same shape as the cc/bcc defect: accepted, echoed nowhere, never
    // sent. Neither provider path can carry a file yet (server/mailer.js and
    // server/google.js build a text/HTML alternative and nothing else), so the
    // honest answer is the one server/parity/utilities.js already gives on its
    // own send route: refuse, and say why.
    refuseAttachments(req.body)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    const campaign = anchor.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(anchor.campaign_id, req.wsId) : null
    const lead = anchor.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(anchor.lead_id, req.wsId) : null
    const mailbox = anchor.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(anchor.mailbox_id, req.wsId) : null
    if (!campaign || !lead || !mailbox) throw invalid('id', 'That conversation is missing its campaign, lead or mailbox')
    // One check, covering the block list, unsubscribes and hard bounces alike.
    // This used to guard only `unsubscribed`, so a bounced lead reached the
    // transport, which threw SuppressedError straight out of the handler as an
    // HTTP 500 — a refusal presented as a crash.
    // 422 with a named field, matching every other refusal on this module so
    // the UI's existing {field, message} handling renders it. The defect being
    // fixed here is the *500*: this used to guard `unsubscribed` only, so a
    // bounced lead reached the transport and SuppressedError escaped as a crash.
    const blocked = suppressionFor(req.wsId, { address: lead.email, lead })
    if (blocked) throw invalid('id', blocked.message)

    // Copied recipients. This route is the one the Inbox actually calls, and it
    // used to have no cc/bcc at all — the contract lived only on the campaigns
    // reply route, so the mail client could not copy anybody. `sendEmail` takes
    // both, checks suppression on every one of them, and records them on the
    // message row, so nothing here re-implements any of that.
    const cc = addressList(req.body, 'cc')
    const bcc = addressList(req.body, 'bcc')
    // Checked here as well as in `sendEmail`. The transport's check is the one
    // that makes the rule true, but it raises SuppressedError, which escapes a
    // handler as an HTTP 500 — a refusal presented as a crash, exactly the
    // defect already fixed above for the lead's own address. Naming the field
    // turns it into the 422 the composer knows how to render.
    for (const [field, list] of [['cc', cc], ['bcc', bcc]]) {
      for (const address of list) {
        const stop = suppressionFor(req.wsId, { address })
        if (stop) throw invalid(field, `${address} — ${stop.message}`)
      }
    }

    const lastSubject = messages[messages.length - 1].subject || ''
    const subject = str(req.body, 'subject', { max: 500, fallback: lastSubject.startsWith('Re:') ? lastSubject : `Re: ${lastSubject}` })
    const sendAtRaw = str(req.body, 'sendAt', { max: 40, fallback: '' })
    const sendAt = sendAtRaw ? new Date(sendAtRaw) : null
    if (sendAtRaw && Number.isNaN(sendAt.getTime())) throw invalid('sendAt', 'sendAt must be an ISO 8601 datetime')

    // Appended once. A reply drafted from a previous one already quotes the
    // signature back, and appending again is the failure users notice.
    const signature = String(mailbox.signature || '').trim()
    const wantsSignature = bool(req.body, 'addSignature', false) || bool(req.body, 'add_signature', false)
    const outgoing = wantsSignature && signature && !body.includes(signature)
      ? `${body.trimEnd()}\n\n${signature}`
      : body

    if (sendAt && sendAt.getTime() > Date.now()) {
      // Queued, not sent. Cancellable through DELETE /api/scheduled/:id, and
      // the pacing engine decides the actual minute when it comes due. The
      // copies are written now so they survive the wait rather than being
      // reconstructed from a request that is long gone.
      const info = tx(() => db.prepare(
        `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, cc_emails, bcc_emails, thread_id, node_id, manual_reply, scheduled_at, send_status, is_read, read_at)
         VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?, 'queued', 1, ?)`
      ).run(req.wsId, campaign.id, lead.id, mailbox.id, subject, outgoing, mailbox.email, lead.email,
        cc.join(', '), bcc.join(', '), anchor.thread_id || '', sendAt.toISOString(), nowIso()))
      audit(req, { campaignId: campaign.id, leadId: lead.id, type: 'manual_reply_scheduled', detail: `${sendAt.toISOString()} by ${req.user.email}` })
      return { ok: true, scheduled: true, messageId: Number(info.lastInsertRowid), scheduledAt: sendAt.toISOString(), cc, bcc }
    }

    // The same send path agent email uses: same quota, same tracking pixel,
    // same opt-out footer, same List-Unsubscribe header — and the same
    // suppression check on every copied recipient, because being cc'd is still
    // being emailed.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
    const sent = await sendEmail({ mailbox, user: user || { id: req.wsId }, campaign, lead, nodeId: 'manual', subject, body: outgoing, cc, bcc })
    // Scoped by user_id on both the read and the write. `provider_message_id` is
    // a provider-assigned string that is unique only within an account, not
    // across workspaces, so an unscoped lookup could match — and flip
    // manual_reply / send_status on — another workspace's message row.
    const written = db.prepare('SELECT id FROM messages WHERE provider_message_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(sent.providerMessageId, req.wsId)
    if (written) {
      db.prepare("UPDATE messages SET manual_reply = 1, send_status = 'sent' WHERE id = ? AND user_id = ?").run(written.id, req.wsId)
    }
    audit(req, {
      campaignId: campaign.id, leadId: lead.id, type: 'manual_reply',
      detail: `by ${req.user.email}${cc.length ? `, cc ${cc.join(', ')}` : ''}${bcc.length ? `, bcc ${bcc.length}` : ''}`,
    })
    meter('inbox.reply', 0, true, mailbox.email)
    return { ok: true, scheduled: false, messageId: written?.id ?? null, threadId: sent.threadId, cc, bcc, signed: outgoing !== body }
  }))

  // Harry's own forward contract. The source page documents no request fields
  // at all, so nothing here is guessed from it: the caller names the
  // recipients, an optional note and whether to include the quoted chain, and
  // the chain itself is rebuilt server-side from stored messages.
  api.post('/threads/:messageId/forward', handler(async (req) => {
    refuseBypass(req.body)
    const { messages } = resolveThread(req.wsId, req.params.messageId)
    const to = emailField(req.body, 'to', { required: true })
    const cc = addressList(req.body, 'cc')
    const bcc = addressList(req.body, 'bcc')
    if (req.body?.confirm !== true) throw invalid('confirm', 'Nothing sends without your OK — send confirm: true')
    // Suppression parity with the reply route. This used to call
    // assertNotBlocked, which checks the block list only, so a forward to an
    // unsubscribed or hard-bounced address passed here and was refused deep in
    // gmailSend as a SuppressedError — which escapes a handler as an HTTP 500.
    // suppressionFor covers block list + unsubscribes + bounces, and each is a
    // clean 422 naming the field, exactly as the reply route does it.
    for (const [field, list] of [['to', [to]], ['cc', cc], ['bcc', bcc]]) {
      for (const address of list) {
        const stop = suppressionFor(req.wsId, { address })
        if (stop) throw invalid(field, `${address} — ${stop.message}`)
      }
    }

    const source = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(Number(req.params.messageId), req.wsId)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    const mailbox = anchor.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(anchor.mailbox_id, req.wsId) : null
    if (!mailbox) throw invalid('messageId', 'That conversation has no mailbox to forward from')
    const includeThread = bool(req.body, 'includeThread', true)
    const note = str(req.body, 'note', { max: 5000, fallback: '' })
    const subject = str(req.body, 'subject', { max: 500, fallback: `Fwd: ${(source || anchor).subject || ''}`.trim() })

    // Built here, from stored rows, so a client cannot inject content into the
    // quoted chain. Tracking pixels and click wrappers never leave with it.
    const chain = (includeThread ? messages : [source || anchor])
      .map((m) => `--- ${m.direction === 'in' ? 'From' : 'To'} ${m.direction === 'in' ? m.from_email : m.to_email} (${m.created_at}) ---\n${stripTracking(m.body)}`)
      .join('\n\n')
    const composed = note ? `${note}\n\n${chain}` : chain

    let providerMessageId = `fwd-${Date.now().toString(36)}`
    if (mailbox.provider === 'gmail') {
      // Imported lazily: a sandbox workspace must never need Google wired up.
      const { gmailSend } = await import('../google.js')
      // to, cc and bcc are passed as first-class params so gmailSend builds a
      // proper Bcc: header that Gmail strips from every delivered copy. Joining
      // them all into `to` (as this used to) exposed the blind-copied
      // recipients to everyone in the To: line — the opposite of blind.
      const result = await gmailSend(mailbox, { to, cc, bcc, subject, body: composed, workspaceId: req.wsId })
      providerMessageId = result.messageId
    } else if (mailbox.provider !== 'sandbox') {
      // Only the sandbox may pretend: an Outlook mailbox used to fall through
      // here, write a `sent` row, and no email ever left.
      throw new HttpError(501, {
        error: 'not_implemented',
        message: `${mailbox.provider} mailboxes cannot forward yet — use a Gmail mailbox`,
      })
    }
    const info = tx(() => db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id, node_id, forwarded_at, forwarded_to, send_status, is_read, read_at)
       VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, 'forward', ?, ?, 'sent', 1, ?)`
    ).run(req.wsId, anchor.campaign_id, anchor.lead_id, mailbox.id, subject, composed, mailbox.email, to,
      providerMessageId, anchor.thread_id || '', nowIso(), [to, ...cc, ...bcc].join(','), nowIso()))
    audit(req, {
      campaignId: anchor.campaign_id, leadId: anchor.lead_id, type: 'forwarded',
      detail: `${1 + cc.length + bcc.length} recipient(s) by ${req.user.email}`,
    })
    meter('inbox.forward', 0, true, mailbox.email)
    return { ok: true, messageId: Number(info.lastInsertRowid), to, cc, bcc, recipients: 1 + cc.length + bcc.length }
  }))

  api.get('/messages/:messageId/status', handler((req) => {
    const raw = String(req.params.messageId)
    const msg = /^\d+$/.test(raw)
      ? db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(Number(raw), req.wsId)
      : db.prepare('SELECT * FROM messages WHERE provider_message_id = ? AND user_id = ?').get(raw, req.wsId)
    // Identical body for a cross-workspace id and a genuine miss.
    if (!msg) throw notFound('message')
    const status = msg.send_status || (msg.direction === 'out' ? (msg.provider_message_id ? 'sent' : 'queued') : 'sent')
    return {
      id: msg.id,
      providerMessageId: msg.provider_message_id || '',
      status,
      statusMessage: STATUS_MESSAGE[status] || '',
      eventTime: msg.created_at,
      scheduledAt: msg.scheduled_at || '',
      terminal: ['sent', 'failed', 'cancelled'].includes(status),
    }
  }))

  // Cancel a queued send. Atomic: the UPDATE only matches while the row is
  // still in the status it expects, so a race with the engine either cancels or
  // sends, not both.
  //
  // A row stranded in 'sending' — the process was killed between upkeep.js
  // flipping it to 'sending' and writing a terminal status — used to be
  // uncancellable forever, because this only matched 'queued'. Once it has sat
  // in 'sending' well past any real send (SENDING_STALE_MS), it is treated as
  // dead and may be reclaimed to 'cancelled' from here. There is no column
  // recording when it entered 'sending', so the reference time is scheduled_at
  // (it flips to 'sending' at or just after that) or created_at for an
  // immediate send. The proper systemic reset belongs in upkeep.js (owned by
  // another agent); this reclaim path is the user-facing escape hatch.
  api.delete('/scheduled/:id', handler((req) => {
    const msg = owned('messages', req.params.id, req.wsId, 'scheduled message')
    let changed = tx(() => db.prepare(
      "UPDATE messages SET send_status = 'cancelled' WHERE id = ? AND user_id = ? AND send_status = 'queued'"
    ).run(msg.id, req.wsId).changes)
    let reclaimed = false
    if (!changed && msg.send_status === 'sending') {
      const ref = msg.scheduled_at || msg.created_at || ''
      const refMs = ref ? Date.parse(ref.includes('T') ? ref : `${ref.replace(' ', 'T')}Z`) : NaN
      if (!Number.isFinite(refMs) || Date.now() - refMs < SENDING_STALE_MS) {
        throw invalid('id', 'That message is being sent right now — wait a few minutes before cancelling')
      }
      changed = tx(() => db.prepare(
        "UPDATE messages SET send_status = 'cancelled' WHERE id = ? AND user_id = ? AND send_status = 'sending'"
      ).run(msg.id, req.wsId).changes)
      reclaimed = !!changed
    }
    if (!changed) throw invalid('id', 'That message is no longer queued')
    audit(req, {
      campaignId: msg.campaign_id, leadId: msg.lead_id,
      type: reclaimed ? 'scheduled_reclaimed' : 'scheduled_cancelled',
      detail: `by ${req.user.email}${reclaimed ? ' (stranded in sending)' : ''}`,
    })
    return { ok: true, reclaimed }
  }))

  // ---- lead triage on the pairing -------------------------------------------

  api.patch('/campaign-leads/:id/revenue', handler((req) => {
    const cl = ownedPairing(req.params.id, req.wsId)
    const raw = req.body?.amount
    if (raw === undefined) throw invalid('amount', 'amount is required (a non-negative number, or null to clear)')
    let amountMinor = 0
    if (raw !== null) {
      const value = Number(raw)
      if (!Number.isFinite(value)) throw invalid('amount', 'amount must be a number')
      if (value < 0) {
        throw new HttpError(422, { error: 'validation_failed', field: 'amount', message: 'amount must not be negative', provided_value: value })
      }
      amountMinor = minor(value)
    }
    const currency = str(req.body, 'currency', { max: 3, fallback: cl.revenue_currency || 'USD' }).toUpperCase()
    const previous = Math.round(cl.revenue_amount || 0)
    const wasRecorded = !!cl.revenue_updated_at
    // Clearing empties `revenue_updated_at` as well as the amount. Zero is a
    // real answer people record deliberately ("we won it, it was free"), and
    // leaving the timestamp behind on a clear made a cleared row and a recorded
    // zero identical in the database — so the UI could only ever show one of
    // them. Who cleared it, and when, is in the events trail below.
    tx(() => db.prepare('UPDATE campaign_leads SET revenue_amount = ?, revenue_currency = ?, revenue_updated_at = ?, revenue_updated_by = ? WHERE id = ?')
      .run(amountMinor, currency, raw === null ? '' : nowIso(), raw === null ? '' : req.user.email, cl.id))
    audit(req, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'revenue_updated',
      detail: `${wasRecorded ? major(previous) : '(not recorded)'} -> ${raw === null ? 'cleared' : major(amountMinor)} ${currency} by ${req.user.email}`,
    })
    return {
      ok: true,
      id: cl.id,
      amount: raw === null ? null : major(amountMinor),
      amount_minor: amountMinor,
      currency,
      recorded: raw !== null,
      previous_amount: wasRecorded ? major(previous) : null,
      updated_at: raw === null ? '' : nowIso(),
    }
  }))

  api.patch('/campaign-leads/:id/resume', handler((req) => {
    const cl = ownedPairing(req.params.id, req.wsId)
    const delayDays = int(req.body, 'delayDays', { min: 0, max: 365, fallback: 0 })
    // Scoped by user_id for consistency with every other lead read on this
    // module, even though the pairing is already workspace-verified.
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(cl.lead_id, req.wsId)
    if (!cl.paused_at) throw invalid('id', 'That lead is not paused')
    if (lead?.status === 'unsubscribed') throw invalid('id', 'That lead has unsubscribed')
    if (lead?.status === 'bounced') throw invalid('id', 'That lead bounced')
    if (['finished', 'stopped'].includes(cl.state)) throw invalid('id', 'That lead has already finished this campaign')

    const resumeAt = delayDays > 0 ? new Date(Date.now() + delayDays * 864e5).toISOString() : ''
    tx(() => {
      if (delayDays > 0) {
        // Still paused as far as the engine is concerned until resume_at passes.
        db.prepare("UPDATE campaign_leads SET resume_at = ?, updated_at = datetime('now') WHERE id = ?").run(resumeAt, cl.id)
      } else {
        db.prepare("UPDATE campaign_leads SET paused_at = '', paused_by = '', resume_at = '', state = ?, updated_at = datetime('now') WHERE id = ?")
          .run(cl.node_id ? 'waiting' : 'queued', cl.id)
      }
    })
    audit(req, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'lead_resumed', detail: `delay ${delayDays}d${resumeAt ? ` -> ${resumeAt}` : ''} by ${req.user.email}` })
    return { ok: true, id: cl.id, delayDays, resumeAt, paused: delayDays > 0 }
  }))

  // Human correction of a reply's intent. Rerouting reuses the engine's own
  // edge-following code, so a manual change and a classifier result cannot
  // behave differently.
  api.patch('/campaign-leads/:id/intent', handler(async (req) => {
    const cl = ownedPairing(req.params.id, req.wsId)
    const intent = str(req.body, 'intent', { max: 120, fallback: '' }).toLowerCase()
    const clearing = req.body?.intent === null
    if (!intent && !clearing && req.body?.categoryId === undefined) throw invalid('intent', 'intent is required (or null to clear)')

    let categoryId = cl.category_id
    if (req.body?.categoryId !== undefined) {
      if (req.body.categoryId === null) categoryId = null
      else {
        categoryId = int(req.body, 'categoryId', { required: true, min: 1 })
        if (!db.prepare('SELECT 1 FROM lead_categories WHERE id = ? AND workspace_id = ?').get(categoryId, req.wsId)) {
          throw invalid('categoryId', `No such category: ${categoryId}`)
        }
      }
    }

    const ctx = intent ? campaignCtx(cl.campaign_id) : null
    if (intent && ctx?.graph?.valid) {
      // The intent must be a label the playbook actually offers, or a built-in.
      const labels = new Set(ctx.graph.edges.filter((e) => e.cond.kind === 'reply' && e.cond.intent).map((e) => e.cond.intent))
      const builtins = ['interested', 'not interested', 'unsubscribe', 'out of office', 'referral', 'question']
      if (!labels.has(intent) && !builtins.includes(intent)) {
        throw invalid('intent', `intent must be one of: ${[...labels, ...builtins].join(', ')}`)
      }
    }

    const previous = cl.intent || ''
    tx(() => {
      db.prepare("UPDATE campaign_leads SET intent = ?, intent_set_by = ?, intent_set_at = ?, category_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(intent, req.user.email, nowIso(), categoryId, cl.id)
      const last = db.prepare("SELECT id FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1")
        .get(cl.campaign_id, cl.lead_id)
      if (last && intent) db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(intent, last.id)
      // The one place a routing change reaches into the approval queue: a draft
      // written under the old branch must not be approvable afterwards.
      db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','approved')")
        .run(`${req.user.email} (stale after reroute)`, cl.campaign_id, cl.lead_id)
    })

    let routed = false
    if (intent && ctx?.graph?.valid && ['waiting', 'needs_attention'].includes(cl.state)) {
      db.prepare("UPDATE campaign_leads SET state = 'waiting' WHERE id = ?").run(cl.id)
      const fresh = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(cl.id)
      // A person chose this intent — say so, or an unsubscribe they confirmed
      // would be parked as if the classifier had guessed it.
      await routeReply(ctx, fresh, intent, null, { setBy: req.user.email })
      routed = true
    }
    audit(req, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'intent_corrected', detail: `${previous || '(none)'} -> ${intent || '(cleared)'} by ${req.user.email}` })
    const after = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(cl.id)
    return { ok: true, id: cl.id, intent: after.intent, categoryId: after.category_id, node_id: after.node_id, state: after.state, routed }
  }))

  api.patch('/campaign-leads/:id/assignee', handler((req) => {
    const cl = ownedPairing(req.params.id, req.wsId)
    const assignee = assigneeFrom(req.body, req.wsId)
    const previous = cl.assigned_email || ''
    tx(() => db.prepare("UPDATE campaign_leads SET assigned_email = ?, assigned_at = ?, assigned_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(assignee, assignee ? nowIso() : '', assignee ? req.user.email : '', cl.id))
    audit(req, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'assigned', detail: `${previous || '(nobody)'} -> ${assignee || '(nobody)'} by ${req.user.email}` })
    // Assignment is deliberately not an authorisation boundary: any workspace
    // member may still approve a draft for this lead.
    return { ok: true, id: cl.id, assignedTo: assignee, previous, gatesApproval: false }
  }))

  // Bulk sibling of the single assignment.
  //
  // Each pairing is its own unit of work, as it is for the bulk read/archive
  // route, and for the same reason: five selected conversations are unrelated,
  // and one of them being gone says nothing about the other four. The per-row
  // verdict is read back from the database rather than asserted — the previous
  // version returned a literal `ok: true` on every row inside one transaction,
  // so a rollback and a clean run were indistinguishable to the caller.
  //
  // Ownership is still pre-checked for every id, so a conversation belonging to
  // another workspace refuses the whole call rather than confirming, row by
  // row, which of the others exist. That is the same divergence mark-read.md
  // TC-9 already carries, stated once here rather than argued twice.
  api.patch('/campaign-leads/assignee', handler((req) => {
    const ids = idList(req.body, 'ids', { required: true, max: 500 })
    const assignee = assigneeFrom(req.body, req.wsId)
    for (const id of ids) ownedPairing(id, req.wsId)
    const results = []
    for (const id of ids) {
      try {
        tx(() => {
          const cl = ownedPairing(id, req.wsId)
          db.prepare("UPDATE campaign_leads SET assigned_email = ?, assigned_at = ?, assigned_by = ?, updated_at = datetime('now') WHERE id = ?")
            .run(assignee, assignee ? nowIso() : '', assignee ? req.user.email : '', cl.id)
          const after = db.prepare('SELECT assigned_email FROM campaign_leads WHERE id = ?').get(cl.id)
          if ((after?.assigned_email || '') !== assignee) {
            throw new HttpError(500, { error: 'server_error', message: 'That conversation could not be assigned' })
          }
          results.push({ id: cl.id, ok: true, previous: cl.assigned_email || '', assignedTo: assignee })
        })
      } catch (err) {
        results.push({
          id: Number(id),
          ok: false,
          status: err?.status ?? 500,
          error: err?.body?.error ?? 'server_error',
          message: err?.body?.message ?? 'That conversation could not be assigned',
        })
      }
    }
    const updated = results.filter((r) => r.ok).length
    const failed = results.length - updated
    audit(req, {
      type: 'assigned_bulk',
      detail: `${updated} conversation${updated === 1 ? '' : 's'} -> ${assignee || '(nobody)'}` +
        `${failed ? ` (${failed} could not be assigned)` : ''} by ${req.user.email}`,
    })
    return { ok: true, requested: results.length, updated, failed, results }
  }))

  // Move the pairing to a subsequence — a child campaign. A campaign is never
  // created implicitly; the target must already exist and already be a child
  // of the source, or this is a 422.
  api.post('/inbox/threads/:id/push-to-subsequence', handler((req) => {
    const { messages } = resolveThread(req.wsId, req.params.id)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    if (!anchor.campaign_id || !anchor.lead_id) throw invalid('id', 'That conversation is not attached to a campaign and lead')
    const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(anchor.campaign_id, anchor.lead_id)
    if (!cl) throw invalid('id', 'That lead is not in the source campaign')
    const targetId = int(req.body, 'subsequenceId', { required: true, min: 1 })
    const startAfterSeconds = int(req.body, 'startAfterSeconds', { min: 0, max: 60 * 60 * 24 * 365, fallback: 0 })
    // "Stop if they reply to the current campaign" (push-to-subsequence.md AC3,
    // TC-9). Honoured now, per lead, on the pairing this push creates.
    //
    // It used to be written to `campaigns.stop_on_source_reply` — a campaign-wide
    // column — so one lead's move changed the setting for every other lead
    // already in that subsequence; and nothing in server/engine.js read that
    // column either, so the checkbox promised something no code did. Both spellings
    // are accepted: `stop_lead_on_parent_campaign_reply` is the documented name.
    const stopOnSourceReply = bool(req.body, 'stopOnSourceReply', false) ||
      bool(req.body, 'stop_lead_on_parent_campaign_reply', false)

    const target = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(targetId, req.wsId)
    if (!target) throw invalid('subsequenceId', `No such subsequence: ${targetId}`)
    if (target.parent_campaign_id !== anchor.campaign_id) {
      throw invalid('subsequenceId', 'That campaign is not a subsequence of this conversation\'s campaign')
    }
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(anchor.lead_id)
    if (lead?.status !== 'active') throw invalid('id', `That lead is ${lead?.status || 'unavailable'}`)
    if (isBlocked(req.wsId, lead.email)) throw invalid('id', 'That lead is on this workspace\'s block list')
    if (!target.mailbox_id) throw invalid('subsequenceId', 'That subsequence has no mailbox attached')
    // Already there. This used to be an ON CONFLICT DO UPDATE that reset the
    // existing pairing to `queued` and cleared its outcome — so re-pushing a
    // lead who had already finished the subsequence silently restarted them
    // through it. The spec asks for a refusal, and a refusal is also the only
    // behaviour that cannot lose a completed run's record.
    const already = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(target.id, lead.id)
    if (already) {
      throw invalid('subsequenceId', `${lead.email} is already in "${target.name}" — they cannot be pushed into it twice`)
    }
    // The same validation campaign launch applies. A playbook that does not
    // parse cannot compose anything, so moving a lead into it would strand them.
    const targetCtx = campaignCtx(target.id)
    if (!targetCtx?.graph?.valid) {
      throw invalid('subsequenceId', `"${target.name}" has no valid playbook yet — fix the diagram before moving leads into it`)
    }

    const startAfter = startAfterSeconds > 0 ? new Date(Date.now() + startAfterSeconds * 1000).toISOString() : ''
    tx(() => {
      // The source pairing is closed, never deleted, so Reports attribution
      // and the activity trail survive the move.
      db.prepare("UPDATE campaign_leads SET state = 'stopped', outcome = 'moved', updated_at = datetime('now') WHERE id = ?").run(cl.id)
      // The watermark: everything already on the source thread, including the
      // reply being triaged right now, is on the near side of the move. Read
      // inside the transaction so a reply arriving mid-request is on one side of
      // it or the other and never on both.
      const watermark = db.prepare(
        "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE campaign_id = ? AND lead_id = ?"
      ).get(anchor.campaign_id, lead.id).id
      db.prepare(
        `INSERT INTO campaign_leads (campaign_id, lead_id, state, resume_at, moved_from_campaign_id,
                                     stop_on_source_reply, moved_after_message_id)
         VALUES (?, ?, 'queued', ?, ?, ?, ?)`
      ).run(target.id, lead.id, startAfter, anchor.campaign_id, stopOnSourceReply ? 1 : 0, watermark)
    })
    // §2's last criterion asks the trail to name the delay and the
    // stop-on-parent-reply setting as well as the actor and both campaigns.
    audit(req, {
      campaignId: target.id, leadId: lead.id, type: 'pushed_to_subsequence',
      detail: `${anchor.campaign_id} -> ${target.id} after ${startAfterSeconds}s by ${req.user.email}` +
        `${stopOnSourceReply ? ' — stops if they reply to the source campaign' : ''}`,
    })
    const moved = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(target.id, lead.id)
    return {
      ok: true, from: anchor.campaign_id, to: target.id, campaignLeadId: moved.id,
      startAfter, willStartAt: startAfter || nowIso(),
      // Read back off the row rather than echoed from the request: this field
      // spent its whole life as a literal, and a literal is what made it a lie.
      stopOnSourceReply: moved.stop_on_source_reply === 1,
      stop_on_parent_reply: moved.stop_on_source_reply === 1,
    }
  }))

  // ---- notes and tasks raised from a thread ---------------------------------
  // server/parity/notes.js owns POST /api/leads/:leadId/notes and /tasks. These
  // are the inbox-side shortcuts: the thread supplies the lead and campaign, so
  // a triager never has to name them. They live under /api/inbox to keep the
  // two surfaces from colliding, and write the same two tables.

  api.post('/inbox/threads/:id/notes', handler((req) => {
    const { messages } = resolveThread(req.wsId, req.params.id)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    if (!anchor.lead_id) throw invalid('id', 'That conversation is not attached to a lead')
    const body = str(req.body, 'text', { required: true, max: 10000 })
    const info = tx(() => db.prepare(
      'INSERT INTO lead_notes (workspace_id, lead_id, campaign_id, author_email, body) VALUES (?, ?, ?, ?, ?)'
    ).run(req.wsId, anchor.lead_id, anchor.campaign_id, req.user.email, body))
    audit(req, { campaignId: anchor.campaign_id, leadId: anchor.lead_id, type: 'note_created', detail: `from inbox by ${req.user.email}` })
    return db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(info.lastInsertRowid)
  }))

  api.post('/inbox/threads/:id/tasks', handler((req) => {
    const { messages } = resolveThread(req.wsId, req.params.id)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    if (!anchor.lead_id) throw invalid('id', 'That conversation is not attached to a lead')
    const title = str(req.body, 'name', { required: true, max: 200 })
    const description = str(req.body, 'description', { max: 10000, fallback: '' })
    // Docs/inbox/create-task.md names `due_date`; server/parity/notes.js and the
    // web client say `dueAt`. Both are accepted rather than either being broken.
    const dueRaw = str(req.body, 'dueAt', { max: 40, fallback: '' })
      || str(req.body, 'due_date', { max: 40, fallback: '' })
    let dueAt = ''
    if (dueRaw) {
      const parsed = new Date(dueRaw)
      if (Number.isNaN(parsed.getTime())) throw invalid('dueAt', 'dueAt must be an ISO 8601 datetime')
      dueAt = parsed.toISOString()
    }
    // §2: "no explicit priority defaults to MEDIUM; LOW and HIGH are the only
    // other accepted values and anything else is rejected with a field-level
    // message" (TC-7, TC-8).
    //
    // This route used to ignore `priority` outright. The column has a default of
    // 'medium', so TC-8 looked satisfied — but a task raised from a thread as
    // HIGH was silently stored as medium, and `priority: "URGENT"` was accepted
    // with a 200 and quietly dropped. Both are the shape this codebase keeps
    // being caught by: a field echoed back, or defaulted, and never acted on.
    //
    // The documented spellings are upper case and the column's CHECK constraint
    // is lower case, so the value is folded before it is checked; the response
    // carries `priority` as stored and `priority_label` in the documented
    // casing, so a client written against either reads the same task.
    const priorityRaw = str(req.body, 'priority', { max: 20, fallback: '' })
    const priority = priorityRaw
      ? oneOf({ priority: priorityRaw.toLowerCase() }, 'priority', TASK_PRIORITIES, { required: true })
      : 'medium'
    const assigned = req.body?.assignee === undefined ? '' : assigneeFrom({ assignee: req.body.assignee }, req.wsId)
    const info = tx(() => db.prepare(
      'INSERT INTO lead_tasks (workspace_id, lead_id, campaign_id, title, body, due_at, priority, assigned_email, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.wsId, anchor.lead_id, anchor.campaign_id, title, description, dueAt, priority, assigned, req.user.email))
    audit(req, { campaignId: anchor.campaign_id, leadId: anchor.lead_id, type: 'task_created', detail: `${title} from inbox by ${req.user.email}` })
    const row = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(info.lastInsertRowid)
    return {
      ...row,
      priority_label: String(row.priority || 'medium').toUpperCase(),
      is_overdue: !!row.due_at && Date.parse(row.due_at) < Date.now(),
    }
  }))

  // ---- suppression ----------------------------------------------------------
  // Unconditional. There is no per-request bypass, and asking for one is a 422
  // rather than a silently ignored field.

  api.post('/blocked-domains', handler((req) => {
    refuseBypass(req.body)
    const raw = req.body?.domains
    if (!Array.isArray(raw)) throw invalid('domains', 'domains must be an array')
    if (raw.length === 0) throw invalid('domains', 'domains must contain at least one value')
    if (raw.length > 1000) throw invalid('domains', 'domains may contain at most 1000 values')
    const source = oneOf(req.body, 'source', ['manual', 'bounce', 'complaint', 'import'], { fallback: 'manual' })

    const values = []
    for (const item of raw) {
      const value = String(item || '').trim().toLowerCase().replace(/^@/, '')
      if (!value) throw invalid('domains', 'domains contains an empty value')
      const isDomain = !value.includes('@')
      if (isDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) throw invalid('domains', `Not a valid domain: ${value}`)
      if (!isDomain && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw invalid('domains', `Not a valid address: ${value}`)
      if (!values.some((v) => v.value === value)) values.push({ value, isDomain })
    }

    const affected = tx(() => {
      let stopped = 0
      for (const { value, isDomain } of values) {
        db.prepare('INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by) VALUES (?, ?, ?, ?, ?)')
          .run(req.wsId, value, isDomain ? 1 : 0, source, req.user.email)
        // A block takes effect everywhere at once: matching leads stop, and any
        // draft already composed for them cannot be approved afterwards.
        const leads = db.prepare(
          isDomain
            ? "SELECT id FROM leads WHERE user_id = ? AND LOWER(email) LIKE ?"
            : 'SELECT id FROM leads WHERE user_id = ? AND LOWER(email) = ?'
        ).all(req.wsId, isDomain ? `%@${value}` : value)
        for (const lead of leads) {
          stopped += db.prepare(
            `UPDATE campaign_leads SET state = 'stopped', outcome = 'blocked', updated_at = datetime('now')
             WHERE lead_id = ? AND state NOT IN ('finished','stopped')
               AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`
          ).run(lead.id, req.wsId).changes
          db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE user_id = ? AND lead_id = ? AND status IN ('pending','approved')")
            .run(`${req.user.email} (domain blocked)`, req.wsId, lead.id)
        }
      }
      return stopped
    })
    audit(req, { type: 'domains_blocked', detail: `${values.length} value(s), ${affected} lead(s) stopped, by ${req.user.email}` })
    return { ok: true, blocked: values.map((v) => v.value), affectedLeads: affected, bypassAvailable: false }
  }))

  api.get('/blocked-domains', handler((req) => {
    const { limit, cursor } = page(req.query, { defaultLimit: 200, maxLimit: 500 })
    const where = ['workspace_id = ?']
    const args = [req.wsId]
    const search = str(req.query, 'search', { max: 200, fallback: '' })
    if (search) { where.push('value LIKE ?'); args.push(`%${search.toLowerCase()}%`) }
    if (cursor) { where.push('id > ?'); args.push(cursor) }
    const rows = db.prepare(`SELECT * FROM blocked_domains WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...args, limit + 1)
    return paged(rows, limit)
  }))

  api.delete('/blocked-domains/:id', handler((req) => {
    const row = owned('blocked_domains', req.params.id, req.wsId, 'blocked domain')
    tx(() => db.prepare('DELETE FROM blocked_domains WHERE id = ?').run(row.id))
    audit(req, { type: 'domain_unblocked', detail: `${row.value} by ${req.user.email}` })
    return { ok: true }
  }))
}

// ------------------------------------------------------------------ helpers --

// Stored view filters are validated on save, not only on run, so a view cannot
// be created that will fail the first time someone opens it.
function validateViewFilters(raw, wsId) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('filters', 'filters must be an object')
  const normalised = {}
  for (const [k, v] of Object.entries(raw)) normalised[k] = Array.isArray(v) ? v.join(',') : v
  const parsed = parseFilters(normalised, wsId)
  const out = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    out[k] = v
  }
  return out
}

// Attachments, refused honestly rather than dropped.
//
// An empty array is not an attachment and must not block a send — a composer
// that always posts the field would otherwise be unable to send anything.
function refuseAttachments(body) {
  const raw = body?.attachments
  if (raw === undefined || raw === null || raw === '') return
  if (!Array.isArray(raw)) throw invalid('attachments', 'attachments must be an array')
  if (raw.length === 0) return
  throw new HttpError(501, {
    error: 'not_implemented',
    field: 'attachments',
    message: 'attachments cannot be sent yet — the mail transport cannot carry them, and a reply that quietly dropped the file would be worse than one that says so',
  })
}

// cc / bcc: an array or a comma-separated string, lowercased and de-duplicated.
// The field name stays un-indexed (`cc`, not `cc[0]`) because that is what the
// Inbox composer already renders its inline error against, and the offending
// address is named in the message itself.
function addressList(body, field, { max = 25 } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') return []
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  if (parts.length > max) throw invalid(field, `${field} may contain at most ${max} addresses`)
  const out = []
  for (const address of parts) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      throw invalid(field, `${field} contains an invalid address: ${address}`)
    }
    if (!out.includes(address)) out.push(address)
  }
  return out
}

// `me`, `none`, or a workspace member's address. A user outside the workspace
// is a 404 rather than a 422 — the caller learns nothing about who exists.
function assigneeFrom(body, wsId) {
  const raw = body?.assignee
  if (raw === undefined) throw invalid('assignee', 'assignee is required (an address, "none", or null to clear)')
  if (raw === null || raw === '' || raw === 'none') return ''
  const value = String(raw).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw invalid('assignee', 'assignee must be an email address, "none", or null')
  if (!memberEmails(wsId).includes(value)) throw notFound('team member')
  return value
}

// Forwarded bodies leave without the tracking pixel or the click wrappers that
// were meant for the prospect, and without the opt-out footer's signed token.
function stripTracking(body) {
  return String(body || '')
    .replace(/<img[^>]*\/t\/o\/[^>]*>/gi, '')
    .replace(/https?:\/\/\S*\/t\/[ocu]\/\S+/gi, '[link removed]')
    .trim()
}
