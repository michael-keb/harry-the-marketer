// Campaign lifecycle and sequence control — the SmartLead-parity `campaigns`
// category (Docs/campaigns/*.md, §5 of each file), minus the five webhook files
// which belong to server/parity/webhooks.js.
//
// Three things about this module are Harry's own, and are deliberate:
//
//  1. **Sequences are playbook nodes.** SmartLead models a sequence as an
//     ordered list of email steps. Harry's campaign IS a Mermaid flowchart, so
//     `GET /campaigns/:id/steps` projects the stored diagram through
//     `parsePlaybook` and `PUT /campaigns/:id/sequence` accepts a diagram and
//     refuses anything the validator rejects. There is no parallel sequence
//     model to drift out of step with the engine.
//
//  2. **`update-status` accepts START / PAUSED / STOPPED, and `ACTIVE` is a
//     422.** The source page's body spec says `START` while every one of its
//     code samples sends `ACTIVE`; Docs/README.md resolves the contradiction in
//     favour of the body spec and writes `ACTIVE` up as the validation case.
//     See `STATUS_ACTIONS` below.
//
//  3. **Nothing sends without the user's OK.** `test-send`, `forward` and the
//     manual `reply` all require `confirm: true` in the body. The rule is one
//     check (`requireConfirmation`) shared by all three, because three
//     confirmations that drift apart is the same as none.
//
// Paths avoid every method+path server/routes.js already owns. Where the spec's
// preferred path was taken the divergence is noted at the route itself.

import { db } from '../db.js'
import { blockMatch } from '../suppression.js'
// Rates are read from server/metrics.js, never redefined here. `REAL_SEND` is
// the one predicate that decides what counts as outreach, so a filtered rollup
// on this side of the app and the same figure in Reports cannot drift.
import { campaignTotals, ratesFor, REAL_SEND } from '../metrics.js'

// A rate the campaign was never allowed to measure. Keeps the denominator so
// the reader can still see the sample size, but refuses to state a percentage.
function untracked(r, on, reason) {
  return on
    ? { ...r, tracked: true, reason: '' }
    : { ...r, value: null, tracked: false, reason }
}
import { parsePlaybook, nodeIntents } from '../playbook.js'
import { leadStages } from '../stages.js'
import { dailyCap, remainingToday, isWarmingUp } from '../pacing.js'
import { sendEmail } from '../mailer.js'
import { gmailSend } from '../google.js'
import { composeStepSample, exampleLead, CORE_INTENTS } from '../ai.js'
import {
  HttpError, handler, invalid, notFound,
  str, int, bool, oneOf, idList, isoDate, email as emailField,
  owned, ownedAll, tx, nowIso, audit, meter,
} from './http.js'

// ---------------------------------------------------------------- helpers ---

const CAMPAIGN = 'campaign'

// Every :id route funnels through here, so a cross-workspace id is a 404 that
// says "No such campaign" and nothing else — never the name, never a 403.
function campaignOf(req) {
  return owned('campaigns', req.params.id, req.wsId, CAMPAIGN)
}

function ownerOf(wsId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
}

function leadRow(id, wsId) {
  return owned('leads', id, wsId, 'lead')
}

// The lead-in-campaign row. Absent means the lead is not in this campaign,
// which is a 404 about the link, not about the person.
function linkOf(campaign, leadId) {
  const lead = leadRow(leadId, campaign.user_id)
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  if (!cl) throw notFound('lead in this campaign')
  return { lead, cl }
}

function graphOf(campaign) {
  return parsePlaybook(campaign.mermaid || '')
}

// The Send steps of a playbook in reading order, so the source API's
// `email_sequence_number` (1, 2, 3 …) has something to mean in a graph that has
// node ids rather than positions. Breadth-first from Start is the order a human
// reading the diagram would give, and it is the same walk analytics.js uses for
// the per-step statistics route — the two must agree on what "step 2" is.
function sendSequence(graph) {
  const order = []
  if (graph.startId) {
    const seen = new Set([graph.startId])
    const queue = [graph.startId]
    while (queue.length) {
      const cur = queue.shift()
      if (graph.nodes[cur]?.type === 'send') order.push(cur)
      for (const e of graph.edges) {
        if (e.from === cur && graph.nodes[e.to] && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
      }
    }
  }
  return {
    order,
    seqOf: new Map(order.map((id, i) => [id, i + 1])),
    nodeOfSeq: new Map(order.map((id, i) => [i + 1, id])),
  }
}

function jsonOf(text, fallback = {}) {
  try {
    const parsed = JSON.parse(text || '')
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

// SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS'. Window bounds arrive as
// ISO 8601, so they are converted rather than compared across two formats.
function sqlTime(iso) {
  return String(iso).slice(0, 19).replace('T', ' ')
}

function touchCampaign(id) {
  db.prepare("UPDATE campaigns SET updated_at = datetime('now') WHERE id = ?").run(id)
}

// The standing rule, in one place. A send route without an explicit OK is a 422
// on the `confirm` field rather than a silent send.
function requireConfirmation(body, what) {
  if (bool(body, 'confirm', false) !== true) {
    throw invalid('confirm', `Nothing sends without your OK — resubmit with confirm: true to ${what}`)
  }
}

// Test sends are recorded but must never reach a count. Every aggregate in this
// module carries this predicate so the exclusion cannot be forgotten in one
// place and remembered in another.
const NOT_TEST = "COALESCE(send_status,'') != 'test'"

function todayStr() { return new Date().toISOString().slice(0, 10) }

// http.js's `email()` names the body key it was given; addresses inside arrays
// need to be named by their position, so a 422 points at the row that is wrong.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
function emailAt(value, field) {
  const text = String(value ?? '').trim()
  if (!text) throw invalid(field, `${field} is required`)
  if (text.length > 320 || !EMAIL_RE.test(text)) throw invalid(field, `${field} must be a valid email address`)
  return text.toLowerCase()
}

// mailer.js keeps its quota bump private; forwards and test sends must still
// count, so the same two-line update lives here.
function bumpQuota(mailbox) {
  const today = todayStr()
  if (mailbox.sent_today_date === today) {
    db.prepare('UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ?').run(mailbox.id)
  } else {
    db.prepare('UPDATE mailboxes SET sent_today = 1, sent_today_date = ? WHERE id = ?').run(today, mailbox.id)
  }
}

// ---- settings ---------------------------------------------------------------

// The source page names fields in prose ("its name, what it tracks, ...") that
// its own schema never defines. Docs/README.md's ruling: implement the schema,
// ignore the prose-only fields. This object IS the schema — an unknown key is a
// 422 rather than a silently dropped setting.
const TRACK_VALUES = ['DONT_TRACK_EMAIL_OPEN', 'DONT_TRACK_LINK_CLICK', 'DONT_TRACK_REPLY_TO_AN_EMAIL']
const STOP_VALUES = ['REPLY_TO_AN_EMAIL', 'OPEN_AN_EMAIL', 'CLICK_ON_A_LINK']
const OOO_KEYS = ['ignoreOOOasReply', 'autoReactivateOOO', 'reactivateOOOwithDelay', 'autoCategorizeOOO']
const SETTINGS_KEYS = [
  'name', 'track_settings', 'stop_lead_settings', 'send_as_plain_text',
  'force_plain_text', 'unsubscribe_text', 'follow_up_percentage',
  'out_of_office_detection_settings',
]

function settingsOf(campaign) {
  const stored = jsonOf(campaign.settings)
  return {
    track_settings: Array.isArray(stored.track_settings) ? stored.track_settings : [],
    stop_lead_settings: stored.stop_lead_settings || 'REPLY_TO_AN_EMAIL',
    send_as_plain_text: Boolean(stored.send_as_plain_text),
    force_plain_text: Boolean(stored.force_plain_text),
    unsubscribe_text: stored.unsubscribe_text || '',
    follow_up_percentage: Number.isFinite(stored.follow_up_percentage) ? stored.follow_up_percentage : 100,
    out_of_office_detection_settings: {
      ignoreOOOasReply: Boolean(stored.out_of_office_detection_settings?.ignoreOOOasReply),
      autoReactivateOOO: Boolean(stored.out_of_office_detection_settings?.autoReactivateOOO),
      reactivateOOOwithDelay: Number(stored.out_of_office_detection_settings?.reactivateOOOwithDelay) || 0,
      autoCategorizeOOO: stored.out_of_office_detection_settings?.autoCategorizeOOO !== false,
    },
    // Read-time projection of the columns the mailer and engine actually read,
    // so a client never has to reconcile the JSON with the columns.
    track_opens: Boolean(campaign.track_opens),
    track_clicks: Boolean(campaign.track_clicks),
    stop_on_reply: Boolean(campaign.stop_on_reply),
    tracking_domain: campaign.tracking_domain || '',
    reply_to: campaign.reply_to || '',
  }
}

// Workspace defaults are applied at read time rather than copied at creation,
// so changing the workspace window moves every campaign that never set its own.
function scheduleOf(campaign, owner) {
  const stored = jsonOf(campaign.schedule)
  const wsDays = owner?.send_days === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]
  return {
    timezone: stored.timezone || owner?.send_timezone || '',
    days: Array.isArray(stored.days) && stored.days.length ? stored.days : wsDays,
    start_hour: stored.start_hour || owner?.send_from || '08:30',
    end_hour: stored.end_hour || owner?.send_to || '17:30',
    min_gap_minutes: Number.isFinite(stored.min_gap_minutes) ? stored.min_gap_minutes : 0,
    isDefault: !stored.start_hour && !stored.days,
  }
}

// ---- projections ------------------------------------------------------------

function campaignCounts(campaignId) {
  const row = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN state IN ('queued','active','waiting') THEN 1 ELSE 0 END) inFlight,
            SUM(CASE WHEN state = 'finished' THEN 1 ELSE 0 END) finished,
            SUM(CASE WHEN state = 'needs_attention' THEN 1 ELSE 0 END) needsAttention,
            SUM(CASE WHEN COALESCE(paused_at,'') != '' THEN 1 ELSE 0 END) paused
     FROM campaign_leads WHERE campaign_id = ?`
  ).get(campaignId)
  return {
    total: row.total || 0,
    inFlight: row.inFlight || 0,
    finished: row.finished || 0,
    needsAttention: row.needsAttention || 0,
    paused: row.paused || 0,
  }
}

function campaignRow(c) {
  const counts = campaignCounts(c.id)
  const totals = campaignTotals(c.id)
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    state: statusLabel(c),
    statusReason: c.status_reason || '',
    statusAt: c.status_at || '',
    ownerEmail: c.owner_email || '',
    clientId: c.client_id || null,
    parentCampaignId: c.parent_campaign_id || null,
    mailboxId: c.mailbox_id || null,
    trackOpens: Boolean(c.track_opens),
    trackClicks: Boolean(c.track_clicks),
    stopOnReply: Boolean(c.stop_on_reply),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    leadCount: counts.total,
    counts,
    totals,
  }
}

// ---- status -----------------------------------------------------------------

// `campaigns.status` is CHECK-constrained to draft/running/paused/archived, so
// STOPPED — which the source API treats as terminal — is stored as `archived`
// with `status_reason = 'STOPPED'`. That is what makes a stop irreversible
// without touching the core schema, which this module may not change.
const STATUS_ACTIONS = {
  START: { status: 'running', reason: '' },
  PAUSED: { status: 'paused', reason: '' },
  STOPPED: { status: 'archived', reason: 'STOPPED' },
}

function isStopped(c) {
  return c.status === 'archived' && c.status_reason === 'STOPPED'
}

function statusLabel(c) {
  if (isStopped(c)) return 'STOPPED'
  return { running: 'START', paused: 'PAUSED', archived: 'ARCHIVED', draft: 'DRAFT' }[c.status] || c.status
}

// Every unmet launch condition, together, rather than the first one found.
function launchBlockers(campaign) {
  const blockers = []
  const graph = graphOf(campaign)
  if (!graph.valid) {
    blockers.push({ field: 'playbook', message: 'Fix the playbook before starting', errors: graph.errors })
  }
  const mailboxes = db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n
  if (!mailboxes && !campaign.mailbox_id) {
    blockers.push({ field: 'mailboxes', message: 'Attach a sending mailbox before starting' })
  }
  const leads = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n
  if (!leads) blockers.push({ field: 'leads', message: 'Attach at least one lead before starting' })
  return blockers
}

// ---- csv --------------------------------------------------------------------

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// ---- test-send throttle -----------------------------------------------------

// Per user per hour, in process. A test send is a real send; the rate limit is
// part of "nothing sends without the user's OK" rather than an optimisation.
const TEST_SENDS = new Map()
const TEST_SEND_LIMIT = 20

function throttleTestSend(email) {
  const now = Date.now()
  const recent = (TEST_SENDS.get(email) || []).filter((t) => now - t < 3600e3)
  if (recent.length >= TEST_SEND_LIMIT) {
    throw new HttpError(429, { error: 'rate_limited', message: `At most ${TEST_SEND_LIMIT} test sends an hour` })
  }
  recent.push(now)
  TEST_SENDS.set(email, recent)
}

// ---- telemetry --------------------------------------------------------------

// Every campaigns spec's §5 Scope asks for a `telemetry` row per call, and for
// 1,868 lines exactly one route wrote one. Threading a stopwatch through forty
// handlers by hand is how that happened, so the stopwatch lives in the wrapper
// instead: `metered` is `handler` plus the row, and a route added tomorrow gets
// its telemetry by construction rather than by someone remembering.
//
// The op name comes from the registered route pattern, not the request path, so
// `/campaigns/41/leads` and `/campaigns/9/leads` aggregate into one line on
// Monitoring rather than one per campaign id. Routes whose spec wants more than
// a duration — the filter shape on the leads list, the export's row count — call
// `meter()` themselves and stay on plain `handler`.
function metered(fn) {
  return handler(async (req, res) => {
    const t0 = Date.now()
    const op = () => `campaigns ${req.method} ${req.route?.path || req.path}`
    try {
      const out = await fn(req, res)
      meter(op(), Date.now() - t0)
      return out
    } catch (err) {
      meter(op(), Date.now() - t0, false, err?.body?.error || String(err?.message || err))
      throw err
    }
  })
}

// =============================================================================

export function register(api) {
  // ------------------------------------------------------------- get-all ----
  // Docs/campaigns/get-all.md. The source API returns every campaign and
  // recommends client-side paging; Harry pages server-side (Docs/README.md,
  // "Unbounded requests are rejected"). `GET /api/campaigns` belongs to
  // server/routes.js, so the paged list lives at a distinct path — and not
  // under /campaigns/ at all, because routes.js's `GET /campaigns/:id` mounts
  // first and would capture any single segment after it.
  const listCampaigns = handler((req) => {
    const t0 = Date.now()
    const status = str(req.query, 'status', { max: 20 })
    if (status && !['draft', 'running', 'paused', 'archived'].includes(status)) {
      throw invalid('status', 'status must be one of: draft, running, paused, archived')
    }
    const q = str(req.query, 'q', { max: 200 })
    const limit = int(req.query, 'limit', { min: 1, max: 200, fallback: 50 })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })
    const includeArchived = bool(req.query, 'includeArchived', false)
    const parentId = int(req.query, 'parentCampaignId', { min: 1, fallback: 0 })
    // The client lens. `client_id` was written by every create path and read by
    // nothing, so an agency could tag work by client and never filter by it.
    const clientId = int(req.query, 'clientId', { min: 1, fallback: 0 })

    const where = ['user_id = ?']
    const args = [req.wsId]
    if (clientId) { where.push('client_id = ?'); args.push(clientId) }
    if (status) { where.push('status = ?'); args.push(status) }
    else if (!includeArchived) where.push("status != 'archived'")
    if (q) { where.push('LOWER(name) LIKE ?'); args.push(`%${q.toLowerCase()}%`) }
    if (parentId) { where.push('parent_campaign_id = ?'); args.push(parentId) }
    const clause = where.join(' AND ')

    const total = db.prepare(`SELECT COUNT(*) n FROM campaigns WHERE ${clause}`).get(...args).n
    const rows = db.prepare(`SELECT * FROM campaigns WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    meter('campaigns.list', Date.now() - t0)
    return { campaigns: rows.map(campaignRow), total, limit, offset }
  })
  api.get('/campaign-list', listCampaigns)

  // -------------------------------------------------- all-leads-activities --
  // Docs/campaigns/all-leads-activities.md names `GET /api/activity`. It is not
  // put under /leads/* because the leads category owns that prefix.
  api.get('/activity', metered((req) => {
    const from = isoDate(req.query, 'from')
    const to = isoDate(req.query, 'to')
    if (from && to && from > to) throw invalid('to', 'to must be on or after from')
    const type = str(req.query, 'type', { max: 60 })
    const campaignId = int(req.query, 'campaignId', { min: 1, fallback: 0 })
    const limit = int(req.query, 'limit', { min: 1, max: 1000, fallback: 100 })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })

    const where = ['user_id = ?']
    const args = [req.wsId]
    if (from) { where.push('created_at >= ?'); args.push(sqlTime(from)) }
    if (to) { where.push('created_at <= ?'); args.push(sqlTime(to)) }
    if (type) { where.push('type = ?'); args.push(type) }
    if (campaignId) { where.push('campaign_id = ?'); args.push(campaignId) }
    const clause = where.join(' AND ')

    const total = db.prepare(`SELECT COUNT(*) n FROM events WHERE ${clause}`).get(...args).n
    const rows = db.prepare(
      `SELECT id, campaign_id, lead_id, type, detail, created_at FROM events
       WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset)
    return {
      activities: rows.map((r) => ({
        id: r.id, campaignId: r.campaign_id, leadId: r.lead_id,
        type: r.type, detail: r.detail, createdAt: r.created_at,
      })),
      total, limit, offset,
    }
  }))

  // -------------------------------------------------------------- create ----
  // Docs/campaigns/create.md. `POST /api/campaigns` belongs to routes.js, so
  // this mirrors the source API's own literal path. A campaign is never created
  // implicitly anywhere else in the codebase (Docs/README.md).
  api.post('/campaigns/create', metered((req) => {
    const name = str(req.body, 'name', { max: 200, fallback: '' }) || 'Untitled campaign'
    const goalId = int(req.body, 'goalId', { min: 1, fallback: 0 })
    const clientId = int(req.body, 'clientId', { min: 1, fallback: 0 })
    if (goalId) owned('goals', goalId, req.wsId, 'goal')
    if (clientId) owned('clients', clientId, req.wsId, 'client')

    // Double-submit guard: the same name from the same workspace inside ten
    // seconds is the same click, not a second campaign.
    const twin = db.prepare(
      `SELECT * FROM campaigns WHERE user_id = ? AND name = ?
         AND created_at >= datetime('now', '-10 seconds') ORDER BY id DESC LIMIT 1`
    ).get(req.wsId, name)
    if (twin) return { ...campaignRow(twin), deduplicated: true }

    const created = tx(() => {
      const info = db.prepare(
        `INSERT INTO campaigns (user_id, name, status, mermaid, owner_email, client_id, status_at)
         VALUES (?, ?, 'draft', '', ?, ?, ?)`
      ).run(req.wsId, name, req.user.email, clientId || null, nowIso())
      if (goalId) db.prepare('UPDATE goals SET campaign_id = ? WHERE id = ? AND user_id = ?').run(info.lastInsertRowid, goalId, req.wsId)
      return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid)
    })
    audit(req, { campaignId: created.id, type: 'campaign_created', detail: `${name} (${goalId ? 'goal' : 'manual'})` })
    return { ok: true, ...campaignRow(created) }
  }))

  // ------------------------------------------------------------- get-by-id --
  // Docs/campaigns/get-by-id.md. `GET /api/campaigns/:id` belongs to routes.js;
  // this is the parity assembly (playbook validation + pacing + mailboxes).
  api.get('/campaigns/:id/detail', metered((req) => {
    const c = campaignOf(req)
    const owner = ownerOf(req.wsId)
    const graph = graphOf(c)
    const mailboxes = db.prepare(
      `SELECT m.id, m.email, m.display_name, m.provider, m.status FROM campaign_mailboxes cm
       JOIN mailboxes m ON m.id = cm.mailbox_id WHERE cm.campaign_id = ? ORDER BY cm.id`
    ).all(c.id)
    const parent = c.parent_campaign_id
      ? db.prepare('SELECT id, name, status FROM campaigns WHERE id = ? AND user_id = ?').get(c.parent_campaign_id, req.wsId)
      : null
    const children = db.prepare('SELECT id, name, status FROM campaigns WHERE parent_campaign_id = ? AND user_id = ?').all(c.id, req.wsId)
    return {
      ...campaignRow(c),
      mermaid: c.mermaid,
      validation: { valid: graph.valid, errors: graph.errors, warnings: graph.warnings },
      settings: settingsOf(c),
      schedule: scheduleOf(c, owner),
      mailboxes,
      parent: parent || null,
      children,
      blockers: launchBlockers(c),
    }
  }))

  // ---------------------------------------------------------- update-status --
  // Docs/campaigns/update-status.md, TC-4. The page's body spec says START; all
  // of its code samples say ACTIVE. Harry implements the body spec, and ACTIVE
  // is the named validation case — see the module header.
  api.put('/campaigns/:id/status', metered((req) => {
    const c = campaignOf(req)
    const raw = str(req.body, 'status', { required: true, max: 20 }).toUpperCase()
    if (!STATUS_ACTIONS[raw]) {
      const hint = raw === 'ACTIVE'
        ? 'ACTIVE is not accepted: the source API\'s samples send it but its body spec — and Harry — use START.'
        : ''
      throw invalid('status', `status must be one of: START, PAUSED, STOPPED${hint ? `. ${hint}` : ''}`)
    }
    if (isStopped(c) && raw !== 'STOPPED') {
      throw new HttpError(409, {
        error: 'campaign_stopped',
        message: 'This campaign was stopped permanently. Duplicate it to run it again.',
      })
    }
    if (raw === 'START') {
      const blockers = launchBlockers(c)
      if (blockers.length) {
        throw new HttpError(422, {
          error: 'validation_failed', field: 'status',
          message: 'This campaign is not ready to start', blockers,
        })
      }
    }
    const target = STATUS_ACTIONS[raw]
    const before = statusLabel(c)
    tx(() => {
      db.prepare("UPDATE campaigns SET status = ?, status_reason = ?, status_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(target.status, target.reason, nowIso(), c.id)
      // Pausing holds approved-but-unsent drafts rather than discarding them:
      // the row stays `approved` and the engine's status check is what stops it.
      if (raw === 'STOPPED') {
        db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE campaign_id = ? AND status = 'pending'")
          .run(req.user.email, c.id)
      }
    })
    audit(req, { campaignId: c.id, type: 'campaign_status', detail: `${before} -> ${raw} by ${req.user.email}` })
    const after = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id)
    return { success: true, message: 'Campaign status updated successfully', campaign: campaignRow(after) }
  }))

  // ------------------------------------------------------------ update-settings
  api.put('/campaigns/:id/settings', metered((req) => {
    const c = campaignOf(req)
    const body = req.body || {}
    for (const key of Object.keys(body)) {
      if (!SETTINGS_KEYS.includes(key)) throw invalid(key, `${key} is not a campaign setting`)
    }
    const current = settingsOf(c)
    const next = { ...current }

    if (body.name !== undefined) next.name = str(body, 'name', { required: true, max: 200 })
    if (body.track_settings !== undefined) {
      if (!Array.isArray(body.track_settings)) throw invalid('track_settings', 'track_settings must be an array')
      for (const value of body.track_settings) {
        if (!TRACK_VALUES.includes(value)) throw invalid('track_settings', `track_settings must contain only: ${TRACK_VALUES.join(', ')}`)
      }
      next.track_settings = [...new Set(body.track_settings)]
    }
    if (body.stop_lead_settings !== undefined) {
      next.stop_lead_settings = oneOf(body, 'stop_lead_settings', STOP_VALUES, { required: true })
    }
    if (body.send_as_plain_text !== undefined) next.send_as_plain_text = bool(body, 'send_as_plain_text', false)
    if (body.force_plain_text !== undefined) next.force_plain_text = bool(body, 'force_plain_text', false)
    // Emptying the wording restores the default: an email with no opt-out is
    // never sent, so this field can be changed but not removed.
    if (body.unsubscribe_text !== undefined) next.unsubscribe_text = str(body, 'unsubscribe_text', { max: 500 })
    if (body.follow_up_percentage !== undefined) {
      next.follow_up_percentage = int(body, 'follow_up_percentage', { required: true, min: 0, max: 100 })
    }
    if (body.out_of_office_detection_settings !== undefined) {
      const ooo = body.out_of_office_detection_settings
      if (!ooo || typeof ooo !== 'object' || Array.isArray(ooo)) {
        throw invalid('out_of_office_detection_settings', 'out_of_office_detection_settings must be an object')
      }
      for (const key of Object.keys(ooo)) {
        if (!OOO_KEYS.includes(key)) throw invalid('out_of_office_detection_settings', `${key} is not an out-of-office setting`)
      }
      next.out_of_office_detection_settings = {
        ignoreOOOasReply: bool(ooo, 'ignoreOOOasReply', current.out_of_office_detection_settings.ignoreOOOasReply),
        autoReactivateOOO: bool(ooo, 'autoReactivateOOO', current.out_of_office_detection_settings.autoReactivateOOO),
        reactivateOOOwithDelay: int(ooo, 'reactivateOOOwithDelay', { min: 0, max: 90, fallback: current.out_of_office_detection_settings.reactivateOOOwithDelay }),
        autoCategorizeOOO: bool(ooo, 'autoCategorizeOOO', current.out_of_office_detection_settings.autoCategorizeOOO),
      }
    }

    const trackOpens = next.track_settings.includes('DONT_TRACK_EMAIL_OPEN') ? 0 : 1
    const trackClicks = next.track_settings.includes('DONT_TRACK_LINK_CLICK') ? 0 : 1
    const stopOnReply = next.track_settings.includes('DONT_TRACK_REPLY_TO_AN_EMAIL') ? 0
      : next.stop_lead_settings === 'REPLY_TO_AN_EMAIL' ? 1 : 0

    const changed = SETTINGS_KEYS.filter((k) => body[k] !== undefined)
    const stored = { ...next }
    delete stored.track_opens; delete stored.track_clicks; delete stored.stop_on_reply
    delete stored.tracking_domain; delete stored.reply_to; delete stored.name

    tx(() => {
      db.prepare(
        `UPDATE campaigns SET name = ?, settings = ?, track_opens = ?, track_clicks = ?,
           stop_on_reply = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(next.name || c.name, JSON.stringify(stored), trackOpens, trackClicks, stopOnReply, c.id)
    })
    audit(req, { campaignId: c.id, type: 'campaign_settings', detail: `changed: ${changed.join(', ') || 'nothing'}` })
    const after = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id)
    return { success: true, data: { message: 'Settings updated successfully' }, settings: settingsOf(after) }
  }))

  // ---------------------------------------------------------- update-schedule
  api.put('/campaigns/:id/schedule', metered((req) => {
    const c = campaignOf(req)
    const owner = ownerOf(req.wsId)
    const body = req.body || {}

    const timezone = str(body, 'timezone', { max: 80 })
    if (timezone) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }) }
      catch { throw invalid('timezone', `timezone must be an IANA zone, not "${timezone}"`) }
    }
    let days = scheduleOf(c, owner).days
    if (body.days !== undefined) {
      if (!Array.isArray(body.days) || body.days.length === 0) throw invalid('days', 'days must list at least one day')
      days = []
      for (const d of body.days) {
        const n = Number(d)
        if (!Number.isInteger(n) || n < 0 || n > 6) throw invalid('days', 'days must be integers 0-6 (Sunday first)')
        if (!days.includes(n)) days.push(n)
      }
      days.sort()
    }
    const hour = (field, fallback) => {
      const value = str(body, field, { max: 5, fallback })
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid(field, `${field} must be HH:MM`)
      return value
    }
    const existing = scheduleOf(c, owner)
    const startHour = hour('start_hour', existing.start_hour)
    const endHour = hour('end_hour', existing.end_hour)
    if (endHour <= startHour) throw invalid('end_hour', 'end_hour must be after start_hour')
    const minGap = int(body, 'min_gap_minutes', { min: 0, max: 1440, fallback: existing.min_gap_minutes })

    const schedule = { timezone, days, start_hour: startHour, end_hour: endHour, min_gap_minutes: minGap }
    db.prepare("UPDATE campaigns SET schedule = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(schedule), c.id)
    audit(req, {
      campaignId: c.id, type: 'campaign_schedule',
      detail: `${existing.start_hour}-${existing.end_hour} -> ${startHour}-${endHour} (${days.join(',')})`,
    })
    return { ok: true, schedule: { ...schedule, isDefault: false } }
  }))

  // ------------------------------------------------------------ update-owner --
  // Docs/campaigns/update-team-member.md. Assignment never gates an action:
  // authorization stays workspace-level.
  api.put('/campaigns/:id/owner', metered((req) => {
    const c = campaignOf(req)
    const body = req.body || {}
    if (body.user_id === null || body.user_id === undefined) {
      db.prepare("UPDATE campaigns SET owner_email = '', updated_at = datetime('now') WHERE id = ?").run(c.id)
      audit(req, { campaignId: c.id, type: 'campaign_owner', detail: `cleared by ${req.user.email}` })
      return { ok: true, ownerEmail: '' }
    }
    const userId = int(body, 'user_id', { required: true, min: 1 })
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    if (!user) throw notFound('workspace member')
    const isOwner = user.id === req.wsId
    const membership = db.prepare("SELECT * FROM team_members WHERE owner_id = ? AND email = ?").get(req.wsId, user.email)
    if (!isOwner && !membership) throw notFound('workspace member')
    // An invited-but-not-joined address is not yet a member and cannot own work.
    if (!isOwner && membership.status !== 'active') {
      throw invalid('user_id', 'That person has been invited but has not signed in yet')
    }
    db.prepare("UPDATE campaigns SET owner_email = ?, updated_at = datetime('now') WHERE id = ?").run(user.email, c.id)
    audit(req, { campaignId: c.id, type: 'campaign_owner', detail: `${c.owner_email || 'nobody'} -> ${user.email}` })
    return { ok: true, ownerEmail: user.email }
  }))

  // -------------------------------------------------------- get-sequences ----
  // Sequences are playbook nodes. This projects the stored Mermaid through the
  // one parser; there is no second implementation of the DSL.
  api.get('/campaigns/:id/steps', metered((req) => {
    const c = campaignOf(req)
    const graph = graphOf(c)
    if (!graph.valid) return { steps: [], errors: graph.errors, warnings: graph.warnings, valid: false }

    const withSamples = bool(req.query, 'sample', false)
    const samples = withSamples
      ? Object.fromEntries(db.prepare('SELECT node_id, subject, body FROM node_examples WHERE campaign_id = ?')
        .all(c.id).map((r) => [r.node_id, { subject: r.subject, body: r.body }]))
      : {}
    const sentPerNode = Object.fromEntries(db.prepare(
      `SELECT node_id, COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'
         AND ${NOT_TEST} AND node_id NOT IN ('', 'manual') GROUP BY node_id`
    ).all(c.id).map((r) => [r.node_id, r.n]))

    // Breadth-first from Start, so "position" is a reading order a human would
    // recognise from the diagram rather than an arbitrary map order.
    const order = []
    const seen = new Set()
    const queue = graph.startId ? [graph.startId] : Object.keys(graph.nodes)
    while (queue.length) {
      const id = queue.shift()
      if (!id || seen.has(id) || !graph.nodes[id]) continue
      seen.add(id)
      order.push(id)
      for (const e of graph.edges) if (e.from === id && !seen.has(e.to)) queue.push(e.to)
    }
    for (const id of Object.keys(graph.nodes)) if (!seen.has(id)) order.push(id)

    const steps = order.map((id, i) => {
      const node = graph.nodes[id]
      const out = graph.edges.filter((e) => e.from === id)
      return {
        nodeId: id,
        position: i,
        type: node.type,
        label: node.label,
        instruction: node.instruction || '',
        waitMs: node.ms ?? null,
        outcome: node.outcome || null,
        branches: out.map((e) => ({ to: e.to, label: e.label, condition: e.cond })),
        replyIntents: nodeIntents(graph, id),
        sent: sentPerNode[id] || 0,
        sample: samples[id] || null,
      }
    })
    return { steps, errors: [], warnings: graph.warnings, valid: true, startId: graph.startId }
  }))

  // ------------------------------------------------------- update-sequences --
  // The whole step set arrives as the Mermaid diagram it really is. An invalid
  // diagram is a 422 carrying the validator's own message, not a paraphrase.
  api.put('/campaigns/:id/sequence', handler((req) => {
    const t0 = Date.now()
    const c = campaignOf(req)
    if (c.status === 'running') {
      throw new HttpError(409, {
        error: 'campaign_running',
        message: 'Pause this campaign before editing its sequence.',
      })
    }
    const mermaid = str(req.body, 'mermaid', { required: true, max: 100000 })
    const graph = parsePlaybook(mermaid)
    if (!graph.valid) {
      throw new HttpError(422, {
        error: 'validation_failed', field: 'mermaid',
        message: graph.errors[0].message,
        errors: graph.errors,
        warnings: graph.warnings,
      })
    }
    // Merge variables must resolve against real lead fields.
    const leadFields = ['first_name', 'last_name', 'email', 'company', 'title', 'phone', 'website', 'linkedin', 'location']
    const custom = new Set()
    for (const row of db.prepare("SELECT custom_fields FROM leads WHERE user_id = ? AND COALESCE(custom_fields,'{}') != '{}' LIMIT 500").all(req.wsId)) {
      for (const key of Object.keys(jsonOf(row.custom_fields))) custom.add(key)
    }
    for (const match of mermaid.matchAll(/\{\{\s*([a-zA-Z0-9_ .-]+)\s*\}\}/g)) {
      const field = match[1].trim()
      if (!leadFields.includes(field) && !custom.has(field)) {
        throw invalid('mermaid', `Merge variable {{${field}}} is not a lead field`)
      }
    }

    // "A delay must be between 0 and 365 days" — the source models a delay as a
    // number on a step; Harry's is a Wait node's duration or the "no reply Xd"
    // label on an edge. Both are checked, and the 422 names the step so the
    // editor can point at the line rather than at the whole diagram.
    const MAX_DELAY_MS = 365 * 86400e3
    for (const node of Object.values(graph.nodes)) {
      if (node.type === 'wait' && Number.isFinite(node.ms) && node.ms > MAX_DELAY_MS) {
        throw invalid('mermaid', `Step "${node.id}" waits longer than 365 days — a delay must be between 0 and 365 days`)
      }
    }
    for (const edge of graph.edges) {
      const ms = edge.cond?.ms
      if (Number.isFinite(ms) && ms > MAX_DELAY_MS) {
        throw invalid('mermaid', `The "${edge.label || edge.cond.kind}" branch out of "${edge.from}" waits longer than 365 days — a delay must be between 0 and 365 days`)
      }
    }

    // What the save would do to the leads already standing in the playbook,
    // computed before anything is written so `preview: true` can show it and the
    // save itself can report the same numbers. The §4 DoD is "lead remapping is
    // shown before the save is committed"; that needs the server to be able to
    // answer the question without committing.
    const orphaned = db.prepare(
      "SELECT node_id, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND state NOT IN ('finished','stopped') AND COALESCE(node_id,'') != '' GROUP BY node_id"
    ).all(c.id).filter((row) => !graph.nodes[row.node_id])
      .map((row) => ({
        node: row.node_id,
        leads: row.n,
        // Not silently restarted and never resent: a human decides where they go.
        goesTo: 'needs_attention',
        message: `${row.n} lead${row.n === 1 ? '' : 's'} standing at "${row.node_id}" will be parked for review — the step no longer exists.`,
      }))
    const nodeIds = Object.keys(graph.nodes)
    const droppedCopy = db.prepare('SELECT node_id FROM node_examples WHERE campaign_id = ?').all(c.id)
      .filter((r) => !nodeIds.includes(r.node_id)).map((r) => r.node_id)
    // Each step with its id and its resolved position, which is what the
    // response is required to carry back.
    const { seqOf } = sendSequence(graph)
    const steps = Object.values(graph.nodes).map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      // Position among the Send steps; a Wait or an outcome node has none.
      position: seqOf.get(n.id) ?? null,
      waitMs: n.ms ?? null,
    })).sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || a.id.localeCompare(b.id))

    if (bool(req.body, 'preview', false)) {
      meter('campaigns.sequence', Date.now() - t0, true, 'preview')
      return {
        ok: true, preview: true, saved: false,
        // TC-1's shape: `data` is the step set with ids and positions. `steps`
        // stays the count, because CampaignDetail already renders it as one.
        data: steps, steps: steps.length,
        remapping: orphaned,
        remapped: orphaned.reduce((sum, o) => sum + o.leads, 0),
        droppedCopy: droppedCopy.length,
        warnings: graph.warnings,
      }
    }

    const result = tx(() => {
      db.prepare("UPDATE campaigns SET mermaid = ?, updated_at = datetime('now') WHERE id = ?").run(mermaid, c.id)
      // Leads standing on a step that no longer exists are parked for a human
      // rather than silently restarted — deterministic, and never a resend.
      const live = db.prepare(
        "SELECT * FROM campaign_leads WHERE campaign_id = ? AND state NOT IN ('finished','stopped')"
      ).all(c.id)
      let remapped = 0
      for (const cl of live) {
        if (!cl.node_id || graph.nodes[cl.node_id]) continue
        db.prepare("UPDATE campaign_leads SET state = 'needs_attention', error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(`Step "${cl.node_id}" was removed from the playbook`, cl.id)
        remapped++
      }
      // Approved copy for steps that no longer exist has nothing to attach to.
      const nodeIds = Object.keys(graph.nodes)
      const stale = db.prepare('SELECT node_id FROM node_examples WHERE campaign_id = ?').all(c.id)
        .filter((r) => !nodeIds.includes(r.node_id))
      for (const row of stale) {
        db.prepare('DELETE FROM node_examples WHERE campaign_id = ? AND node_id = ?').run(c.id, row.node_id)
      }
      return { remapped, droppedCopy: stale.length }
    })
    audit(req, {
      campaignId: c.id, type: 'campaign_sequence',
      detail: `${Object.keys(graph.nodes).length} steps, ${result.remapped} leads remapped`,
    })
    meter('campaigns.sequence', Date.now() - t0, true, `steps=${steps.length} remapped=${result.remapped}`)
    return {
      ok: true,
      data: steps,
      steps: Object.keys(graph.nodes).length,
      remapping: orphaned,
      ...result,
      warnings: graph.warnings,
    }
  }))

  // ------------------------------------------------------------- duplicate ---
  // Deep-copies configuration and nothing else. The copy can never contact the
  // original's audience because it has no audience.
  api.post('/campaigns/:id/duplicate', metered((req) => {
    const c = campaignOf(req)
    const includeChildren = bool(req.body, 'includeChildren', false)
    const name = str(req.body, 'name', { max: 200, fallback: '' }) || `${c.name} (copy)`

    const copyOne = (source, newName, parentId) => {
      const info = db.prepare(
        `INSERT INTO campaigns
           (user_id, name, status, mailbox_id, mermaid, client_id, parent_campaign_id, owner_email,
            status_reason, status_at, schedule, settings, track_opens, track_clicks,
            stop_on_reply, stop_on_source_reply, tracking_domain, reply_to)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        source.user_id, newName, source.mailbox_id, source.mermaid, source.client_id,
        parentId, source.owner_email, nowIso(), source.schedule || '{}', source.settings || '{}',
        source.track_opens, source.track_clicks, source.stop_on_reply, source.stop_on_source_reply,
        source.tracking_domain || '', source.reply_to || ''
      )
      const newId = info.lastInsertRowid
      for (const row of db.prepare('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?').all(source.id)) {
        db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(newId, row.mailbox_id)
      }
      // Approved copy is configuration, not a statistic — it travels with the
      // playbook step it belongs to. Leads, messages and stats do not.
      for (const row of db.prepare('SELECT node_id, subject, body FROM node_examples WHERE campaign_id = ?').all(source.id)) {
        db.prepare('INSERT OR IGNORE INTO node_examples (campaign_id, node_id, subject, body) VALUES (?, ?, ?, ?)')
          .run(newId, row.node_id, row.subject, row.body)
      }
      return newId
    }

    const created = tx(() => {
      const newId = copyOne(c, name, c.parent_campaign_id || null)
      const childIds = []
      if (includeChildren) {
        const children = db.prepare('SELECT * FROM campaigns WHERE parent_campaign_id = ? AND user_id = ?').all(c.id, req.wsId)
        for (const child of children) childIds.push(copyOne(child, `${child.name} (copy)`, newId))
      }
      return { newId, childIds }
    })
    audit(req, {
      campaignId: created.newId, type: 'campaign_duplicated',
      detail: `from #${c.id}${includeChildren ? ` with ${created.childIds.length} children` : ''}`,
    })
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(created.newId)
    return { ok: true, id: created.newId, childIds: created.childIds, campaign: campaignRow(row) }
  }))

  // ------------------------------------------------------ create-subsequence --
  api.post('/campaigns/:id/children', metered((req) => {
    const parent = campaignOf(req)
    const name = str(req.body, 'name', { required: true, max: 200 })
    const triggersRaw = req.body?.triggers
    if (triggersRaw !== undefined && !Array.isArray(triggersRaw)) throw invalid('triggers', 'triggers must be an array')
    const triggers = (triggersRaw || []).map((t, i) => {
      const value = String(t ?? '').trim().toLowerCase()
      if (!value) throw invalid('triggers', `triggers[${i}] is empty`)
      if (value.length > 80) throw invalid('triggers', `triggers[${i}] must be 80 characters or fewer`)
      return value
    })
    if (new Set(triggers).size !== triggers.length) throw invalid('triggers', 'triggers must be unique')

    // A parent chain deeper than this is a loop dressed up as a hierarchy.
    let depth = 0
    let cursor = parent
    while (cursor?.parent_campaign_id && depth < 10) {
      cursor = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cursor.parent_campaign_id)
      depth++
    }
    if (depth >= 10) throw invalid('id', 'Subsequence chain is too deep — this would create a cycle')

    const created = tx(() => {
      const info = db.prepare(
        `INSERT INTO campaigns (user_id, name, status, mermaid, parent_campaign_id, owner_email, client_id, settings, status_at)
         VALUES (?, ?, 'draft', '', ?, ?, ?, ?, ?)`
      ).run(req.wsId, name, parent.id, req.user.email, parent.client_id, JSON.stringify({ triggers }), nowIso())
      return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid)
    })
    audit(req, { campaignId: created.id, type: 'subsequence_created', detail: `parent #${parent.id}, triggers: ${triggers.join(', ') || 'none'}` })
    return { ok: true, id: created.id, ...campaignRow(created), triggers }
  }))

  api.get('/campaigns/:id/children', metered((req) => {
    const parent = campaignOf(req)
    const limit = int(req.query, 'limit', { min: 1, max: 200, fallback: 50 })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })
    const total = db.prepare('SELECT COUNT(*) n FROM campaigns WHERE parent_campaign_id = ? AND user_id = ?').get(parent.id, req.wsId).n
    const rows = db.prepare('SELECT * FROM campaigns WHERE parent_campaign_id = ? AND user_id = ? ORDER BY id LIMIT ? OFFSET ?')
      .all(parent.id, req.wsId, limit, offset)
    return {
      children: rows.map((r) => ({ ...campaignRow(r), triggers: jsonOf(r.settings).triggers || [] })),
      total, limit, offset,
    }
  }))

  // Unlink without deleting: the child survives as a standalone campaign.
  api.delete('/campaigns/:id/children/:childId', metered((req) => {
    const parent = campaignOf(req)
    const child = owned('campaigns', req.params.childId, req.wsId, CAMPAIGN)
    if (child.parent_campaign_id !== parent.id) throw notFound('subsequence')
    db.prepare("UPDATE campaigns SET parent_campaign_id = NULL, updated_at = datetime('now') WHERE id = ?").run(child.id)
    audit(req, { campaignId: parent.id, type: 'subsequence_unlinked', detail: `child #${child.id}` })
    return { ok: true }
  }))

  // ------------------------------------------------------- archive / delete --
  // routes.js already owns `DELETE /api/campaigns/:id` (a soft archive) and
  // `PUT /api/campaigns/:id`. PATCH is free, and the hard delete gets an
  // explicit path so it cannot be reached by accident.
  api.patch('/campaigns/:id', metered((req) => {
    const c = campaignOf(req)
    const status = oneOf(req.body, 'status', ['archived', 'draft'], { required: true })
    if (isStopped(c)) throw new HttpError(409, { error: 'campaign_stopped', message: 'A stopped campaign cannot be restored. Duplicate it instead.' })
    db.prepare("UPDATE campaigns SET status = ?, deleted_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, status === 'archived' ? nowIso() : '', c.id)
    audit(req, { campaignId: c.id, type: status === 'archived' ? 'campaign_archived' : 'campaign_restored', detail: c.name })
    return { ok: true, status }
  }))

  api.delete('/campaigns/:id/permanent', metered((req) => {
    const c = campaignOf(req)
    if (c.status === 'running') {
      throw new HttpError(409, { error: 'CAMPAIGN_ACTIVE', message: 'Pause or stop this campaign before deleting it.' })
    }
    const counts = {
      leads: db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(c.id).n,
      messages: db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id = ?').get(c.id).n,
      drafts: db.prepare('SELECT COUNT(*) n FROM drafts WHERE campaign_id = ?').get(c.id).n,
    }
    // The trail outlives the campaign, so it is written before the row goes.
    audit(req, {
      campaignId: c.id, type: 'campaign_deleted',
      detail: `"${c.name}" destroyed ${counts.leads} links, ${counts.messages} messages, ${counts.drafts} drafts`,
    })
    tx(() => {
      db.prepare('DELETE FROM messages WHERE campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM drafts WHERE campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM campaign_mailboxes WHERE campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM node_examples WHERE campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM webhooks WHERE campaign_id = ?').run(c.id)
      db.prepare('UPDATE campaigns SET parent_campaign_id = NULL WHERE parent_campaign_id = ?').run(c.id)
      db.prepare('DELETE FROM campaigns WHERE id = ? AND user_id = ?').run(c.id, req.wsId)
    })
    return { ok: true, deleted: counts }
  }))

  // ----------------------------------------------------------- mailboxes ----
  api.post('/campaigns/:id/mailboxes', metered((req) => {
    const c = campaignOf(req)
    const ids = idList(req.body, 'mailboxIds', { required: true, max: 100 })
    const rows = ownedAll('mailboxes', ids, req.wsId, 'mailbox')
    // Whole list checked before anything is written: a bad id attaches nothing.
    for (const mb of rows) {
      if (mb.status !== 'connected') throw invalid('mailboxIds', `Mailbox ${mb.email} is ${mb.status} — reconnect it first`)
      if (mb.is_suspended) throw invalid('mailboxIds', `Mailbox ${mb.email} is suspended`)
    }
    const attached = tx(() => {
      let n = 0
      for (const mb of rows) {
        n += db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(c.id, mb.id).changes
      }
      // The legacy single mailbox stays the primary so the engine keeps working.
      if (!c.mailbox_id) db.prepare("UPDATE campaigns SET mailbox_id = ?, updated_at = datetime('now') WHERE id = ?").run(rows[0].id, c.id)
      return n
    })
    audit(req, { campaignId: c.id, type: 'campaign_mailboxes_added', detail: `${attached} attached by ${req.user.email}` })
    return { ok: true, attached, mailboxIds: rows.map((m) => m.id) }
  }))

  api.get('/campaigns/:id/mailboxes', metered((req) => {
    const c = campaignOf(req)
    const rows = db.prepare(
      `SELECT m.* FROM campaign_mailboxes cm JOIN mailboxes m ON m.id = cm.mailbox_id
       WHERE cm.campaign_id = ? ORDER BY cm.id`
    ).all(c.id)
    const today = todayStr()
    return {
      mailboxes: rows.map((m) => {
        const usedToday = m.sent_today_date === today ? m.sent_today : 0
        const usingCount = db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE mailbox_id = ?').get(m.id).n
        return {
          id: m.id,
          email: m.email,
          fromName: m.display_name || '',
          provider: m.provider,
          // Read from the stored token state, never by calling Google per request.
          connection: m.status,
          suspended: Boolean(m.is_suspended),
          warmingUp: isWarmingUp(m),
          warmupEnabled: Boolean(m.warmup_enabled),
          dailyLimit: m.daily_limit,
          rampedCap: dailyCap(m),
          usedToday,
          remainingToday: remainingToday(m),
          campaignsUsing: usingCount,
          lastError: m.last_error || '',
          isPrimary: m.id === c.mailbox_id,
        }
      }),
      primaryMailboxId: c.mailbox_id || null,
    }
  }))

  const detachMailboxes = metered((req) => {
    const c = campaignOf(req)
    const ids = req.params.mailboxId
      ? [int(req.params, 'mailboxId', { required: true, min: 1 })]
      : idList(req.body, 'mailbox_ids', { required: true, max: 100 })
    ownedAll('mailboxes', ids, req.wsId, 'mailbox')
    const pool = db.prepare('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?').all(c.id).map((r) => r.mailbox_id)
    const remaining = pool.filter((id) => !ids.includes(id))
    if (c.status === 'running' && pool.length && remaining.length === 0) {
      throw new HttpError(409, {
        error: 'last_mailbox',
        message: 'This would leave a running campaign with no way to send. Pause it first, or attach a replacement.',
      })
    }
    const removed = tx(() => {
      let n = 0
      for (const id of ids) {
        n += db.prepare('DELETE FROM campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?').run(c.id, id).changes
        // A pin to a mailbox that has left the pool is cleared, and recorded.
        db.prepare('UPDATE campaign_leads SET mailbox_id = NULL WHERE campaign_id = ? AND mailbox_id = ?').run(c.id, id)
      }
      if (ids.includes(c.mailbox_id)) {
        db.prepare("UPDATE campaigns SET mailbox_id = ?, updated_at = datetime('now') WHERE id = ?").run(remaining[0] ?? null, c.id)
      }
      return n
    })
    audit(req, { campaignId: c.id, type: 'campaign_mailboxes_removed', detail: `${removed} detached by ${req.user.email}` })
    return { ok: true, removed, remaining }
  })
  api.delete('/campaigns/:id/mailboxes', detachMailboxes)
  api.delete('/campaigns/:id/mailboxes/:mailboxId', detachMailboxes)

  // ------------------------------------------------------------- add-leads ---
  // `POST /api/campaigns/:id/leads` belongs to routes.js; the parity import —
  // upsert, suppression, per-reason skips — lives one segment deeper.
  api.post('/campaigns/:id/leads/import', handler((req) => {
    const t0 = Date.now()
    const c = campaignOf(req)
    const rows = req.body?.leads
    if (!Array.isArray(rows)) throw invalid('leads', 'leads must be an array')
    if (rows.length === 0) throw invalid('leads', 'leads must contain at least one lead')
    if (rows.length > 400) {
      throw new HttpError(422, {
        error: 'validation_failed', field: 'leads',
        message: 'At most 400 leads per request',
        provided_count: rows.length, max_allowed: 400,
      })
    }
    const allowElsewhere = bool(req.body?.settings || {}, 'allowLeadsInOtherCampaigns', false)

    // Validate the whole batch first: one bad row means nothing is written.
    const parsed = rows.map((row, i) => {
      const address = emailAt(row?.email, `leads[${i}].email`)
      const custom = row.custom_fields === undefined ? {} : row.custom_fields
      if (custom === null || typeof custom !== 'object' || Array.isArray(custom)) {
        throw invalid(`leads[${i}].custom_fields`, 'custom_fields must be an object')
      }
      if (Object.keys(custom).length > 200) throw invalid(`leads[${i}].custom_fields`, 'At most 200 custom fields per lead')
      // The spec's field names are the source API's (`company_name`,
      // `phone_number`, `linkedin_profile`, `company_url`); Harry's columns are
      // `company`, `phone`, `linkedin`, `website`. Both spellings are accepted —
      // Harry's own name wins when both arrive — so a client written against the
      // documentation and the existing importer both work.
      const either = (a, b, max) => str(row, a, { max }) || str(row, b, { max })
      return {
        email: address,
        first_name: str(row, 'first_name', { max: 120 }),
        last_name: str(row, 'last_name', { max: 120 }),
        company: either('company', 'company_name', 200),
        title: str(row, 'title', { max: 200 }),
        phone: either('phone', 'phone_number', 60),
        website: either('website', 'company_url', 300),
        linkedin: either('linkedin', 'linkedin_profile', 300),
        location: str(row, 'location', { max: 200 }),
        custom_fields: JSON.stringify(custom),
      }
    })

    // Was a Set of raw values with no domain walking at all, so a blocked
    // domain did not stop a subdomain address on import. server/suppression.js
    // is the rule now.
    const blocked = { has: (addr) => Boolean(blockMatch(req.wsId, String(addr || '').toLowerCase())) }
    const result = tx(() => {
      const skipped = []
      const added = []
      // Counted, not skipped. The spec says a lead whose address already exists
      // "counts toward skipped_count as a duplicate", but Harry does add the
      // campaign link in that case, and calling real work a skip would make
      // added + skipped stop describing what happened. The reuse is reported on
      // its own field instead, so the importer can still say "5 duplicates".
      let reusedExisting = 0
      for (const row of parsed) {
        const domain = row.email.split('@')[1] || ''
        // Suppression is unconditional: no import setting can override it.
        if (blocked.has(row.email) || blocked.has(domain)) { skipped.push({ email: row.email, reason: 'blocked' }); continue }
        let lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND LOWER(email) = ?').get(req.wsId, row.email)
        if (lead && lead.status === 'unsubscribed') { skipped.push({ email: row.email, reason: 'unsubscribed' }); continue }
        if (lead && lead.status === 'bounced') { skipped.push({ email: row.email, reason: 'bounced' }); continue }
        if (lead) {
          reusedExisting += 1
          db.prepare(
            `UPDATE leads SET first_name = ?, last_name = ?, company = ?, title = ?, phone = ?,
               website = ?, linkedin = ?, location = ?, custom_fields = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(row.first_name || lead.first_name, row.last_name || lead.last_name, row.company || lead.company,
            row.title || lead.title, row.phone || lead.phone, row.website || lead.website,
            row.linkedin || lead.linkedin, row.location || lead.location, row.custom_fields, lead.id)
        } else {
          const info = db.prepare(
            `INSERT INTO leads (user_id, email, first_name, last_name, company, title, phone, website, linkedin, location, custom_fields)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(req.wsId, row.email, row.first_name, row.last_name, row.company, row.title,
            row.phone, row.website, row.linkedin, row.location, row.custom_fields)
          lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid)
        }
        if (!allowElsewhere) {
          const elsewhere = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE lead_id = ? AND campaign_id != ?').get(lead.id, c.id).n
          if (elsewhere) { skipped.push({ email: row.email, reason: 'in_another_campaign' }); continue }
        }
        const link = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(c.id, lead.id)
        if (link.changes) added.push(lead.id)
        else skipped.push({ email: row.email, reason: 'already_in_campaign' })
      }
      return { added, skipped, reusedExisting }
    })

    const byReason = {}
    for (const s of result.skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1
    // One events row for the whole import, not one per lead.
    audit(req, {
      campaignId: c.id, type: 'campaign_leads_imported',
      detail: `${result.added.length} added, ${result.skipped.length} skipped (${Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'})`,
    })
    meter('campaigns.leads-import', Date.now() - t0, true,
      `batch=${parsed.length} added=${result.added.length} skipped=${result.skipped.length}`)
    return {
      ok: true,
      addedCount: result.added.length,
      skippedCount: result.skipped.length,
      skippedByReason: byReason,
      skipped: result.skipped,
      leadIds: result.added,
      // Existing people the import matched instead of duplicating.
      reusedExistingCount: result.reusedExisting,
      // The documented spellings, alongside Harry's camelCase ones, so a client
      // written against add-leads.md reads the same numbers the UI does.
      added_count: result.added.length,
      skipped_count: result.skipped.length,
      lead_ids: result.added,
    }
  }))

  // ---------------------------------------------------------- delete-lead ----
  // routes.js owns the single-lead DELETE; this is the bulk variant, which
  // reports per-id outcomes so one bad id does not fail the batch.
  api.post('/campaigns/:id/leads/remove', metered((req) => {
    const c = campaignOf(req)
    const ids = idList(req.body, 'leadIds', { required: true, max: 500 })
    const result = tx(() => {
      const outcomes = []
      for (const id of ids) {
        const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(c.id, id)
        if (!cl) { outcomes.push({ leadId: id, removed: false, reason: 'not_in_campaign' }); continue }
        // The pending draft dies with the link, in the same transaction, so a
        // tick can never find work for a lead that has just been removed.
        const drafts = db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','approved')")
          .run(req.user.email, c.id, id).changes
        db.prepare('DELETE FROM campaign_leads WHERE id = ?').run(cl.id)
        outcomes.push({ leadId: id, removed: true, node: cl.node_id || '', draftsCancelled: drafts })
      }
      return outcomes
    })
    const removed = result.filter((r) => r.removed).length
    audit(req, { campaignId: c.id, type: 'campaign_leads_removed', detail: `${removed} of ${ids.length} by ${req.user.email}` })
    return { ok: true, removed, results: result }
  }))

  // ------------------------------------------------------------ export-leads --
  // Registered before `/leads/:leadId` so "export" is never read as an id.
  api.get('/campaigns/:id/leads/export', handler((req, res) => {
    const t0 = Date.now()
    const c = campaignOf(req)
    const filters = leadFilters(req)
    const stages = leadStages(req.wsId)

    const header = ['lead_id', 'email', 'first_name', 'last_name', 'company', 'title', 'stage', 'state', 'node', 'intent', 'outcome', 'paused_at', 'completed_at', 'last_activity']
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${c.id}-leads.csv"`)
    // UTF-8 BOM so spreadsheets read non-ASCII names correctly.
    res.write(`﻿${header.join(',')}\r\n`)

    // Streamed in blocks rather than joined into one string: the export used to
    // ask for 50,000 rows and buffer the entire file before the first byte left,
    // which is both the memory ceiling and the reason a large export felt hung.
    const CHUNK = 500
    let block = []
    let count = 0
    for (const raw of campaignLeadCursor(c, filters, stages)) {
      const r = campaignLeadRow(raw, stages)
      block.push([
        r.leadId, r.email, r.firstName, r.lastName, r.company, r.title,
        r.stage, r.state, r.node, r.intent, r.outcome, r.pausedAt, r.completedAt, r.lastActivity,
      ].map(csvCell).join(','))
      count += 1
      if (block.length >= CHUNK) { res.write(`${block.join('\r\n')}\r\n`); block = [] }
    }
    if (block.length) res.write(`${block.join('\r\n')}\r\n`)

    // Personal data leaving the system is an event, with its row count.
    audit(req, {
      campaignId: c.id, type: 'campaign_leads_exported',
      detail: `${count} rows by ${req.user.email} (${JSON.stringify(filters)})`,
    })
    meter('campaigns.leads-export', Date.now() - t0, true, `rows=${count}`)
    res.end()
  }))

  // ------------------------------------------------------------- get-leads ---
  api.get('/campaigns/:id/leads', handler((req) => {
    const t0 = Date.now()
    const c = campaignOf(req)
    const filters = leadFilters(req)
    const limit = int(req.query, 'limit', { min: 1, max: 100, fallback: 100 })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })
    const stages = leadStages(req.wsId)
    const { rows, total } = campaignLeadRows(c, filters, stages, { limit, offset })
    // §5 asks for the filter combination as well as the duration, "which also
    // shows which filters people actually use".
    const used = Object.entries(filters).filter(([, v]) => v).map(([k]) => k)
    meter('campaigns.leads', Date.now() - t0, true, `filters=${used.join('+') || 'none'} rows=${total}`)
    return { leads: rows, total, limit, offset }
  }))

  // --------------------------------------------------------- get-lead-by-id --
  // Campaign-scoped on purpose: `GET /api/leads/:id` belongs to the leads
  // category, and this view is the lead *inside this campaign*.
  api.get('/campaigns/:id/leads/:leadId', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    const stages = leadStages(req.wsId)
    const messages = db.prepare(
      `SELECT id, direction, subject, node_id, intent, opened_at, clicked_at, created_at
       FROM messages WHERE campaign_id = ? AND lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`
    ).all(c.id, lead.id)
    const positions = db.prepare(
      `SELECT cl.campaign_id, c.name, cl.node_id, cl.state FROM campaign_leads cl
       JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? AND c.user_id = ?`
    ).all(lead.id, req.wsId)
    return {
      lead: {
        id: lead.id, email: lead.email, firstName: lead.first_name, lastName: lead.last_name,
        company: lead.company, title: lead.title, phone: lead.phone || '', website: lead.website || '',
        linkedin: lead.linkedin || '', location: lead.location || '',
        customFields: jsonOf(lead.custom_fields),
        status: lead.status,
        unsubscribedAt: lead.unsubscribed_at || '',
        stage: stages[lead.id] || 'not contacted',
        // Provenance travels with research, and is never synthesised.
        research: lead.research ? { profile: lead.research, at: lead.researched_at || '' } : null,
      },
      position: {
        campaignId: c.id, node: cl.node_id || '', state: cl.state, intent: cl.intent || '',
        outcome: cl.outcome || '', pausedAt: cl.paused_at || '', resumeAt: cl.resume_at || '',
        completedAt: cl.completed_at || '', mailboxId: cl.mailbox_id || null,
        waitUntil: cl.wait_until || '',
      },
      positions: positions.map((p) => ({ campaignId: p.campaign_id, campaign: p.name, node: p.node_id, state: p.state })),
      messages: messages.reverse(),
    }
  }))

  // -------------------------------------------------------- get-lead-history --
  api.get('/campaigns/:id/leads/:leadId/messages', metered((req) => {
    const c = campaignOf(req)
    const { lead } = linkOf(c, req.params.leadId)
    const since = isoDate(req.query, 'since')
    const limit = int(req.query, 'limit', { min: 1, max: 200, fallback: 50 })
    const plainText = bool(req.query, 'plainText', false)
    const graph = graphOf(c)

    const args = [c.id, lead.id]
    let clause = ''
    if (since) { clause = 'AND created_at > ?'; args.push(sqlTime(since)) }
    const rows = db.prepare(
      `SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? ${clause}
       ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...args, limit)

    return {
      messages: rows.map((m) => {
        const base = {
          id: m.id, direction: m.direction, subject: m.subject,
          body: plainText ? String(m.body).replace(/<[^>]+>/g, '') : m.body,
          from: m.from_email, to: m.to_email, threadId: m.thread_id,
          nodeId: m.node_id || '', createdAt: m.created_at,
          isTest: m.send_status === 'test',
        }
        if (m.direction === 'in') {
          const edge = graph.edges.find((e) => e.cond.kind === 'reply' && e.cond.intent === m.intent)
          base.intent = m.intent || ''
          base.followedEdge = edge ? { from: edge.from, to: edge.to, label: edge.label } : null
        } else {
          // Absent, not zeroed: a client must not read "no tracking" as "nobody opened".
          if (c.track_opens) base.openedAt = m.opened_at || null
          if (c.track_clicks) base.clickedAt = m.clicked_at || null
        }
        return base
      }),
      tracking: { opens: Boolean(c.track_opens), clicks: Boolean(c.track_clicks) },
      count: rows.length,
    }
  }))

  // ------------------------------------------------- get-leads-history-bulk --
  // "Invisible — no UI" (Docs/README.md). The source API treats a null id list
  // as "every lead"; Harry refuses it, because that does not survive a campaign
  // with thousands of leads. The cap is 100, matching the leads page size.
  api.post('/campaigns/:id/messages/bulk', metered((req) => {
    const c = campaignOf(req)
    const raw = req.body?.leadIds
    if (raw === undefined || raw === null) {
      throw invalid('leadIds', 'leadIds is required — an unbounded request meaning "every lead" is not accepted')
    }
    const leadIds = idList(req.body, 'leadIds', { required: true, max: 100 })
    const since = isoDate(req.query, 'since') || isoDate(req.body, 'since')
    const summaryOnly = bool(req.body, 'summaryOnly', false)

    const linked = new Set(
      db.prepare(
        `SELECT cl.lead_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
         WHERE cl.campaign_id = ? AND l.user_id = ?`
      ).all(c.id, req.wsId).map((r) => r.lead_id)
    )
    const known = leadIds.filter((id) => linked.has(id))
    const unavailable = leadIds.filter((id) => !linked.has(id))

    const data = Object.fromEntries(known.map((id) => [id, []]))
    if (known.length) {
      const placeholders = known.map(() => '?').join(',')
      const args = [c.id, ...known]
      let clause = ''
      if (since) { clause = 'AND created_at > ?'; args.push(sqlTime(since)) }
      // One indexed query for the whole batch; the grouping is done here.
      const rows = db.prepare(
        `SELECT id, lead_id, direction, subject, body, intent, node_id, created_at
         FROM messages WHERE campaign_id = ? AND lead_id IN (${placeholders}) ${clause}
         ORDER BY created_at ASC, id ASC`
      ).all(...args)
      for (const m of rows) {
        data[m.lead_id].push(summaryOnly
          ? { id: m.id, direction: m.direction, subject: m.subject, intent: m.intent || '', createdAt: m.created_at }
          : { id: m.id, direction: m.direction, subject: m.subject, body: m.body, intent: m.intent || '', nodeId: m.node_id || '', createdAt: m.created_at })
      }
    }
    return { data, unavailable, requested: leadIds.length, max: 100 }
  }))

  // ------------------------------------------------------------ update-lead --
  api.post('/campaigns/:id/leads/:leadId', metered((req) => {
    const c = campaignOf(req)
    const { lead } = linkOf(c, req.params.leadId)
    const body = req.body || {}
    const patch = {}
    for (const field of ['first_name', 'last_name', 'company', 'title', 'phone', 'website', 'linkedin', 'location']) {
      if (body[field] !== undefined) patch[field] = str(body, field, { max: 300 })
    }
    if (body.email !== undefined) {
      const address = emailField(body, 'email', { required: true })
      const clash = db.prepare('SELECT id FROM leads WHERE user_id = ? AND LOWER(email) = ? AND id != ?').get(req.wsId, address, lead.id)
      if (clash) {
        // A conflict with a merge affordance, not a bare 409.
        throw new HttpError(409, {
          error: 'email_taken',
          message: 'Another lead in this workspace already has that address',
          mergeWithLeadId: clash.id,
        })
      }
      patch.email = address
    }
    if (body.custom_fields !== undefined) {
      const custom = body.custom_fields
      if (custom === null || typeof custom !== 'object' || Array.isArray(custom)) throw invalid('custom_fields', 'custom_fields must be an object')
      const keys = Object.keys(custom)
      if (keys.length > 200) throw invalid('custom_fields', 'At most 200 custom fields per lead')
      for (const key of keys) {
        if (!/^[A-Za-z0-9_ -]{1,64}$/.test(key)) throw invalid('custom_fields', `"${key}" is not a valid custom field name`)
      }
      patch.custom_fields = JSON.stringify(custom)
    }
    if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to update')

    tx(() => {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .run(...Object.values(patch), lead.id, req.wsId)
      // A draft written against the old details is stale. There is no `stale`
      // status on drafts, so it is withdrawn and the reason recorded — better a
      // recomposed email than one addressed to a name that changed.
      db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE lead_id = ? AND status = 'pending'")
        .run('system: lead details changed', lead.id)
    })
    // Field names, not values: phone and email do not belong in the trail.
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_updated', detail: `fields: ${Object.keys(patch).join(', ')}` })
    return { ok: true, leadId: lead.id, changed: Object.keys(patch) }
  }))

  // ------------------------------------------------------------ pause-lead ---
  api.post('/campaigns/:id/leads/:leadId/pause', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    const reason = str(req.body, 'reason', { max: 300 })
    if (cl.paused_at) return { ok: true, alreadyPaused: true, pausedAt: cl.paused_at }
    db.prepare("UPDATE campaign_leads SET paused_at = ?, paused_by = ?, resume_at = '', updated_at = datetime('now') WHERE id = ?")
      .run(nowIso(), req.user.email, cl.id)
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_paused', detail: `${req.user.email}${reason ? `: ${reason}` : ''}` })
    return { ok: true, pausedAt: nowIso(), waitUntil: cl.wait_until || '' }
  }))

  // ----------------------------------------------------------- resume-lead ---
  api.post('/campaigns/:id/leads/:leadId/resume', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    if (lead.status === 'unsubscribed') {
      throw new HttpError(409, { error: 'lead_unsubscribed', message: 'This lead has unsubscribed and cannot be resumed' })
    }
    const delayDays = int(req.body, 'delay_days', { min: 0, max: 365, fallback: 0 })
    if (!cl.paused_at && !cl.resume_at) return { ok: true, alreadyActive: true, will_resume_at: null }

    const now = Date.now()
    if (delayDays > 0) {
      const resumeAt = new Date(now + delayDays * 86400e3).toISOString()
      db.prepare("UPDATE campaign_leads SET resume_at = ?, updated_at = datetime('now') WHERE id = ?").run(resumeAt, cl.id)
      audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_resume_scheduled', detail: `${req.user.email} -> ${resumeAt}` })
      return { ok: true, will_resume_at: resumeAt }
    }
    // The frozen `no reply Xd` timer resumes with its remainder rather than
    // restarting or firing: the wait is pushed forward by the paused duration.
    let waitUntil = cl.wait_until || ''
    if (waitUntil && cl.paused_at) {
      const pausedAt = Date.parse(cl.paused_at)
      const target = Date.parse(waitUntil)
      if (Number.isFinite(pausedAt) && Number.isFinite(target) && target > pausedAt) {
        waitUntil = new Date(now + (target - pausedAt)).toISOString()
      }
    }
    db.prepare("UPDATE campaign_leads SET paused_at = '', paused_by = '', resume_at = '', wait_until = ?, updated_at = datetime('now') WHERE id = ?")
      .run(waitUntil, cl.id)
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_resumed', detail: req.user.email })
    return { ok: true, will_resume_at: new Date(now).toISOString(), waitUntil }
  }))

  // ----------------------------------------------------- mark-lead-complete --
  api.post('/campaigns/:id/leads/:leadId/complete', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    if (cl.completed_at) return { ok: true, alreadyComplete: true, completedAt: cl.completed_at }
    const at = nowIso()
    tx(() => {
      db.prepare(
        `UPDATE campaign_leads SET completed_at = ?, state = 'finished', outcome = ?, wait_until = '',
           updated_at = datetime('now') WHERE id = ?`
      ).run(at, cl.outcome || 'completed', cl.id)
      db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','approved')")
        .run(req.user.email, c.id, lead.id)
    })
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_completed', detail: `manual by ${req.user.email}` })
    return { ok: true, completedAt: at }
  }))

  // ------------------------------------------------------ unsubscribe-lead ---
  // Workspace-level, not per-campaign: there is one code path deciding who may
  // be emailed, and this is it.
  api.post('/campaigns/:id/leads/:leadId/unsubscribe', metered((req) => {
    const c = campaignOf(req)
    const { lead } = linkOf(c, req.params.leadId)
    if (lead.status === 'unsubscribed') {
      return { ok: true, alreadyUnsubscribed: true, unsubscribedAt: lead.unsubscribed_at || '' }
    }
    const at = nowIso()
    const affected = tx(() => {
      db.prepare("UPDATE leads SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribed_source = 'manual', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(at, lead.id, req.wsId)
      const links = db.prepare(
        `SELECT cl.id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
         WHERE cl.lead_id = ? AND c.user_id = ?`
      ).all(lead.id, req.wsId)
      for (const link of links) {
        db.prepare(
          `UPDATE campaign_leads SET state = 'stopped', outcome = 'unsubscribed', unsubscribed_at = ?,
             unsubscribed_by = ?, unsubscribed_source = 'manual', wait_until = '', updated_at = datetime('now') WHERE id = ?`
        ).run(at, req.user.email, link.id)
      }
      // Every queued draft, in every campaign — not just this one.
      const drafts = db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE lead_id = ? AND status IN ('pending','approved')")
        .run(req.user.email, lead.id).changes
      return { campaigns: links.length, drafts }
    })
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_unsubscribed', detail: `manual by ${req.user.email}` })
    return { ok: true, unsubscribedAt: at, ...affected }
  }))

  // ---------------------------------------------------- update-lead-category --
  api.post('/campaigns/:id/leads/:leadId/intent', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    const intent = str(req.body, 'intent', { required: true, max: 80 }).toLowerCase()
    const alsoPause = bool(req.body, 'pause', false)
    const graph = graphOf(c)
    const vocabulary = new Set([
      ...CORE_INTENTS,
      ...graph.edges.filter((e) => e.cond.kind === 'reply' && e.cond.intent).map((e) => e.cond.intent),
    ])
    if (!vocabulary.has(intent)) {
      throw invalid('intent', `intent must be one of: ${[...vocabulary].sort().join(', ')}`)
    }
    // Unsubscribe short-circuits, with or without a matching edge.
    if (intent === 'unsubscribe') {
      const at = nowIso()
      tx(() => {
        db.prepare("UPDATE leads SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribed_source = 'manual' WHERE id = ?").run(at, lead.id)
        db.prepare("UPDATE campaign_leads SET intent = 'unsubscribe', intent_set_by = ?, intent_set_at = ?, state = 'stopped', outcome = 'unsubscribed', updated_at = datetime('now') WHERE id = ?")
          .run(req.user.email, at, cl.id)
      })
      audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_intent', detail: `${cl.intent || 'none'} -> unsubscribe (${req.user.email})` })
      return { ok: true, intent, unsubscribed: true }
    }

    const edge = graph.edges.find((e) => e.from === cl.node_id && e.cond.kind === 'reply' && (e.cond.intent === intent || e.cond.intent === null))
    const at = nowIso()
    tx(() => {
      db.prepare(
        `UPDATE campaign_leads SET intent = ?, intent_set_by = ?, intent_set_at = ?, state = ?,
           updated_at = datetime('now') WHERE id = ?`
      ).run(intent, req.user.email, at, edge ? 'waiting' : 'needs_attention', cl.id)
      if (alsoPause && !cl.paused_at) {
        db.prepare('UPDATE campaign_leads SET paused_at = ?, paused_by = ? WHERE id = ?').run(at, req.user.email, cl.id)
      }
    })
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_intent', detail: `${cl.intent || 'none'} -> ${intent} (${req.user.email})${alsoPause ? ', paused' : ''}` })
    return { ok: true, intent, humanSet: true, paused: alsoPause, routedTo: edge ? edge.to : null, needsAttention: !edge }
  }))

  // ----------------------------------------------- update-lead-email-account --
  // The flat upstream form (ids in the body) is deliberately not offered: the
  // ids belong in the path.
  api.post('/campaigns/:id/leads/:leadId/mailbox', metered((req) => {
    const c = campaignOf(req)
    const { lead, cl } = linkOf(c, req.params.leadId)
    if (req.body?.mailbox_id === null) {
      db.prepare("UPDATE campaign_leads SET mailbox_id = NULL, updated_at = datetime('now') WHERE id = ?").run(cl.id)
      audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_mailbox', detail: `pin cleared by ${req.user.email}` })
      return { ok: true, mailboxId: null }
    }
    const mailboxId = int(req.body, 'mailbox_id', { required: true, min: 1 })
    const override = bool(req.body, 'override', false)
    const mailbox = owned('mailboxes', mailboxId, req.wsId, 'mailbox')
    const inPool = db.prepare('SELECT 1 FROM campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?').get(c.id, mailbox.id)
    if (!inPool && !override) {
      throw invalid('mailbox_id', `${mailbox.email} is not in this campaign's pool — attach it, or resend with override: true`)
    }
    db.prepare("UPDATE campaign_leads SET mailbox_id = ?, updated_at = datetime('now') WHERE id = ?").run(mailbox.id, cl.id)
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'lead_mailbox', detail: `pinned to ${mailbox.email} by ${req.user.email}` })
    return { ok: true, mailboxId: mailbox.id, override: Boolean(override && !inPool) }
  }))

  // ------------------------------------------------------------ get-analytics
  // One route for all-time and windowed figures — the same arithmetic either
  // way, which is the only way the two can be guaranteed to agree.
  //
  // SmartLead documents this same path twice — campaigns/get-analytics.md and
  // campaign-statistics/top-level.md. server/parity/analytics.js owns the
  // documented path; this one keeps the variant that reads the playbook graph,
  // under a name that says so, rather than sitting behind it as dead code.
  api.get('/campaigns/:id/playbook-analytics', metered((req) => {
    const c = campaignOf(req)
    const window = analyticsWindow(req)
    const totals = campaignTotals(c.id, window)
    const computedAt = nowIso()
    return {
      campaignId: c.id,
      window: window ? { from: window.fromIso, to: window.toIso } : { from: null, to: null, allTime: true },
      totals,
      // Read from server/metrics.js, not recomputed here. This block used to
      // divide replying leads by emails sent while Reports divided them by
      // leads contacted, and the two screens showed 13.3% and 40.0% for the
      // same campaign. The tracked/untracked note stays, because "0% opens"
      // and "we did not measure opens" are different statements.
      // `value: null` where tracking is off is deliberate and distinct from
      // `value: 0`. "Nobody opened it" and "we did not measure opens" are
      // different facts, and showing the second as 0% is how a campaign gets
      // judged for a number it was never allowed to collect.
      rates: {
        open: untracked(totals.rates.open_rate, c.track_opens, 'Open tracking is off for this campaign'),
        click: untracked(totals.rates.click_rate, c.track_clicks, 'Click tracking is off for this campaign'),
        reply: totals.rates.reply_rate,
        bounce: totals.rates.bounce_rate,
        unsubscribe: totals.rates.unsubscribe_rate,
      },
      noActivity: totals.sent === 0 && totals.replied === 0,
      smallSample: totals.sent > 0 && totals.sent < 30,
      computedAt,
    }
  }))

  // ------------------------------------------------ get-top-level-analytics --
  // The headline four, as percentages, zeros never nulls.
  api.get('/campaigns/:id/top-level-analytics', metered((req) => {
    const c = campaignOf(req)
    const window = analyticsWindow(req)
    const t = campaignTotals(c.id, window)
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
    return {
      campaign_id: c.id,
      from: window ? window.fromIso : null,
      to: window ? window.toIso : null,
      total_sent: t.sent,
      total_delivered: t.delivered,
      // From server/metrics.js, like every other rate. These two were
      // recomputed here with swapped denominators, so this route and
      // /playbook-analytics reported 33.3%/50% and 50%/33.3% for the same
      // campaign at the same instant — six lines below a comment saying that
      // exact bug had been fixed.
      open_rate: t.rates.open_rate.value,
      reply_rate: t.rates.reply_rate.value,
    }
  }))

  // ------------------------------------------------------------- statistics --
  // Documented twice in the source, like the analytics route above:
  // campaigns/statistics.md and campaign-statistics/get-by-id.md name the same
  // path. analytics.js owns `/campaigns/:id/statistics` and answers the
  // per-playbook-node question; this route is the per-email log that
  // campaigns/statistics.md §2 actually describes — one row per message, with
  // the lead, the step it came from and what happened to it.
  //
  // PARAMETER NAMES. The spec names `email_sequence_number`,
  // `sent_time_start_date`, `sent_time_end_date` and `email_status`. Harry
  // shipped `step` (a playbook node id), `from`, `to` and `status` first and the
  // campaign detail screen is already calling it with those. Both spellings are
  // accepted rather than either being broken: the documented name wins when both
  // arrive, and Harry's names stay as aliases so nothing already calling this
  // route breaks. The row fields follow the same rule — the documented
  // `lead_name` / `sequence_number` / `is_*` fields sit alongside the camelCase
  // ones StepsPanel already reads.
  api.get('/campaigns/:id/step-statistics', handler((req) => {
    const t0 = Date.now()
    const c = campaignOf(req)
    const graph = graphOf(c)
    const { seqOf, nodeOfSeq } = sendSequence(graph)

    const limit = int(req.query, 'limit', { min: 1, max: 1000, fallback: 100 })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })

    // Harry's alias: a node id, which must exist in this campaign's playbook.
    const step = str(req.query, 'step', { max: 64 })
    if (step && !graph.nodes[step]) throw invalid('step', `step "${step}" is not a node in this campaign's playbook`)
    // The documented parameter: a 1-based position among the Send steps. The
    // 1-20 bound is the API's, so int()'s "must be at most 20" is replaced by a
    // message that states the whole range, as TC-4 requires.
    const seqRaw = req.query?.email_sequence_number
    let wantSeq = 0
    if (seqRaw !== undefined && seqRaw !== '') {
      const n = Number(seqRaw)
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw invalid('email_sequence_number', 'email_sequence_number must be a whole number from 1 to 20')
      }
      wantSeq = n
    }
    const stepNode = wantSeq ? nodeOfSeq.get(wantSeq) || null : step || null
    // A sequence number inside 1-20 that this playbook has no Send step for is
    // an empty page, not a 422: the bound belongs to the API, not the campaign.
    const noSuchStep = Boolean(wantSeq) && !stepNode

    const EMAIL_STATUSES = ['opened', 'clicked', 'replied', 'unsubscribed', 'bounced']
    const emailStatus = str(req.query, 'email_status', { max: 20 }).toLowerCase()
    if (emailStatus && !EMAIL_STATUSES.includes(emailStatus)) {
      throw invalid('email_status', `email_status must be one of: ${EMAIL_STATUSES.join(', ')}`)
    }
    const status = str(req.query, 'status', { max: 20 })
    const STATUSES = ['sent', 'opened', 'clicked', 'replied', 'bounced']
    if (status && !STATUSES.includes(status)) throw invalid('status', `status must be one of: ${STATUSES.join(', ')}`)
    const wantStatus = emailStatus || status

    // Documented window names first, Harry's `from`/`to` as the fallback. Each
    // parser names the field the caller actually sent in its 422.
    const window = analyticsWindow(req, { fromField: 'sent_time_start_date', toField: 'sent_time_end_date' })
      || analyticsWindow(req)

    // One definition per outcome, used by both the filter and the row flag, so
    // TC-9's "every returned row has is_bounced: true" holds by construction
    // rather than by two expressions happening to agree.
    const OPENED = "COALESCE(m.opened_at,'') != ''"
    const CLICKED = "COALESCE(m.clicked_at,'') != ''"
    const BOUNCED = "(COALESCE(m.send_status,'') = 'bounced' OR l.status = 'bounced')"
    // A reply answers a thread, not one message, so `is_replied` is a fact about
    // the lead in this campaign rather than about this particular send.
    const REPLIED = "EXISTS (SELECT 1 FROM messages r WHERE r.campaign_id = m.campaign_id AND r.lead_id = m.lead_id AND r.direction = 'in')"
    const UNSUBSCRIBED = "(COALESCE(cl.unsubscribed_at,'') != '' OR l.status = 'unsubscribed')"

    const where = ['m.campaign_id = ?', "m.direction = 'out'", REAL_SEND]
    const args = [c.id]
    if (noSuchStep) where.push('1 = 0')
    else if (stepNode) { where.push('m.node_id = ?'); args.push(stepNode) }
    if (window) { where.push('m.created_at >= ?', 'm.created_at <= ?'); args.push(window.from, window.to) }
    if (wantStatus === 'opened') where.push(OPENED)
    if (wantStatus === 'clicked') where.push(CLICKED)
    if (wantStatus === 'bounced') where.push(BOUNCED)
    if (wantStatus === 'replied') where.push(REPLIED)
    if (wantStatus === 'unsubscribed') where.push(UNSUBSCRIBED)
    const clause = where.join(' AND ')
    const FROM = `FROM messages m JOIN leads l ON l.id = m.lead_id
       LEFT JOIN campaign_leads cl ON cl.campaign_id = m.campaign_id AND cl.lead_id = m.lead_id`

    // The rollup is computed from the *same* WHERE clause as the rows, which is
    // what makes the §5 DoD "rollup and rows are consistent for the same
    // filters" true rather than hopeful. The old code returned an all-time
    // campaignTotals() beside a filtered page.
    const roll = db.prepare(
      `SELECT COUNT(*) sent,
              COUNT(DISTINCT m.lead_id) contacted,
              SUM(CASE WHEN ${OPENED} THEN 1 ELSE 0 END) opened,
              SUM(CASE WHEN ${CLICKED} THEN 1 ELSE 0 END) clicked,
              SUM(CASE WHEN ${BOUNCED} THEN 1 ELSE 0 END) bounced,
              COUNT(DISTINCT CASE WHEN ${REPLIED} THEN m.lead_id END) repliedLeads,
              COUNT(DISTINCT CASE WHEN ${UNSUBSCRIBED} THEN m.lead_id END) unsubscribedLeads
       ${FROM} WHERE ${clause}`
    ).get(...args)

    // Deterministic sort, so paging is stable while the campaign is sending.
    const rows = db.prepare(
      `SELECT m.id, m.lead_id, l.email, l.first_name, l.last_name, m.subject, m.node_id,
              m.sequence_number, m.opened_at, m.clicked_at, m.created_at,
              (${BOUNCED}) bounced, (${REPLIED}) replied, (${UNSUBSCRIBED}) unsubscribed
       ${FROM} WHERE ${clause}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset)

    const totals = {
      sent: roll.sent || 0,
      contacted: roll.contacted || 0,
      opened: roll.opened || 0,
      clicked: roll.clicked || 0,
      bounced: roll.bounced || 0,
      repliedLeads: roll.repliedLeads || 0,
      unsubscribed: roll.unsubscribedLeads || 0,
      // Not asked for by this spec, but ratesFor() names its whole input.
      positiveRepliedLeads: 0, won: 0, bouncedLeads: 0,
    }
    const rates = ratesFor(totals)
    const totalLeads = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(c.id).n

    meter('campaigns.step-statistics', Date.now() - t0, true,
      `step=${stepNode || 'any'} status=${wantStatus || 'any'} window=${window ? 'yes' : 'no'} rows=${totals.sent}`)
    return {
      // The documented rollup, filtered to match the rows beside it.
      rollup: {
        total_leads: totalLeads,
        contacted: totals.contacted,
        sent: totals.sent,
        opened: totals.opened,
        clicked: totals.clicked,
        replied: totals.repliedLeads,
        bounced: totals.bounced,
        unsubscribed: totals.unsubscribed,
        open_rate: rates.open_rate.value,
        click_rate: rates.click_rate.value,
        reply_rate: rates.reply_rate.value,
        // Stated, not implied: this rollup counts exactly the rows below it.
        reflects_filters: true,
      },
      rows: rows.map((r) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
        return {
          // campaigns/statistics.md §2, second criterion.
          lead_name: name,
          lead_email: r.email,
          sequence_number: seqOf.get(r.node_id) || r.sequence_number || 0,
          sent_time: r.created_at,
          is_opened: c.track_opens ? Boolean(r.opened_at) : false,
          is_clicked: c.track_clicks ? Boolean(r.clicked_at) : false,
          is_replied: Boolean(r.replied),
          is_bounced: Boolean(r.bounced),
          is_unsubscribed: Boolean(r.unsubscribed),
          // Harry's existing names, still read by web/src/campaigns/StepsPanel.
          messageId: r.id, leadId: r.lead_id, email: r.email, subject: r.subject,
          step: r.node_id || '', sentAt: r.created_at,
          openedAt: c.track_opens ? r.opened_at || null : null,
          clickedAt: c.track_clicks ? r.clicked_at || null : null,
          bounced: Boolean(r.bounced),
        }
      }),
      total: totals.sent, limit, offset,
      filters: {
        step: stepNode || null,
        email_sequence_number: wantSeq || null,
        email_status: wantStatus || null,
        status: wantStatus || null,
        sent_time_start_date: window?.fromIso || null,
        sent_time_end_date: window?.toIso || null,
        from: window?.fromIso || null,
        to: window?.toIso || null,
      },
      // Zero opens and no open tracking are different statements; the table has
      // to be able to tell them apart before it says "nobody read it".
      tracking: { opens: Boolean(c.track_opens), clicks: Boolean(c.track_clicks) },
    }
  }))

  // ------------------------------------------------------------ send-test ----
  // A test send is a real send: it needs the same OK, counts against the
  // mailbox's quota, and is excluded from every count in Reports.
  api.post('/campaigns/:id/test-send', metered(async (req) => {
    const c = campaignOf(req)
    requireConfirmation(req.body, 'send this test email')
    throttleTestSend(req.user.email)

    const nodeId = str(req.body, 'node_id', { required: true, max: 64 })
    const toEmail = emailField(req.body, 'to_email', { required: true })
    const graph = graphOf(c)
    if (!graph.valid) throw invalid('node_id', graph.errors[0].message)
    if (!graph.nodes[nodeId] || graph.nodes[nodeId].type !== 'send') {
      throw invalid('node_id', `"${nodeId}" is not a Send step in this playbook`)
    }

    // A test must not become an unapproved approach to a real prospect.
    const realLead = db.prepare('SELECT id FROM leads WHERE user_id = ? AND LOWER(email) = ?').get(req.wsId, toEmail)
    if (realLead && !bool(req.body, 'confirm_real_lead', false)) {
      throw invalid('to_email', `${toEmail} belongs to a lead in this workspace. Resend with confirm_real_lead: true if you really mean to email them.`)
    }

    const mailboxId = int(req.body, 'mailbox_id', { min: 1, fallback: 0 })
    const mailbox = mailboxId
      ? owned('mailboxes', mailboxId, req.wsId, 'mailbox')
      : db.prepare(
        `SELECT m.* FROM campaign_mailboxes cm JOIN mailboxes m ON m.id = cm.mailbox_id
         WHERE cm.campaign_id = ? ORDER BY cm.id LIMIT 1`
      ).get(c.id) || (c.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(c.mailbox_id) : null)
    if (!mailbox) throw invalid('mailbox_id', 'Attach a mailbox to this campaign, or name one to send from')
    if (mailbox.status !== 'connected') throw invalid('mailbox_id', `Mailbox ${mailbox.email} is ${mailbox.status} — reconnect it first`)
    if (remainingToday(mailbox) <= 0) throw invalid('mailbox_id', `Daily limit reached for ${mailbox.email}`)

    const leadId = int(req.body, 'lead_id', { min: 1, fallback: 0 })
    const owner = ownerOf(req.wsId)
    const lead = leadId ? leadRow(leadId, req.wsId) : exampleLead(null)
    const composed = await composeStepSample({
      graph, nodeId, lead,
      businessContext: owner?.business_context || '',
      senderName: mailbox.display_name || owner?.name || '',
      meetingLink: owner?.meeting_link || '',
    })

    if (mailbox.provider === 'gmail') {
      await gmailSend(mailbox, { to: toEmail, subject: `[TEST] ${composed.subject}`, body: composed.body, workspaceId: req.wsId })
    }
    // Flagged as a test in the one column every aggregate here filters on.
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body,
         from_email, to_email, thread_id, node_id, is_read, send_status)
       VALUES (?, ?, NULL, ?, 'out', ?, ?, ?, ?, '', ?, 1, 'test')`
    ).run(req.wsId, c.id, mailbox.id, `[TEST] ${composed.subject}`, composed.body, mailbox.email, toEmail, `test:${nodeId}`)
    bumpQuota(mailbox)
    audit(req, { campaignId: c.id, type: 'campaign_test_send', detail: `${nodeId} -> ${toEmail} by ${req.user.email}` })
    return {
      ok: true, sentTo: toEmail, nodeId,
      mailbox: mailbox.email,
      subject: composed.subject, body: composed.body,
      excludedFromReports: true,
    }
  }))

  // ------------------------------------------------------- reply-email-thread
  api.post('/campaigns/:id/threads/:messageId/reply', metered(async (req) => {
    const c = campaignOf(req)
    requireConfirmation(req.body, 'send this reply')
    const original = owned('messages', req.params.messageId, req.wsId, 'message')
    if (original.campaign_id !== c.id) throw notFound('message')
    if (!original.lead_id) throw notFound('message')
    const lead = leadRow(original.lead_id, req.wsId)
    if (lead.status === 'unsubscribed') {
      throw new HttpError(409, { error: 'lead_unsubscribed', message: 'This lead has unsubscribed — nothing may be sent to them' })
    }
    const body = str(req.body, 'body', { required: true, max: 50000 })
    const scheduledTime = isoDate(req.body, 'scheduled_time')
    if (req.body?.cc !== undefined && !Array.isArray(req.body.cc)) throw invalid('cc', 'cc must be an array')
    if (req.body?.bcc !== undefined && !Array.isArray(req.body.bcc)) throw invalid('bcc', 'bcc must be an array')
    const cc = (req.body?.cc ?? []).map((a, i) => emailAt(a, `cc[${i}]`))
    const bcc = (req.body?.bcc ?? []).map((a, i) => emailAt(a, `bcc[${i}]`))
    if (req.body?.attachments !== undefined && !Array.isArray(req.body.attachments)) {
      throw invalid('attachments', 'attachments must be an array')
    }
    const mailbox = original.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(original.mailbox_id, req.wsId)
      : null
    if (!mailbox) throw invalid('messageId', 'That thread has no connected mailbox to reply from')
    if (mailbox.status !== 'connected') throw invalid('messageId', `Mailbox ${mailbox.email} is ${mailbox.status} — reconnect it first`)

    const subject = original.subject?.startsWith('Re:') ? original.subject : `Re: ${original.subject || ''}`.trim()
    if (scheduledTime) {
      // Scheduled: parked, not sent. Pacing decides when it actually goes.
      db.prepare(
        `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body,
           from_email, to_email, thread_id, node_id, is_read, manual_reply, scheduled_at, send_status)
         VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, 'manual', 1, 1, ?, 'scheduled')`
      ).run(req.wsId, c.id, lead.id, mailbox.id, subject, body, mailbox.email, lead.email,
        original.thread_id || '', scheduledTime)
      audit(req, { campaignId: c.id, leadId: lead.id, type: 'manual_reply_scheduled', detail: `${req.user.email} for ${scheduledTime}` })
      return { ok: true, scheduled: true, scheduledAt: scheduledTime, cc, bcc }
    }

    // Through the same mailer an agent send uses, so the opt-out line, the
    // List-Unsubscribe header, tracking and click wrapping are identical.
    const sent = await sendEmail({
      mailbox, user: { id: req.wsId }, campaign: c, lead,
      nodeId: 'manual', subject, body,
    })
    db.prepare("UPDATE messages SET manual_reply = 1 WHERE provider_message_id = ?").run(sent.providerMessageId)
    audit(req, { campaignId: c.id, leadId: lead.id, type: 'manual_reply', detail: `${req.user.email}${cc.length ? `, cc ${cc.length}` : ''}` })
    return { ok: true, sent: true, threadId: sent.threadId, cc, bcc }
  }))

  // ----------------------------------------------------------- forward-email --
  // The source page documents NO request fields at all: an empty `{}` sample
  // and its own warning to verify against the controller (Docs/README.md).
  // Rather than build against nothing, Harry defines its own explicit contract:
  //
  //     POST /api/campaigns/:id/messages/:messageId/forward
  //     { to: string[]  (1..10 addresses, required)
  //       note: string  (optional, prepended above the quoted original)
  //       confirm: true (required — nothing sends without the user's OK) }
  //
  // A forward is not marketing to its recipient, so it carries no tracking
  // pixel, no wrapped links, no opt-out footer and no List-Unsubscribe header,
  // and it never touches the lead's position in the playbook.
  api.post('/campaigns/:id/messages/:messageId/forward', metered(async (req) => {
    const c = campaignOf(req)
    requireConfirmation(req.body, 'forward this email')
    const original = owned('messages', req.params.messageId, req.wsId, 'message')
    if (original.campaign_id !== c.id) throw notFound('message')

    const raw = req.body?.to
    if (!Array.isArray(raw) || raw.length === 0) throw invalid('to', 'to must list at least one recipient')
    if (raw.length > 10) throw invalid('to', 'to may contain at most 10 recipients')
    const recipients = raw.map((address, i) => emailAt(address, `to[${i}]`))
    const lead = original.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(original.lead_id, req.wsId) : null
    // Forwarding to the lead is a reply, not a forward — refused server-side.
    if (lead && recipients.includes(String(lead.email).toLowerCase())) {
      throw invalid('to', 'That is the lead\'s own address — use reply, not forward')
    }
    const note = str(req.body, 'note', { max: 5000 })
    const mailbox = original.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(original.mailbox_id, req.wsId)
      : null
    if (!mailbox) throw invalid('messageId', 'That thread has no mailbox to forward from')
    if (mailbox.status !== 'connected') throw invalid('messageId', `Reconnect ${mailbox.email} before forwarding`)

    const subject = original.subject?.toLowerCase().startsWith('fwd:') ? original.subject : `Fwd: ${original.subject || ''}`.trim()
    const quoted = [
      note,
      note ? '' : null,
      '---------- Forwarded message ----------',
      `From: ${original.from_email}`,
      `Date: ${original.created_at}`,
      `Subject: ${original.subject || ''}`,
      `To: ${original.to_email}`,
      '',
      original.body || '',
    ].filter((line) => line !== null && line !== '').join('\n')

    if (mailbox.provider === 'gmail') {
      // No html, no listUnsubscribe: a forward carries neither.
      await gmailSend(mailbox, { to: recipients.join(', '), subject, body: quoted, workspaceId: req.wsId })
    }
    const at = nowIso()
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body,
         from_email, to_email, thread_id, node_id, is_read, forwarded_at, forwarded_to, send_status)
       VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, 'forward', 1, ?, ?, 'forwarded')`
    ).run(req.wsId, c.id, original.lead_id, mailbox.id, subject, quoted, mailbox.email,
      recipients.join(', '), original.thread_id || '', at, recipients.join(', '))
    // A forward is a real send and costs the mailbox's allowance like any other.
    bumpQuota(mailbox)
    audit(req, {
      campaignId: c.id, leadId: original.lead_id, type: 'message_forwarded',
      detail: `#${original.id} to ${recipients.join(', ')} by ${req.user.email}`,
    })
    return {
      success: true, forwardedTo: recipients, forwardedAt: at,
      quotaUsed: 1, remainingToday: remainingToday(db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailbox.id)),
      playbookUnchanged: true,
    }
  }))
}

// ---------------------------------------------------------------- shared -----

// One filter parser, shared by the campaign leads list and the CSV export, so
// the file and the screen can never disagree about what was asked for.
function leadFilters(req) {
  const stage = str(req.query, 'stage', { max: 40 })
  const engagement = str(req.query, 'engagement', { max: 40 })
  const ENGAGEMENTS = ['opened', 'clicked', 'replied', 'none', 'paused', 'completed', 'unsubscribed']
  if (engagement && !ENGAGEMENTS.includes(engagement)) {
    throw invalid('engagement', `engagement must be one of: ${ENGAGEMENTS.join(', ')}`)
  }
  return {
    stage,
    engagement,
    q: str(req.query, 'q', { max: 200 }),
    createdAfter: isoDate(req.query, 'createdAfter'),
    lastSentAfter: isoDate(req.query, 'lastSentAfter'),
    eventAfter: isoDate(req.query, 'eventAfter'),
  }
}

// One statement, built once, used by both the paged list and the CSV export.
//
// This used to load every `campaign_leads` row for the campaign, run an
// aggregate subquery *per lead*, and then filter and slice the result in
// JavaScript. Page one of a 50,000-lead campaign issued ~50,001 queries and
// read the whole audience into memory to return a hundred rows, and `total` was
// the length of a JS array rather than a count the database had agreed to.
// Everything below — the engagement filters, the date bounds, the count and the
// slice — is now in SQL, and the count rides on the same statement as the page
// (`COUNT(*) OVER ()`) so the pager and the rows can never disagree.
//
// `withTotal: false` drops the window function for the export, which streams and
// has no pager to feed.
function campaignLeadSql(campaign, filters, stages, { withTotal = true } = {}) {
  // The per-lead aggregate, grouped once for the whole campaign rather than
  // recomputed per row. NOT_TEST rather than REAL_SEND deliberately: this is the
  // audience view, and a forward to a colleague is still activity on the thread.
  const joinArgs = [campaign.id]
  const activity = `LEFT JOIN (
      SELECT lead_id,
             MAX(created_at) AS last_activity,
             SUM(CASE WHEN COALESCE(opened_at,'') != '' THEN 1 ELSE 0 END) AS opens,
             SUM(CASE WHEN COALESCE(clicked_at,'') != '' THEN 1 ELSE 0 END) AS clicks,
             SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS replies,
             MAX(CASE WHEN direction = 'out' THEN created_at ELSE '' END) AS last_sent
        FROM messages WHERE campaign_id = ? AND ${NOT_TEST} GROUP BY lead_id
    ) a ON a.lead_id = cl.lead_id`

  const where = ['cl.campaign_id = ?']
  const args = [campaign.id]
  if (filters.q) {
    where.push('(LOWER(l.email) LIKE ? OR LOWER(l.first_name) LIKE ? OR LOWER(l.last_name) LIKE ? OR LOWER(l.company) LIKE ?)')
    const like = `%${filters.q.toLowerCase()}%`
    args.push(like, like, like, like)
  }
  if (filters.createdAfter) { where.push('l.created_at >= ?'); args.push(sqlTime(filters.createdAfter)) }
  if (filters.engagement === 'paused') where.push("COALESCE(cl.paused_at,'') != ''")
  if (filters.engagement === 'completed') where.push("COALESCE(cl.completed_at,'') != ''")
  if (filters.engagement === 'unsubscribed') where.push("COALESCE(cl.unsubscribed_at,'') != ''")
  if (filters.engagement === 'opened') where.push('COALESCE(a.opens, 0) > 0')
  if (filters.engagement === 'clicked') where.push('COALESCE(a.clicks, 0) > 0')
  if (filters.engagement === 'replied') where.push('COALESCE(a.replies, 0) > 0')
  if (filters.engagement === 'none') {
    where.push('COALESCE(a.opens, 0) = 0 AND COALESCE(a.clicks, 0) = 0 AND COALESCE(a.replies, 0) = 0')
  }
  // Inclusive boundaries, as the spec's date-filter criterion requires.
  if (filters.lastSentAfter) {
    where.push("COALESCE(a.last_sent,'') != '' AND a.last_sent >= ?")
    args.push(sqlTime(filters.lastSentAfter))
  }
  if (filters.eventAfter) {
    where.push("COALESCE(a.last_activity,'') != '' AND a.last_activity >= ?")
    args.push(sqlTime(filters.eventAfter))
  }
  // `stage` is derived across the whole workspace by server/stages.js from
  // messages, consents and outcomes — a fixed handful of queries, not one per
  // lead — so it is not a column this statement can test. The matching ids go
  // in as a single JSON parameter instead, which keeps the query count constant
  // however large the campaign is.
  if (filters.stage) {
    const ids = []
    for (const [leadId, stage] of Object.entries(stages)) {
      if (stage === filters.stage) ids.push(Number(leadId))
    }
    where.push('cl.lead_id IN (SELECT value FROM json_each(?))')
    args.push(JSON.stringify(ids))
  }

  const total = withTotal ? ', COUNT(*) OVER () AS total_count' : ''
  const sql = `SELECT cl.lead_id, cl.state, cl.node_id, cl.intent, cl.outcome, cl.paused_at,
            cl.resume_at, cl.completed_at, cl.unsubscribed_at, cl.mailbox_id, cl.updated_at,
            l.email, l.first_name, l.last_name, l.company, l.title, l.status AS leadStatus,
            COALESCE(a.opens, 0) AS opens, COALESCE(a.clicks, 0) AS clicks,
            COALESCE(a.replies, 0) AS replies,
            COALESCE(a.last_sent, '') AS last_sent,
            COALESCE(a.last_activity, '') AS last_activity${total}
     FROM campaign_leads cl
     JOIN leads l ON l.id = cl.lead_id
     ${activity}
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(NULLIF(a.last_activity, ''), cl.updated_at) DESC, cl.lead_id ASC`
  return { sql, args: [...joinArgs, ...args] }
}

// The row shape both callers hand back. Stage is the only field that is not a
// column, and it is a map lookup rather than a query.
function campaignLeadRow(r, stages) {
  return {
    leadId: r.lead_id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    company: r.company,
    title: r.title,
    stage: stages[r.lead_id] || 'not contacted',
    state: r.state,
    node: r.node_id || '',
    intent: r.intent || '',
    outcome: r.outcome || '',
    pausedAt: r.paused_at || '',
    resumeAt: r.resume_at || '',
    completedAt: r.completed_at || '',
    unsubscribedAt: r.unsubscribed_at || '',
    mailboxId: r.mailbox_id || null,
    opens: r.opens || 0,
    clicks: r.clicks || 0,
    replies: r.replies || 0,
    lastSent: r.last_sent || '',
    lastActivity: r.last_activity || '',
  }
}

function campaignLeadRows(campaign, filters, stages, { limit, offset }) {
  const { sql, args } = campaignLeadSql(campaign, filters, stages)
  const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...args, limit, offset)
  // With no rows there is no window-function value to read, and the count of an
  // empty filtered set is zero either way.
  const total = rows.length ? rows[0].total_count : 0
  return { rows: rows.map((r) => campaignLeadRow(r, stages)), total }
}

// The export walks the same statement with better-sqlite3's row iterator, so a
// 50,000-row CSV is never a 50,000-row array in memory first.
function campaignLeadCursor(campaign, filters, stages) {
  const { sql, args } = campaignLeadSql(campaign, filters, stages, { withTotal: false })
  return db.prepare(sql).iterate(...args)
}

// Strict ISO 8601 both ends, inversion rejected naming the field, and a ceiling
// on the range so a client cannot ask for the whole history by accident.
//
// `fromField`/`toField` let the statistics route accept the documented
// `sent_time_start_date` / `sent_time_end_date` pair while sharing one parser,
// so the 422 names the parameter the caller actually sent.
function analyticsWindow(req, { fromField = 'from', toField = 'to' } = {}) {
  const from = isoDate(req.query, fromField)
  const to = isoDate(req.query, toField)
  if (!from && !to) return null
  if (!from || !to) throw invalid(from ? toField : fromField, `${fromField} and ${toField} must be given together`)
  if (from > to) throw invalid(toField, `${toField} must be on or after ${fromField}`)
  const days = (Date.parse(to) - Date.parse(from)) / 86400e3
  if (days > 366) throw invalid('to', 'The window may span at most 366 days')
  return { from: sqlTime(from), to: sqlTime(to), fromIso: from, toIso: to }
}
