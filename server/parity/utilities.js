// Sending controls outside the playbook — Docs/utilities/*.
//
// Two things live here, and they are the same safety question seen from both
// ends: a list of addresses and domains Harry must never contact, and the one
// internal path by which a single email leaves the building outside a playbook.
//
// The block list is a pair of routes over the `blocked_domains` table (which
// already exists in server/parity/schema.js — this module never alters it).
// `Docs/inbox/block-domains.md` describes the same table under
// `/api/blocked-domains`; that pair belongs to the inbox module. This file owns
// `/api/block-list`: the paste-many-at-once surface, its normalisation, its
// de-duplication and its removal.
//
// `send-single-email` deliberately has NO route. Docs/README.md lists it among
// "the four that need no UI" and records the divergence in as many words: it is
// "specified as one shared internal function rather than a compose screen,
// because a compose screen is the obvious way around the rule". A
// `POST /api/send/one-off` taking `to`, `subject` and `body` would be exactly
// that compose screen's backend — a caller in a workspace that has turned
// approvals off could send anything to anyone. So `sendSingleEmail` is exported
// for the two surfaces that already exist (the Inbox's manual reply and the
// Team invite) to call, and nothing here dispatches on an HTTP request.
//
// Two rules are structural rather than optional:
//   * Suppression is unconditional. `sendSingleEmail` takes no override flag,
//     and the check runs before the approval queue, so a blocked lead never
//     even produces a draft (domain-block-list §5, last DoD item).
//   * Nothing sends without the user's OK. With `require_approval` on — the
//     default, including for workspaces that predate approvals — a caller-
//     initiated send is parked in `drafts` through server/drafts.js and returns
//     `status: 'parked'`. Only Harry's own system mail (`system: true`) skips
//     the queue, and even that cannot skip suppression.

import { db, logEvent } from '../db.js'
import { blockMatch, suppressionFor, applySuppression } from '../suppression.js'
import { recordTelemetry } from '../telemetry.js'
import { sendEmail, remainingQuota } from '../mailer.js'
import { approvalRequired, openDraft, createDraft } from '../drafts.js'
import { newTrackingToken, buildHtmlBody, unsubscribeUrl, withOptOutFooter } from '../tracking.js'
import { gmailSend } from '../google.js'
import {
  HttpError, invalid, notFound, handler,
  str, email as emailField, page, owned, tx, audit, meter,
} from './http.js'

// ---- block list: normalisation ----------------------------------------------

// A pasted blob is split on anything a human uses as a separator: newlines,
// commas, semicolons, tabs, spaces. An address never contains one of these, so
// nothing legitimate is torn in half.
// Lines and list separators only — never plain whitespace. Splitting on spaces
// turned one bad line ("not a valid entry!!") into four separate rejections,
// which reads as four problems the user does not have and hides the one they
// do. A pasted address never contains a space; a mistyped line often does.
const SPLIT_RE = /[\r\n,;]+/

const MAX_ENTRIES = 1000
const MAX_RAW = 200_000        // one paste, not a file upload

const SOURCES = { manual: 'Added by you', bounced: 'Bounced', unsubscribed: 'Unsubscribed' }

// A hostname: labels of letters, digits and hyphens, at least two of them, with
// an alphabetic (or punycode) last label. Deliberately strict — "notadomain",
// "a@b" and "192.168.0.1" are reported as rejected rather than stored as
// something that could never match an email address anyway.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const TLD_RE = /^([a-z]{2,}|xn--[a-z0-9-]+)$/

function isHostname(value) {
  if (!value || value.length > 253) return false
  if (!DOMAIN_RE.test(value)) return false
  const labels = value.split('.')
  if (labels.some((l) => l.length > 63)) return false
  return TLD_RE.test(labels[labels.length - 1])
}

const stripWww = (host) => host.replace(/^www\./, '')

// One entry as a human typed it -> what is stored, or null if it is not an
// address or a domain at all. People paste URLs out of a browser bar, so
// `HTTPS://WWW.Competitor.com/pricing?ref=x` has to become `competitor.com`.
export function normaliseBlockValue(raw) {
  let value = String(raw ?? '').trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^mailto:/, '')
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')  // scheme
  value = value.replace(/[?#].*$/, '')                  // query / fragment
  value = value.replace(/\/.*$/, '')                    // path
  value = value.replace(/^<|>$/g, '')                   // "<ana@x.com>"
  value = value.replace(/^@+/, '')                      // "@competitor.com"
  value = value.replace(/\.+$/, '')                     // trailing dot
  if (!value) return null

  const at = value.lastIndexOf('@')
  if (at >= 0) {
    const local = value.slice(0, at)
    const domain = stripWww(value.slice(at + 1))
    // A local part with its own "@" or whitespace is not an address.
    if (!local || /[@\s]/.test(local) || !isHostname(domain)) return null
    return { value: `${local}@${domain}`, isDomain: 0 }
  }
  const domain = stripWww(value)
  if (!isHostname(domain)) return null
  return { value: domain, isDomain: 1 }
}

// Accepts what the two callers actually send: an array (the API contract the
// source documents) or one pasted block of text (the textarea in Settings →
// Sending). Anything else is a 422 naming the field, per the spec's
// `domain_block_list must be an array`.
export function parseBlockList(raw, field = 'domain_block_list') {
  const parts = []
  if (typeof raw === 'string') {
    if (raw.length > MAX_RAW) throw invalid(field, `${field} is too long to paste in one go`)
    parts.push(...raw.split(SPLIT_RE))
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || item === undefined) continue
      if (typeof item === 'object') {
        throw invalid(field, `${field} must contain addresses and domains, not objects`)
      }
      // An array element may itself be a pasted line — split it the same way.
      parts.push(...String(item).split(SPLIT_RE))
    }
  } else {
    throw invalid(field, `${field} must be an array of addresses and domains, or one pasted block of text`)
  }
  const entries = parts.map((p) => p.trim()).filter(Boolean)
  if (entries.length > MAX_ENTRIES) {
    throw invalid(field, `${field} may contain at most ${MAX_ENTRIES} entries in one go`)
  }
  return entries
}

// Blocking the domain you send from would break reply handling, so the
// workspace's own connected mailboxes are refused with an explanation rather
// than stored (domain-block-list §2, last acceptance criterion).
function ownSendingIdentities(wsId) {
  const rows = db.prepare('SELECT email FROM mailboxes WHERE user_id = ?').all(wsId)
  const addresses = new Set()
  const domains = new Set()
  for (const row of rows) {
    const address = String(row.email || '').trim().toLowerCase()
    if (!address.includes('@')) continue
    addresses.add(address)
    domains.add(address.slice(address.lastIndexOf('@') + 1))
  }
  return { addresses, domains }
}

function shape(row) {
  return {
    id: row.id,
    value: row.value,
    emailOrDomain: row.value,        // the source API's `email_or_domain`
    isDomain: Boolean(row.is_domain),
    source: row.source,
    sourceLabel: SOURCES[row.source] || row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    clientId: null,                  // Harry has no per-client block lists yet
  }
}

// ---- block list: writes ------------------------------------------------------

// The one insert path. Returns every entry accounted for — added, already
// present, or rejected with a reason — because a paste that silently drops a
// typo is a paste that quietly fails to block a competitor.
export function addBlockEntries(wsId, input, { source = 'manual', createdBy = '', field = 'domain_block_list' } = {}) {
  const entries = parseBlockList(input, field)
  const own = ownSendingIdentities(wsId)
  const added = []
  const duplicates = []
  const rejected = []
  const seen = new Set()

  tx(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by) VALUES (?, ?, ?, ?, ?)'
    )
    const byId = db.prepare('SELECT * FROM blocked_domains WHERE id = ?')
    for (const raw of entries) {
      const norm = normaliseBlockValue(raw)
      if (!norm) {
        rejected.push({ input: raw, reason: 'malformed', message: `"${raw}" is not an email address or a domain` })
        continue
      }
      const isOwn = norm.isDomain ? own.domains.has(norm.value) : own.addresses.has(norm.value)
      if (isOwn) {
        rejected.push({
          input: raw, value: norm.value, reason: 'own_sending_domain',
          message: `${norm.value} is one of your own sending mailboxes — blocking it would stop your replies arriving`,
        })
        continue
      }
      if (seen.has(norm.value)) {
        duplicates.push({ input: raw, value: norm.value, reason: 'duplicate_in_request' })
        continue
      }
      seen.add(norm.value)
      const info = insert.run(wsId, norm.value, norm.isDomain, source, createdBy)
      // INSERT OR IGNORE against UNIQUE (workspace_id, value): a repeat add is a
      // no-op that keeps the original row's source and date.
      if (info.changes === 0) {
        duplicates.push({ input: raw, value: norm.value, reason: 'already_blocked' })
        continue
      }
      added.push(byId.get(info.lastInsertRowid))
    }
  })

  return { requested: entries.length, added, duplicates, rejected }
}

// ---- suppression -------------------------------------------------------------

// Exact address first, then the domain and each parent of it: an entry for
// `competitor.com` blocks `ana@mail.competitor.com`. One way only — blocking
// `mail.competitor.com` does not block the parent domain.
// Re-exported so callers that already reach for these here keep working;
// the definitions live in server/suppression.js, which imports nothing but
// the database so the send path can read it without a cycle.
export { blockMatch, suppressionFor }

// ---- attachments -------------------------------------------------------------

const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

// An allow-list, not a deny-list: an executable MIME type is refused because it
// is not on this list, so a new one does not need adding to a block-list first.
const ALLOWED_MIME = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'text/calendar',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

// Validated before any provider call, as the spec requires, so nothing is
// partially uploaded before a refusal.
function validateAttachments(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  if (!Array.isArray(raw)) throw invalid('attachments', 'attachments must be an array')
  if (raw.length > MAX_ATTACHMENTS) {
    throw invalid('attachments', `attachments may contain at most ${MAX_ATTACHMENTS} files`)
  }
  let total = 0
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw invalid('attachments', 'each attachment must be an object')
    const filename = String(item.filename || '').trim()
    if (!filename) throw invalid('attachments', 'each attachment needs a filename')
    const mimeType = String(item.mimeType || item.mime_type || '').trim().toLowerCase()
    if (!ALLOWED_MIME.has(mimeType)) {
      throw invalid('attachments', `${filename}: ${mimeType || 'no MIME type'} is not allowed — allowed types are ${[...ALLOWED_MIME].join(', ')}`)
    }
    const content = item.content
    if (typeof content !== 'string' || !content) {
      throw invalid('attachments', `${filename}: content must be base64 text`)
    }
    const bytes = Buffer.from(content, 'base64')
    if (!bytes.length) throw invalid('attachments', `${filename}: content is not valid base64`)
    total += bytes.length
    if (total > MAX_ATTACHMENT_BYTES) {
      throw invalid('attachments', `attachments total more than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`)
    }
    out.push({ filename, mimeType, bytes })
  }
  return out
}

// ---- the shared send ---------------------------------------------------------

function resolveMailbox(wsId, o) {
  const id = o.fromMailboxId ?? o.fromEmailId
  if (id !== undefined && id !== null && id !== '') {
    const box = owned('mailboxes', id, wsId, 'mailbox')
    // "not connected, or belongs to another workspace" is one 404 that leaks
    // neither the address nor the fact that the id exists elsewhere.
    if (box.status === 'disconnected' || box.is_suspended) throw notFound('mailbox')
    return box
  }
  const address = emailField(o, 'fromEmail')
  if (!address) {
    throw invalid('fromEmail', 'either fromEmail or fromMailboxId must name the mailbox to send from')
  }
  const box = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND lower(trim(email)) = ?').get(wsId, address)
  if (!box || box.status === 'disconnected' || box.is_suspended) throw notFound('mailbox')
  return box
}

function resolveRecipient(wsId, o) {
  if (o.leadId !== undefined && o.leadId !== null && o.leadId !== '') {
    const lead = owned('leads', o.leadId, wsId, 'lead')
    return { lead, to: String(lead.email).trim().toLowerCase() }
  }
  const to = emailField(o, 'to', { required: true })
  const lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND lower(trim(email)) = ?').get(wsId, to) || null
  return { lead, to }
}

function bumpQuota(mailbox) {
  const today = new Date().toISOString().slice(0, 10)
  if (mailbox.sent_today_date === today) {
    db.prepare('UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ?').run(mailbox.id)
  } else {
    db.prepare('UPDATE mailboxes SET sent_today = 1, sent_today_date = ? WHERE id = ?').run(today, mailbox.id)
  }
}

// The context-free send: system mail with no campaign and no lead (a team
// invite, the agreement notice). `sendEmail` in server/mailer.js needs a
// campaign and a lead to key the thread and the quota, so it cannot carry this
// one; the furniture it attaches — tracking token, opt-out footer,
// List-Unsubscribe header, `messages` row, quota bump, `send` telemetry — is
// reproduced here exactly, against the same provider interface. When mailer.js
// grows a campaign-less entry point this should collapse into it.
async function dispatchContextFree({ wsId, mailbox, to, lead, subject, body }) {
  const token = newTrackingToken()
  const t0 = Date.now()
  let providerMessageId
  let threadId

  if (mailbox.provider === 'gmail') {
    try {
      const result = await gmailSend(mailbox, {
        to,
        subject,
        body: withOptOutFooter(body, token),
        html: buildHtmlBody({ body, token }),
        listUnsubscribe: unsubscribeUrl(token),
      })
      providerMessageId = result.messageId
      threadId = result.threadId
      recordTelemetry('send', { op: 'gmail', ok: true, ms: Date.now() - t0, detail: 'one-off' })
    } catch (err) {
      recordTelemetry('send', { op: 'gmail', ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(String(err.message || err).slice(0, 300), mailbox.id)
      throw err
    }
  } else {
    const rand = () => Math.random().toString(16).slice(2, 14)
    providerMessageId = `sbx-msg-${rand()}`
    threadId = `sbx-thr-${rand()}`
    recordTelemetry('send', { op: 'sandbox', ok: true, ms: Date.now() - t0, detail: 'one-off' })
  }

  const info = db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id, node_id, is_read, tracking_token)
     VALUES (?, NULL, ?, ?, 'out', ?, ?, ?, ?, ?, ?, 'one-off', 1, ?)`
  ).run(wsId, lead?.id ?? null, mailbox.id, subject, body, mailbox.email, to, providerMessageId, threadId, token)
  bumpQuota(mailbox)
  logEvent(wsId, { campaignId: null, leadId: lead?.id ?? null, type: 'sent', detail: subject })
  return { messageId: Number(info.lastInsertRowid), providerMessageId, threadId }
}

function refusal(wsId, { campaign, lead, to, reason, message, until = null, started }) {
  logEvent(wsId, {
    campaignId: campaign?.id ?? null,
    leadId: lead?.id ?? null,
    type: 'send_refused',
    detail: `${to}: ${message}`,
  })
  meter('utilities.send_one_off', Date.now() - started, false, `${reason} → ${to}`)
  return { status: 'refused', ok: false, sent: false, reason, message, to, until }
}

/**
 * The one path every non-campaign email takes.
 *
 * Returns (never throws for a refusal — the calling surface shows the reason):
 *   { status: 'refused', reason: 'blocked' | 'unsubscribed' | 'bounced' | 'daily_limit', message, until }
 *   { status: 'parked',  draftId, draft }            — waiting for a human OK
 *   { status: 'sent',    messageId, providerMessageId, threadId }
 *
 * Throws HttpError for a caller mistake: 422 naming the field, 404 for a
 * mailbox, lead or campaign outside the workspace.
 *
 * There is deliberately no `ignoreBlockList` / `force` / `skipApproval` option.
 * Unknown options are ignored, so passing one changes nothing.
 */
export async function sendSingleEmail(wsId, options = {}) {
  const started = Date.now()
  const o = options || {}

  const subject = str(o, 'subject', { required: true, max: 998 })
  const body = str(o, 'body', { required: true, max: 100_000 })
  const nodeId = str(o, 'nodeId', { max: 64, fallback: 'one-off' })
  const system = Boolean(o.system)
  // Accepted for the transport that can carry them. gmailSend() in
  // server/google.js takes neither today, so both are recorded on the activity
  // trail rather than silently claimed — see the report note.
  const replyTo = emailField(o, 'replyTo')
  const fromName = str(o, 'fromName', { max: 120 })

  const mailbox = resolveMailbox(wsId, o)
  const { lead, to } = resolveRecipient(wsId, o)
  const campaign = (o.campaignId !== undefined && o.campaignId !== null && o.campaignId !== '')
    ? owned('campaigns', o.campaignId, wsId, 'campaign')
    : null

  // Before any provider call, and before the approval queue.
  const attachments = validateAttachments(o.attachments)
  if (attachments.length) {
    // Validated, then honestly refused: neither provider path can carry an
    // attachment yet (server/google.js builds a two-part alternative body and
    // nothing else), and a send that quietly drops the file would be worse
    // than one that says so.
    throw new HttpError(501, {
      error: 'not_implemented', field: 'attachments',
      message: 'attachments are validated but the mail transport cannot carry them yet',
    })
  }

  // Suppression: unconditional, and ahead of the approval queue so a blocked
  // lead never produces a draft to clutter the Inbox.
  const suppressed = suppressionFor(wsId, { address: to, lead })
  if (suppressed) {
    return refusal(wsId, { campaign, lead, to, reason: suppressed.reason, message: suppressed.message, started })
  }

  // A one-off skips the pacing gap — a person is acting now — but never the
  // ceiling that protects the domain.
  if (remainingQuota(mailbox) <= 0) {
    const now = Date.now()
    const until = new Date(now - (now % 86_400_000) + 86_400_000).toISOString()
    return refusal(wsId, {
      campaign, lead, to, reason: 'daily_limit', until, started,
      message: `${mailbox.email} has reached its daily limit — it can send again after ${until}`,
    })
  }

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
  if (!system && approvalRequired(owner)) {
    // The approval queue is keyed on (campaign, lead) — that is what the Inbox
    // renders. A caller-initiated send without that context cannot be parked,
    // and sending it instead would be the exact hole this module exists to
    // close, so it fails closed with the field named.
    if (!campaign) throw invalid('campaignId', 'this send needs your OK, and the approval queue needs the campaign it belongs to')
    if (!lead) throw invalid('leadId', 'this send needs your OK, and the approval queue needs the lead it is addressed to')
    const existing = openDraft(campaign.id, lead.id)
    if (existing) {
      meter('utilities.send_one_off', Date.now() - started, true, 'already parked')
      return {
        status: 'parked', ok: true, sent: false, draftId: existing.id, draft: existing, alreadyPending: true,
        message: 'An email for this lead is already waiting for your OK',
      }
    }
    const draft = createDraft({ userId: wsId, campaignId: campaign.id, leadId: lead.id, nodeId, subject, body })
    meter('utilities.send_one_off', Date.now() - started, true, `parked draft ${draft.id}`)
    return {
      status: 'parked', ok: true, sent: false, draftId: draft.id, draft,
      message: 'Waiting for your OK before it sends',
    }
  }

  if (replyTo || fromName) {
    logEvent(wsId, {
      campaignId: campaign?.id ?? null, leadId: lead?.id ?? null, type: 'send_headers',
      detail: `requested${fromName ? ` from "${fromName}"` : ''}${replyTo ? ` reply-to ${replyTo}` : ''}`,
    })
  }

  // With a campaign and a lead this is a campaign send in every respect, so it
  // goes through server/mailer.js and inherits the thread, the tracking
  // furniture, the quota bump and the `sent` event from there.
  if (campaign && lead) {
    const result = await sendEmail({ mailbox, user: { id: wsId }, campaign, lead, nodeId, subject, body })
    const message = db.prepare('SELECT id FROM messages WHERE provider_message_id = ? AND user_id = ?')
      .get(result.providerMessageId, wsId)
    meter('utilities.send_one_off', Date.now() - started, true, `sent → ${to}`)
    return {
      status: 'sent', ok: true, sent: true,
      messageId: message?.id ?? null,
      providerMessageId: result.providerMessageId,
      threadId: result.threadId,
    }
  }

  const result = await dispatchContextFree({ wsId, mailbox, to, lead, subject, body })
  meter('utilities.send_one_off', Date.now() - started, true, `sent (system) → ${to}`)
  return { status: 'sent', ok: true, sent: true, ...result }
}

// ---- routes ------------------------------------------------------------------

export function register(api) {
  // ---- GET /api/block-list?offset&limit&search ------------------------------
  // Offset paging because the spec names `offset` and `limit` and the settings
  // panel is a short list a person reads, not an infinite feed. `limit`
  // defaults to 100 and is refused outside 1–1000 rather than clamped.
  api.get('/block-list', handler(async (req) => {
    const started = Date.now()
    const { limit, offset } = page(req.query, { defaultLimit: 100, maxLimit: 1000 })
    const search = str(req.query, 'search', { max: 320 })

    const where = ['workspace_id = ?']
    const args = [req.wsId]
    if (search) {
      // Escaped so a pasted "%" searches for a percent sign, not everything.
      where.push("value LIKE ? ESCAPE '\\'")
      args.push(`%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    const clause = where.join(' AND ')
    const total = db.prepare(`SELECT COUNT(*) AS n FROM blocked_domains WHERE ${clause}`).get(...args).n
    const rows = db.prepare(
      `SELECT * FROM blocked_domains WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset)

    meter('utilities.block_list', Date.now() - started, true, `n=${rows.length} of ${total}`)
    return {
      ok: true,
      data: rows.map(shape),
      total,
      offset,
      limit,
      search,
      hasMore: offset + rows.length < total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    }
  }))

  // ---- POST /api/block-list -------------------------------------------------
  // The paste box. Takes an array or one pasted blob, normalises every entry,
  // de-duplicates within the request and against what is already stored, and
  // reports all three outcomes — added, already present, rejected — so a typo
  // is visible instead of being quietly not blocked.
  api.post('/block-list', handler(async (req) => {
    const started = Date.now()
    const raw = req.body?.domain_block_list ?? req.body?.domainBlockList
    if (raw === undefined || raw === null) {
      throw invalid('domain_block_list', 'domain_block_list is required')
    }
    // `source` is not accepted from the client: a person adding an entry here
    // is "Added by you". "Bounced" and "Unsubscribed" are written by the code
    // that observed the bounce or the unsubscribe, through addBlockEntries().
    const result = addBlockEntries(req.wsId, raw, { source: 'manual', createdBy: req.user.email })

    // Blocking has to stop work already in flight, not just write a row. This
    // route is the one the Settings screen calls, and until now it did the
    // least of the two block routes: its sibling POST /api/blocked-domains
    // stopped enrolments and declined queued drafts while this one did not.
    // Both now call the same function (server/suppression.js).
    const applied = result.added.length
      ? applySuppression(req.wsId, result.added.map((r) => ({ value: r.value, isDomain: r.isDomain ?? r.is_domain })), req.user.email)
      : { stoppedLeads: 0, declinedDrafts: 0 }

    if (result.added.length) {
      audit(req, {
        type: 'block_list_added',
        detail: `${req.user.email} blocked ${result.added.map((r) => r.value).join(', ')}`
          + ` — ${applied.stoppedLeads} lead(s) stopped, ${applied.declinedDrafts} draft(s) declined`,
      })
    }
    meter('utilities.block_add', Date.now() - started, true,
      `added=${result.added.length} dupes=${result.duplicates.length} rejected=${result.rejected.length}`)

    const n = result.added.length
    return {
      ok: true,
      success: true,
      message: `${n} ${n === 1 ? 'entry' : 'entries'} added to block list`,
      requested: result.requested,
      added: result.added.map(shape),
      addedCount: n,
      // Reported, because a block that silently stopped nine campaigns is a
      // surprise and a block that stopped nothing is worth knowing too.
      stoppedLeads: applied.stoppedLeads,
      declinedDrafts: applied.declinedDrafts,
      bypassAvailable: false,
      duplicates: result.duplicates,
      duplicateCount: result.duplicates.length,
      rejected: result.rejected,
      rejectedCount: result.rejected.length,
    }
  }))

  // ---- DELETE /api/block-list/:id -------------------------------------------
  // Removal makes leads at that address contactable again, which is why the UI
  // confirms it by name. A second delete 404s, which the UI reads as
  // already-removed.
  api.delete('/block-list/:id', handler(async (req) => {
    const entry = owned('blocked_domains', req.params.id, req.wsId, 'block list entry')
    tx(() => {
      db.prepare('DELETE FROM blocked_domains WHERE id = ? AND workspace_id = ?').run(entry.id, req.wsId)
    })
    audit(req, {
      type: 'block_list_removed',
      detail: `${req.user.email} unblocked ${entry.value} — leads there can be contacted again`,
    })
    return { ok: true, success: true, message: `${entry.value} removed from the block list`, data: shape(entry) }
  }))
}
