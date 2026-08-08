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
import {
  HttpError, invalid, notFound, handler,
  str, int, bool, oneOf, idList, email as emailField,
  page, paged, owned, tx, nowIso, audit, meter,
} from './http.js'

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

function ceiling(field, count) {
  const max = CEILINGS[field]
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
function queryIds(query, field) {
  const raw = query?.[field]
  if (raw === undefined || raw === null || raw === '') return []
  const parts = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean)
  ceiling(field, parts.length)
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

const minor = (major) => Math.round(Number(major) * 100)
const major = (minorUnits) => Math.round(Number(minorUnits || 0)) / 100

// ------------------------------------------------------------- the one list --

// Shared filter parsing, used by the ad-hoc route and by a saved view alike so
// a view is a stored argument list rather than a second query engine.
function parseFilters(source, wsId) {
  const state = oneOf(source, 'state', INBOX_STATES, { fallback: 'active' })
  const sort = oneOf(source, 'sort', SORTS, { fallback: MESSAGE_STATES.has(state) ? (state === 'scheduled' ? 'scheduled_asc' : 'sent_desc') : 'reply_desc' })
  const search = str(source, 'search', { max: 5000, fallback: '' })
  if (search.length > CEILINGS.search) ceiling('search', search.length)

  const filters = {
    state,
    sort,
    search,
    campaignId: queryIds(source, 'campaignId'),
    mailboxId: queryIds(source, 'mailboxId'),
    categoryId: queryIds(source, 'categoryId'),
    intent: str(source, 'intent', { max: 120, fallback: '' }),
    assignee: str(source, 'assignee', { max: 320, fallback: '' }),
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
  for (const id of filters.mailboxId) if (!db.prepare('SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?').get(id, wsId)) throw invalid('mailboxId', `No such mailbox: ${id}`)
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
    MIN(CASE WHEN m.direction = 'in' THEN COALESCE(m.read_at, '') END) AS min_read_at,
    MIN(COALESCE(m.archived_at, '')) AS min_archived_at,
    MIN(COALESCE(m.snoozed_until, '')) AS min_snoozed_until,
    MAX(COALESCE(m.is_important, 0)) AS is_important
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
  im.created_at AS last_reply_at, im.intent AS last_intent,
  om.created_at AS last_sent_at,
  l.email AS lead_email, l.first_name, l.last_name, l.company, l.title, l.status AS lead_status,
  c.name AS campaign_name, c.status AS campaign_status,
  mb.email AS mailbox_email,
  cl.id AS campaign_lead_id, cl.state AS lead_state, cl.node_id, cl.outcome,
  cl.assigned_email, cl.category_id, cl.revenue_amount, cl.revenue_currency,
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
  const replyAgeHours = row.last_reply_at
    ? Math.max(0, Math.round((at.getTime() - Date.parse(row.last_reply_at + 'Z')) / 36e5))
    : null
  return {
    rowType: 'thread',
    id: row.id,
    threadKey: row.tkey,
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
    revenue: row.campaign_lead_id
      ? { amount: major(row.revenue_amount), amount_minor: Math.round(row.revenue_amount || 0), currency: row.revenue_currency || 'USD' }
      : null,
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
function applyThreadState(wsId, actor, anchorIds, patch) {
  const results = []
  tx(() => {
    for (const id of anchorIds) {
      const { messages } = resolveThread(wsId, id)
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
        db.prepare(`UPDATE messages SET is_important = ?, important_by = ? WHERE id IN (${marks})`)
          .run(patch.important ? 1 : 0, patch.important ? actor : '', ...ids)
      }
      const after = db.prepare(`SELECT * FROM messages WHERE id IN (${marks}) ORDER BY id`).all(...ids)
      results.push({ id: messages[0].id, ok: true, ...threadState(after) })
    }
  })
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
    return {
      id: anchorId,
      threadKey: tkey,
      ...threadState(messages),
      lead,
      campaign: campaign ? { id: campaign.id, name: campaign.name, status: campaign.status } : null,
      campaignLead: cl
        ? { ...cl, revenue: { amount: major(cl.revenue_amount), amount_minor: Math.round(cl.revenue_amount || 0), currency: cl.revenue_currency || 'USD' } }
        : null,
      reminders: remindersFor(req.wsId, tkey),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        from_email: m.from_email,
        to_email: m.to_email,
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

  // Bulk sibling. All-or-nothing on ownership (an id outside the workspace
  // fails the whole call before anything is written), then one events row for
  // the action rather than one per thread.
  api.patch('/inbox/threads', handler((req) => {
    const patch = readStatePatch(req.body)
    const ids = idList(req.body, 'ids', { required: true, max: 500 })
    const anchors = ids.map((id) => resolveThread(req.wsId, id).anchorId)
    const unique = [...new Set(anchors)]
    const results = applyThreadState(req.wsId, req.user.email, unique, patch)
    audit(req, { type: 'inbox_state_bulk', detail: `${patchSummary(patch)} on ${results.length} threads by ${req.user.email}` })
    return { ok: true, updated: results.length, results, updated_at: nowIso() }
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
        if (!db.prepare('SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?').get(id, req.wsId)) broken.push(`mailboxId:${id}`)
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
    if (cursor) { where.push('id > ?'); args.push(cursor) }
    const rows = db.prepare(`SELECT * FROM lead_reminders WHERE ${where.join(' AND ')} ORDER BY reminder_at, id LIMIT ?`).all(...args, limit + 1)
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
    const { messages } = resolveThread(req.wsId, req.params.id)
    const body = str(req.body, 'body', { required: true, max: 50000 })
    if (req.body?.confirm !== true) throw invalid('confirm', 'Nothing sends without your OK — send confirm: true')
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    const campaign = anchor.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(anchor.campaign_id, req.wsId) : null
    const lead = anchor.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(anchor.lead_id, req.wsId) : null
    const mailbox = anchor.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(anchor.mailbox_id, req.wsId) : null
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

    const lastSubject = messages[messages.length - 1].subject || ''
    const subject = str(req.body, 'subject', { max: 500, fallback: lastSubject.startsWith('Re:') ? lastSubject : `Re: ${lastSubject}` })
    const sendAtRaw = str(req.body, 'sendAt', { max: 40, fallback: '' })
    const sendAt = sendAtRaw ? new Date(sendAtRaw) : null
    if (sendAtRaw && Number.isNaN(sendAt.getTime())) throw invalid('sendAt', 'sendAt must be an ISO 8601 datetime')

    if (sendAt && sendAt.getTime() > Date.now()) {
      // Queued, not sent. Cancellable through DELETE /api/scheduled/:id, and
      // the pacing engine decides the actual minute when it comes due.
      const info = tx(() => db.prepare(
        `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id, node_id, manual_reply, scheduled_at, send_status, is_read, read_at)
         VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, 'manual', 1, ?, 'queued', 1, ?)`
      ).run(req.wsId, campaign.id, lead.id, mailbox.id, subject, body, mailbox.email, lead.email,
        anchor.thread_id || '', sendAt.toISOString(), nowIso()))
      audit(req, { campaignId: campaign.id, leadId: lead.id, type: 'manual_reply_scheduled', detail: `${sendAt.toISOString()} by ${req.user.email}` })
      return { ok: true, scheduled: true, messageId: Number(info.lastInsertRowid), scheduledAt: sendAt.toISOString() }
    }

    // The same send path agent email uses: same quota, same tracking pixel,
    // same opt-out footer, same List-Unsubscribe header.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
    const sent = await sendEmail({ mailbox, user: user || { id: req.wsId }, campaign, lead, nodeId: 'manual', subject, body })
    const written = db.prepare('SELECT id FROM messages WHERE provider_message_id = ? ORDER BY id DESC LIMIT 1').get(sent.providerMessageId)
    if (written) {
      db.prepare("UPDATE messages SET manual_reply = 1, send_status = 'sent' WHERE id = ?").run(written.id)
    }
    audit(req, { campaignId: campaign.id, leadId: lead.id, type: 'manual_reply', detail: `by ${req.user.email}` })
    meter('inbox.reply', 0, true, mailbox.email)
    return { ok: true, scheduled: false, messageId: written?.id ?? null, threadId: sent.threadId }
  }))

  // Harry's own forward contract. The source page documents no request fields
  // at all, so nothing here is guessed from it: the caller names the
  // recipients, an optional note and whether to include the quoted chain, and
  // the chain itself is rebuilt server-side from stored messages.
  api.post('/threads/:messageId/forward', handler(async (req) => {
    refuseBypass(req.body)
    const { messages } = resolveThread(req.wsId, req.params.messageId)
    const to = emailField(req.body, 'to', { required: true })
    const cc = [].concat(req.body?.cc || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean)
    const bcc = [].concat(req.body?.bcc || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean)
    for (const [field, list] of [['cc', cc], ['bcc', bcc]]) {
      for (const addr of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw invalid(field, `${field} contains an invalid address: ${addr}`)
    }
    if (req.body?.confirm !== true) throw invalid('confirm', 'Nothing sends without your OK — send confirm: true')
    for (const addr of [to, ...cc, ...bcc]) assertNotBlocked(req.wsId, addr, 'to')

    const source = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(Number(req.params.messageId), req.wsId)
    const anchor = messages.find((m) => m.campaign_id && m.lead_id) || messages[0]
    const mailbox = anchor.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(anchor.mailbox_id, req.wsId) : null
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
      const result = await gmailSend(mailbox, { to: [to, ...cc, ...bcc].join(', '), subject, body: composed, workspaceId: req.wsId })
      providerMessageId = result.messageId
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
  // still queued, so a race with the engine either cancels or sends, not both.
  api.delete('/scheduled/:id', handler((req) => {
    const msg = owned('messages', req.params.id, req.wsId, 'scheduled message')
    const changed = tx(() => db.prepare("UPDATE messages SET send_status = 'cancelled' WHERE id = ? AND send_status = 'queued'").run(msg.id).changes)
    if (!changed) throw invalid('id', 'That message is no longer queued')
    audit(req, { campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'scheduled_cancelled', detail: `by ${req.user.email}` })
    return { ok: true }
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
    tx(() => db.prepare('UPDATE campaign_leads SET revenue_amount = ?, revenue_currency = ?, revenue_updated_at = ?, revenue_updated_by = ? WHERE id = ?')
      .run(amountMinor, currency, nowIso(), req.user.email, cl.id))
    audit(req, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'revenue_updated',
      detail: `${major(previous)} -> ${raw === null ? 'cleared' : major(amountMinor)} ${currency} by ${req.user.email}`,
    })
    return { ok: true, id: cl.id, amount: raw === null ? null : major(amountMinor), amount_minor: amountMinor, currency, previous_amount: major(previous) }
  }))

  api.patch('/campaign-leads/:id/resume', handler((req) => {
    const cl = ownedPairing(req.params.id, req.wsId)
    const delayDays = int(req.body, 'delayDays', { min: 0, max: 365, fallback: 0 })
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
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
      await routeReply(ctx, fresh, intent, null)
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

  api.patch('/campaign-leads/assignee', handler((req) => {
    const ids = idList(req.body, 'ids', { required: true, max: 500 })
    const assignee = assigneeFrom(req.body, req.wsId)
    const pairings = ids.map((id) => ownedPairing(id, req.wsId))
    const results = tx(() => pairings.map((cl) => {
      db.prepare("UPDATE campaign_leads SET assigned_email = ?, assigned_at = ?, assigned_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(assignee, assignee ? nowIso() : '', assignee ? req.user.email : '', cl.id)
      return { id: cl.id, ok: true, previous: cl.assigned_email || '', assignedTo: assignee }
    }))
    audit(req, { type: 'assigned_bulk', detail: `${results.length} conversations -> ${assignee || '(nobody)'} by ${req.user.email}` })
    return { ok: true, updated: results.length, results }
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
    const stopOnSourceReply = bool(req.body, 'stopOnSourceReply', false)

    const target = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(targetId, req.wsId)
    if (!target) throw invalid('subsequenceId', `No such subsequence: ${targetId}`)
    if (target.parent_campaign_id !== anchor.campaign_id) {
      throw invalid('subsequenceId', 'That campaign is not a subsequence of this conversation\'s campaign')
    }
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(anchor.lead_id)
    if (lead?.status !== 'active') throw invalid('id', `That lead is ${lead?.status || 'unavailable'}`)
    if (isBlocked(req.wsId, lead.email)) throw invalid('id', 'That lead is on this workspace\'s block list')
    if (!target.mailbox_id) throw invalid('subsequenceId', 'That subsequence has no mailbox attached')

    const startAfter = startAfterSeconds > 0 ? new Date(Date.now() + startAfterSeconds * 1000).toISOString() : ''
    tx(() => {
      // The source pairing is closed, never deleted, so Reports attribution
      // and the activity trail survive the move.
      db.prepare("UPDATE campaign_leads SET state = 'stopped', outcome = 'moved', updated_at = datetime('now') WHERE id = ?").run(cl.id)
      db.prepare(
        `INSERT INTO campaign_leads (campaign_id, lead_id, state, resume_at, moved_from_campaign_id)
         VALUES (?, ?, 'queued', ?, ?)
         ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
           state = 'queued', resume_at = excluded.resume_at, moved_from_campaign_id = excluded.moved_from_campaign_id,
           outcome = '', updated_at = datetime('now')`
      ).run(target.id, lead.id, startAfter, anchor.campaign_id)
      if (stopOnSourceReply) {
        db.prepare('UPDATE campaigns SET stop_on_source_reply = 1 WHERE id = ?').run(target.id)
      }
    })
    audit(req, {
      campaignId: target.id, leadId: lead.id, type: 'pushed_to_subsequence',
      detail: `${anchor.campaign_id} -> ${target.id} after ${startAfterSeconds}s by ${req.user.email}`,
    })
    const moved = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(target.id, lead.id)
    return { ok: true, from: anchor.campaign_id, to: target.id, campaignLeadId: moved.id, startAfter, stopOnSourceReply }
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
    const dueRaw = str(req.body, 'dueAt', { max: 40, fallback: '' })
    let dueAt = ''
    if (dueRaw) {
      const parsed = new Date(dueRaw)
      if (Number.isNaN(parsed.getTime())) throw invalid('dueAt', 'dueAt must be an ISO 8601 datetime')
      dueAt = parsed.toISOString()
    }
    const assigned = req.body?.assignee === undefined ? '' : assigneeFrom({ assignee: req.body.assignee }, req.wsId)
    const info = tx(() => db.prepare(
      'INSERT INTO lead_tasks (workspace_id, lead_id, campaign_id, title, body, due_at, assigned_email, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.wsId, anchor.lead_id, anchor.campaign_id, title, description, dueAt, assigned, req.user.email))
    audit(req, { campaignId: anchor.campaign_id, leadId: anchor.lead_id, type: 'task_created', detail: `${title} from inbox by ${req.user.email}` })
    const row = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(info.lastInsertRowid)
    return { ...row, is_overdue: !!row.due_at && Date.parse(row.due_at) < Date.now() }
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
