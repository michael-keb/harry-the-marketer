// The prospect record and its lifecycle — Docs/leads/*.
//
// Eleven endpoints in the backlog, five of which SmartLead expresses as
// campaign-scoped routes (`add-to-campaign`, `pause`, `resume`, `delete`,
// `get-by-campaign`). Those live in server/parity/campaigns.js, which owns
// everything under `/api/campaigns/`. This module owns the lead-first half: the
// person, their enrolments, their activity trail, their export, the reply
// vocabulary, and the one act that is genuinely global rather than per-campaign
// — unsubscribing.
//
// Three constraints shape every handler here:
//
//   * Suppression is unconditional (Docs/README, "Deliberate divergences").
//     An unsubscribed lead is excluded from every send and there is no bypass
//     flag on any route in this file. The suppression is written to
//     `blocked_domains` keyed on the lowercased address as well as to the lead
//     row, so it survives the person record being deleted and a later re-import
//     cannot resurrect them.
//   * The stage is never stored. `leadStages` in server/stages.js derives it
//     from messages, outcomes and signed agreements; the export column and the
//     lead detail both call it rather than carrying a copy.
//   * A 404 for another workspace's lead says "No such lead" and nothing else.
//     Several specs assert the response does not contain the person's name or
//     address, so every lookup goes through `owned()`.

import { db } from '../db.js'
import { blockMatch } from '../suppression.js'
import { leadStages, STAGES } from '../stages.js'
import { discardStaleDraft } from '../drafts.js'
import { CORE_INTENTS } from '../ai.js'
import { parsePlaybook } from '../playbook.js'
// The step-numbering walk and the test-send exclusion are imported, never
// re-derived: "step 2" and "what counts as a send" have to mean the same thing
// in this export as they do in the campaign one, or the two files disagree
// about the same lead.
import { sendSequence, NOT_TEST } from './campaigns.js'
import {
  HttpError, invalid, forbidden, handler,
  str, int, oneOf, email as emailField, isoDate, page, paged,
  owned, tx, audit, meter,
} from './http.js'

// ---- constants ---------------------------------------------------------------

const LEAD_STATUSES = ['active', 'unsubscribed', 'bounced']
const STAGE_KEYS = STAGES.map((s) => s.key)

// Where an unsubscribe came from. `recipient` is the one-click link and the
// List-Unsubscribe header (server/tracking.js); the rest are human or machine
// acts inside Harry. There is deliberately no "ignore suppression" source.
const UNSUBSCRIBE_SOURCES = ['manual', 'recipient', 'api', 'import', 'bounce']

// States a campaign_leads row can be in while it is still able to receive an
// email. Finishing exactly these is what makes a global unsubscribe global.
const OPEN_STATES = ['queued', 'active', 'waiting', 'needs_attention']

// The reply vocabulary every new workspace starts with. Derived from the
// classifier's own list rather than retyped, so a change in server/ai.js cannot
// leave the triage buckets describing intents the engine never produces.
// `other` is excluded: the classifier means "none of these fit, a human should
// look", which is the absence of a category rather than one of them.
const BUILTIN_CATEGORIES = CORE_INTENTS.filter((intent) => intent !== 'other')

// Docs/leads/categories asks for a `sentiment` column so Reports never matches
// on names. `lead_categories` (server/parity/schema.js) has no such column and
// the schema is not ours to change, so sentiment is derived from a fixed map on
// the built-in name and returned on every row. Callers still read sentiment
// from this endpoint rather than hardcoding names; a workspace-created category
// is neutral until the schema can carry the real thing.
const SENTIMENT = {
  interested: 'positive',
  'not interested': 'negative',
  unsubscribe: 'negative',
  'not now': 'neutral',
  question: 'neutral',
  'out of office': 'neutral',
}

const MAX_CATEGORY_NAME = 60
const MAX_CUSTOM_FIELDS = 200      // the documented cap on the custom-field bag
const MAX_CUSTOM_VALUE = 2000
const EXPORT_BATCH = 500           // rows read (and written) per pass

// ---- shaping -----------------------------------------------------------------

function parseObject(raw) {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function shapeLead(row, extra = {}) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    company: row.company || '',
    title: row.title || '',
    notes: row.notes || '',
    phone: row.phone || '',
    website: row.website || '',
    linkedin: row.linkedin || '',
    location: row.location || '',
    status: row.status,
    customFields: parseObject(row.custom_fields),
    emailSource: row.email_source || '',
    emailVerificationStatus: row.email_verification_status || '',
    unsubscribedAt: row.unsubscribed_at || '',
    unsubscribedSource: row.unsubscribed_source || '',
    researchedAt: row.researched_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  }
}

// One statement returns the person and every enrolment, so the lead detail is a
// single round trip and there is no N+1 as the enrolment count grows. The join
// to campaigns is workspace-scoped on both sides.
const PERSON_SELECT = `
  SELECT l.*,
         cl.id AS e_id, cl.campaign_id AS e_campaign_id, cl.state AS e_state,
         cl.node_id AS e_node_id, cl.intent AS e_intent, cl.outcome AS e_outcome,
         COALESCE(cl.paused_at, '') AS e_paused_at, cl.category_id AS e_category_id,
         COALESCE(cl.unsubscribed_at, '') AS e_unsubscribed_at,
         cl.updated_at AS e_updated_at,
         c.name AS e_campaign_name, c.status AS e_campaign_status,
         lc.name AS e_category_name
    FROM leads l
    LEFT JOIN campaign_leads cl ON cl.lead_id = l.id
    LEFT JOIN campaigns c ON c.id = cl.campaign_id AND c.user_id = l.user_id
    LEFT JOIN lead_categories lc ON lc.id = cl.category_id AND lc.workspace_id = l.user_id`

function foldPerson(rows) {
  if (!rows.length) return null
  const enrolments = []
  for (const row of rows) {
    // A campaign_leads row whose campaign is gone (or, defensively, belongs
    // elsewhere) is not an enrolment anyone can act on.
    if (!row.e_id || !row.e_campaign_name) continue
    enrolments.push({
      enrolmentId: row.e_id,
      campaignId: row.e_campaign_id,
      campaignName: row.e_campaign_name,
      campaignStatus: row.e_campaign_status,
      state: row.e_state,
      nodeId: row.e_node_id || '',
      intent: row.e_intent || '',
      outcome: row.e_outcome || '',
      categoryId: row.e_category_id || null,
      // Both specs ask the enrolment to carry "the label applied in that
      // campaign", not just its id — the lookup exists so a colleague can be
      // answered in one call, and a bare id means a second one.
      category: row.e_category_id
        ? { id: row.e_category_id, name: row.e_category_name || '', sentiment: SENTIMENT[String(row.e_category_name || '').toLowerCase()] || 'neutral' }
        : null,
      pausedAt: row.e_paused_at || '',
      unsubscribedAt: row.e_unsubscribed_at || '',
      updatedAt: row.e_updated_at,
    })
  }
  return { lead: rows[0], enrolments }
}

// ---- categories --------------------------------------------------------------

// Seeded on first read rather than at sign-up, so a workspace that predates the
// table gets its vocabulary the first time anything asks for it. INSERT OR
// IGNORE against UNIQUE (workspace_id, name) makes a second read a no-op, which
// is what stops the list doubling on every visit.
function ensureCategories(wsId) {
  const seeded = db.prepare('SELECT COUNT(*) n FROM lead_categories WHERE workspace_id = ?').get(wsId).n
  if (seeded) return
  const insert = db.prepare(
    'INSERT OR IGNORE INTO lead_categories (workspace_id, name, is_system, sort) VALUES (?, ?, 1, ?)'
  )
  tx(() => {
    BUILTIN_CATEGORIES.forEach((name, index) => insert.run(wsId, name, index))
  })
}

function shapeCategory(row, usage = 0) {
  return {
    id: row.id,
    name: row.name,
    sentiment: SENTIMENT[row.name.toLowerCase()] || 'neutral',
    isBuiltin: Boolean(row.is_system),
    sort: row.sort,
    createdAt: row.created_at,
    usageCount: usage,
  }
}

// Names are unique per workspace case- and whitespace-insensitively. The unique
// index is on the exact stored name, so the looser check runs here and inside
// the same transaction as the write.
function categoryClash(wsId, name, exceptId = 0) {
  return db.prepare(
    `SELECT id, name FROM lead_categories
      WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?)) AND id != ?`
  ).get(wsId, name, exceptId)
}

function duplicateCategory(existing) {
  return new HttpError(409, {
    error: 'duplicate_name',
    field: 'name',
    id: existing.id,
    message: `A lead category named "${existing.name}" already exists — rename that one instead`,
  })
}

// How many enrolments point at a category. Deletion is refused while this is
// non-zero and the count is returned, so the UI can offer a reassign rather
// than silently orphaning triage decisions.
function categoryUsage(wsId, categoryId) {
  return db.prepare(
    `SELECT COUNT(*) n FROM campaign_leads cl
       JOIN campaigns c ON c.id = cl.campaign_id
      WHERE c.user_id = ? AND cl.category_id = ?`
  ).get(wsId, categoryId).n
}

// ---- suppression -------------------------------------------------------------

// The workspace block list, keyed on the lowercased address. Written by the
// unsubscribe route and read by the importer and the lead-list routes
// (server/parity/lists.js has the matching reader), which is what makes the
// suppression outlive the person record.
function suppressionRow(wsId, address) {
  return db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?').get(wsId, address)
}

// True when an address is suppressed by an exact-address entry or by a blocked
// domain (including a subdomain of one). Used on an email change so a
// correction cannot walk a lead around their own opt-out.
function isSuppressed(wsId, address) {
  // One definition, in server/suppression.js. See the note on inbox.js's
  // isBlocked for why five near-identical copies was not a harmless duplication.
  return Boolean(blockMatch(wsId, String(address || '').toLowerCase()))
}

// Every pending email queued for this lead. `discardStaleDraft` is the codebase's
// one way to drop a queued email (server/drafts.js): it deletes the row and
// writes the `draft_stale` trail entry, so an approval after this point is
// impossible rather than merely discouraged.
function dropPendingDrafts(wsId, leadId, campaignId = null) {
  const rows = campaignId
    ? db.prepare(
      "SELECT * FROM drafts WHERE user_id = ? AND lead_id = ? AND campaign_id = ? AND status IN ('pending','approved')"
    ).all(wsId, leadId, campaignId)
    : db.prepare(
      "SELECT * FROM drafts WHERE user_id = ? AND lead_id = ? AND status IN ('pending','approved')"
    ).all(wsId, leadId)
  for (const draft of rows) discardStaleDraft(draft)
  return rows.length
}

// ---- CSV ---------------------------------------------------------------------

// RFC 4180: quote only when the value needs it, double any embedded quote,
// CRLF between records.
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRow(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`
}

// `website` is the company URL: `company_url` and `website` are two documented
// spellings of one column (see `either('website', 'company_url', …)` in
// server/parity/campaigns.js), so this file carries it once under Harry's own
// name rather than twice under both.
//
// The last four are Docs/leads/export.md §2's engagement criterion. Appended
// rather than interleaved so every existing column keeps its position for a
// consumer that maps by index; the header still changed, and that is the
// breaking part.
const EXPORT_COLUMNS = [
  'id', 'email', 'firstName', 'lastName', 'company', 'title', 'phone', 'website',
  'linkedin', 'location', 'status', 'stage', 'campaigns', 'customFields',
  'unsubscribedAt', 'createdAt',
  'lastStepSent', 'openCount', 'clickCount', 'replyCount',
]

// Per-lead engagement for the workspace-wide export.
//
// The campaign export can read one campaign's aggregate; this one cannot, because
// a person may sit in five campaigns and the file has one row for them. So the
// counts are every real send and every reply across the workspace, and the last
// step sent is the position of the node the most recent outbound email came
// from, numbered inside whichever campaign that email belonged to.
//
// One query per page of leads rather than one per lead, so the export stays a
// stream. `graphs` is a cache across pages: a workspace has tens of campaigns
// and tens of thousands of leads, and parsing the same diagram once per lead is
// the difference between an export and a hang.
function engagementFor(wsId, leadIds, graphs) {
  const ids = JSON.stringify(leadIds)
  const counts = db.prepare(
    `SELECT lead_id,
            SUM(CASE WHEN COALESCE(opened_at,'') != '' THEN 1 ELSE 0 END) AS opens,
            SUM(CASE WHEN COALESCE(clicked_at,'') != '' THEN 1 ELSE 0 END) AS clicks,
            SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS replies
       FROM messages
      WHERE user_id = ? AND ${NOT_TEST} AND lead_id IN (SELECT value FROM json_each(?))
      GROUP BY lead_id`
  ).all(wsId, ids)

  const lastSent = db.prepare(
    `SELECT lead_id, campaign_id, node_id FROM messages
      WHERE user_id = ? AND direction = 'out' AND ${NOT_TEST}
        AND lead_id IN (SELECT value FROM json_each(?))
        AND id IN (SELECT MAX(id) FROM messages
                    WHERE user_id = ? AND direction = 'out' AND ${NOT_TEST}
                      AND lead_id IN (SELECT value FROM json_each(?))
                    GROUP BY lead_id)`
  ).all(wsId, ids, wsId, ids)

  const seqOfCampaign = (campaignId) => {
    if (!campaignId) return null
    if (!graphs.has(campaignId)) {
      const c = db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaignId)
      graphs.set(campaignId, sendSequence(parsePlaybook(c?.mermaid || '')).seqOf)
    }
    return graphs.get(campaignId)
  }

  const out = new Map()
  for (const row of counts) {
    out.set(row.lead_id, { opens: row.opens || 0, clicks: row.clicks || 0, replies: row.replies || 0, step: '' })
  }
  for (const row of lastSent) {
    const entry = out.get(row.lead_id) || { opens: 0, clicks: 0, replies: 0, step: '' }
    // Same rule as the campaign export: a number while the node is still a Send
    // step in that campaign's diagram, otherwise the node id, which is at least
    // true about where the email came from.
    const seq = seqOfCampaign(row.campaign_id)
    entry.step = row.node_id ? (seq?.get(row.node_id) ?? row.node_id) : ''
    out.set(row.lead_id, entry)
  }
  return out
}

const NO_ENGAGEMENT = { opens: 0, clicks: 0, replies: 0, step: '' }

// ---- activities --------------------------------------------------------------

// The activity trail is the `events` table: one row per thing that happened to
// a lead, written by the engine, the mailer, the approval queue and every
// parity module through `audit()`. Reading it is not an act, so there is no
// events row of its own — only telemetry, so Monitoring can see the feed
// slowing down as volume grows.
function activityQuery(req, leadId = null) {
  const { limit, offset } = page(req.query, { defaultLimit: 100, maxLimit: 1000 })
  const from = isoDate(req.query, 'from')
  const to = isoDate(req.query, 'to')
  // `from` alone is a half-open window and perfectly meaningful; `to` alone is
  // "everything since the beginning", which is never what a filter means.
  if (to && !from) throw invalid('from', 'from is required when to is given')
  if (from && to && from > to) throw invalid('to', 'to must be on or after from')

  const where = ['e.user_id = ?', 'e.lead_id IS NOT NULL']
  const args = [req.wsId]
  if (leadId) { where.push('e.lead_id = ?'); args.push(leadId) }
  // events.created_at is SQLite's `datetime('now')` ("YYYY-MM-DD HH:MM:SS");
  // the filters arrive as ISO 8601. datetime() normalises both.
  if (from) { where.push("datetime(e.created_at) >= datetime(?)"); args.push(from) }
  if (to) { where.push("datetime(e.created_at) <= datetime(?)"); args.push(to) }

  // One query per page regardless of how many leads or campaigns it touches.
  const rows = db.prepare(
    `SELECT e.id, e.type, e.detail, e.created_at, e.lead_id, e.campaign_id,
            l.email AS lead_email, l.first_name, l.last_name, l.company,
            c.name AS campaign_name, c.status AS campaign_status
       FROM events e
       JOIN leads l ON l.id = e.lead_id AND l.user_id = e.user_id
       LEFT JOIN campaigns c ON c.id = e.campaign_id AND c.user_id = e.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT ? OFFSET ?`
  ).all(...args, limit + 1, offset)

  const out = paged(rows, limit)
  return {
    limit,
    offset,
    from,
    to,
    items: out.items.map((row) => ({
      id: row.id,
      type: row.type,
      detail: row.detail || '',
      at: row.created_at,
      leadId: row.lead_id,
      leadEmail: row.lead_email,
      leadName: [row.first_name, row.last_name].filter(Boolean).join(' '),
      company: row.company || '',
      campaignId: row.campaign_id || null,
      campaignName: row.campaign_name || '',
      campaignStatus: row.campaign_status || '',
    })),
    hasMore: out.hasMore,
  }
}

// ---- routes ------------------------------------------------------------------

export function register(api) {
  // ---- GET /api/lead-categories -------------------------------------------
  // The reply vocabulary. Seeded per workspace on first read; a second read
  // returns the same ids and adds nothing.
  api.get('/lead-categories', handler((req) => {
    const started = Date.now()
    ensureCategories(req.wsId)
    // The list is a handful of rows, but it is still paged: the house rule is
    // that no list route can be made unbounded by adding rows to a table.
    const { limit, cursor } = page(req.query, { defaultLimit: 200, maxLimit: 500 })
    // Docs/leads/categories.md TC-7. Sentiment is derived from the name rather
    // than stored (see SENTIMENT above), so the filter is applied after shaping
    // — filtering in SQL would mean a second copy of the mapping in a WHERE.
    const sentiment = oneOf(req.query, 'sentiment', ['positive', 'negative', 'neutral'], { fallback: '' })
    const rows = db.prepare(
      `SELECT * FROM lead_categories WHERE workspace_id = ? AND id > ? ORDER BY sort, id LIMIT ?`
    ).all(req.wsId, cursor, limit + 1)
    const out = paged(sentiment
      ? rows.filter((row) => (SENTIMENT[row.name.toLowerCase()] || 'neutral') === sentiment)
      : rows, limit)
    const usage = new Map(
      db.prepare(
        `SELECT cl.category_id AS id, COUNT(*) n FROM campaign_leads cl
           JOIN campaigns c ON c.id = cl.campaign_id
          WHERE c.user_id = ? AND cl.category_id IS NOT NULL
          GROUP BY cl.category_id`
      ).all(req.wsId).map((r) => [r.id, r.n])
    )
    meter('leads.categories', Date.now() - started, true, `n=${out.items.length}`)
    return {
      ok: true,
      data: out.items.map((row) => shapeCategory(row, usage.get(row.id) || 0)),
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
    }
  }))

  // ---- POST /api/lead-categories ------------------------------------------
  api.post('/lead-categories', handler((req) => {
    ensureCategories(req.wsId)
    const name = str(req.body, 'name', { required: true, max: MAX_CATEGORY_NAME })
    const row = tx(() => {
      const clash = categoryClash(req.wsId, name)
      if (clash) throw duplicateCategory(clash)
      const next = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM lead_categories WHERE workspace_id = ?')
        .get(req.wsId).n
      const info = db.prepare(
        'INSERT INTO lead_categories (workspace_id, name, is_system, sort) VALUES (?, ?, 0, ?)'
      ).run(req.wsId, name, next)
      return db.prepare('SELECT * FROM lead_categories WHERE id = ?').get(info.lastInsertRowid)
    })
    // A category is workspace configuration, so create/rename/delete each earn
    // a trail entry — unlike reading the list, which does not.
    audit(req, { type: 'lead_category_created', detail: `${req.user.email} added the lead category "${name}"` })
    return { ok: true, data: shapeCategory(row) }
  }))

  // ---- PATCH /api/lead-categories/:id --------------------------------------
  // Rename only. A built-in carries the exact wording the classifier emits, so
  // renaming one would silently detach the vocabulary from the engine.
  api.patch('/lead-categories/:id', handler((req) => {
    const row = owned('lead_categories', req.params.id, req.wsId, 'lead category')
    if (row.is_system) throw forbidden(`"${row.name}" is a built-in category and cannot be renamed`)
    const name = str(req.body, 'name', { required: true, max: MAX_CATEGORY_NAME })
    const updated = tx(() => {
      const clash = categoryClash(req.wsId, name, row.id)
      if (clash) throw duplicateCategory(clash)
      db.prepare('UPDATE lead_categories SET name = ? WHERE id = ? AND workspace_id = ?')
        .run(name, row.id, req.wsId)
      return db.prepare('SELECT * FROM lead_categories WHERE id = ?').get(row.id)
    })
    audit(req, {
      type: 'lead_category_renamed',
      detail: `${req.user.email} renamed the lead category "${row.name}" to "${name}"`,
    })
    return { ok: true, data: shapeCategory(updated) }
  }))

  // ---- DELETE /api/lead-categories/:id -------------------------------------
  api.delete('/lead-categories/:id', handler((req) => {
    const row = owned('lead_categories', req.params.id, req.wsId, 'lead category')
    if (row.is_system) throw forbidden(`"${row.name}" is a built-in category and cannot be deleted`)
    const usage = categoryUsage(req.wsId, row.id)
    if (usage) {
      // The count comes back so the UI can say what a reassign would move.
      throw new HttpError(409, {
        error: 'category_in_use',
        field: 'id',
        message: `"${row.name}" is still applied to ${usage} lead(s) — reassign them first`,
        referenceCount: usage,
      })
    }
    tx(() => { db.prepare('DELETE FROM lead_categories WHERE id = ? AND workspace_id = ?').run(row.id, req.wsId) })
    audit(req, { type: 'lead_category_deleted', detail: `${req.user.email} deleted the lead category "${row.name}"` })
    return { ok: true, message: 'Lead category deleted' }
  }))

  // ---------------------------------------------------------------------------
  // Literal paths under /leads come first. Express matches in registration
  // order, so /leads/:id registered above would swallow every one of them.
  // ---------------------------------------------------------------------------

  // ---- GET /api/leads/activities -------------------------------------------
  // Workspace-wide activity feed: one timeline per lead, assembled in one
  // query per page rather than one per lead.
  api.get('/leads/activities', handler((req) => {
    const started = Date.now()
    const out = activityQuery(req)
    meter('leads.activities', Date.now() - started, true, `n=${out.items.length}`)
    return { ok: true, data: out.items, limit: out.limit, offset: out.offset, hasMore: out.hasMore }
  }))

  // ---- GET /api/leads/by-email?email= --------------------------------------
  // The backlog names this `GET /api/leads?email=`, but `GET /api/leads` is
  // already the Leads page's list handler in server/routes.js and this module
  // extends rather than shadows it. The lookup therefore lives on its own
  // literal path; the semantics are the source API's, including a miss being a
  // 200 with an empty result rather than a 404 — a normal typo in a search box
  // is not an error condition.
  api.get('/leads/by-email', handler((req) => {
    const started = Date.now()
    const address = emailField(req.query, 'email', { required: true })
    const rows = db.prepare(`${PERSON_SELECT}
      WHERE l.user_id = ? AND lower(trim(l.email)) = ? ORDER BY cl.id`).all(req.wsId, address)
    const found = foldPerson(rows)
    meter('leads.by_email', Date.now() - started, true, found ? 'hit' : 'miss')
    if (!found) return { ok: true, found: false, data: null, enrolments: [] }
    const stage = leadStages(req.wsId)[found.lead.id] || 'not contacted'
    return {
      ok: true,
      found: true,
      data: shapeLead(found.lead, { stage }),
      enrolments: found.enrolments,
    }
  }))

  // ---- GET /api/leads/export ------------------------------------------------
  // Streaming CSV. Rows are read a page at a time and written as they are read,
  // so memory is flat whether the workspace holds 20 leads or 20,000 — the
  // stream is the pagination.
  api.get('/leads/export', handler((req, res) => {
    const started = Date.now()
    const q = str(req.query, 'q', { max: 200 }).toLowerCase()
    const status = oneOf(req.query, 'status', LEAD_STATUSES, { fallback: '' })
    const stage = oneOf(req.query, 'stage', STAGE_KEYS, { fallback: '' })
    let campaign = null
    if (req.query.campaignId !== undefined && req.query.campaignId !== '') {
      const campaignId = int(req.query, 'campaignId', { required: true, min: 1 })
      campaign = owned('campaigns', campaignId, req.wsId, 'campaign')
    }

    const where = ['l.user_id = ?']
    const args = [req.wsId]
    if (status) { where.push('l.status = ?'); args.push(status) }
    if (q) {
      where.push(`lower(l.email || ' ' || COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')
                        || ' ' || COALESCE(l.company,'') || ' ' || COALESCE(l.title,'')) LIKE ?`)
      args.push(`%${q}%`)
    }
    if (campaign) {
      where.push('EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.campaign_id = ?)')
      args.push(campaign.id)
    }

    const select = db.prepare(
      `SELECT l.* FROM leads l WHERE ${where.join(' AND ')} AND l.id > ? ORDER BY l.id LIMIT ?`
    )
    // The derived stage comes from the shared function, never a second copy, so
    // the export and the Leads page can never disagree about where someone is.
    const stages = leadStages(req.wsId)

    const filename = `leads-${new Date().toISOString().slice(0, 10)}${campaign ? `-campaign-${campaign.id}` : ''}.csv`
    res.status(200)
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store, private',
    })
    // Byte order mark: without it Excel reads UTF-8 accented names as mojibake.
    res.write('\uFEFF')
    res.write(csvRow(EXPORT_COLUMNS))

    const campaignsFor = db.prepare(
      `SELECT cl.lead_id AS leadId, c.name AS name FROM campaign_leads cl
         JOIN campaigns c ON c.id = cl.campaign_id
        WHERE c.user_id = ? AND cl.lead_id IN (SELECT value FROM json_each(?))
        ORDER BY cl.id`
    )

    let cursor = 0
    let rows = 0
    const graphs = new Map()
    for (;;) {
      const batch = select.all(...args, cursor, EXPORT_BATCH)
      if (!batch.length) break
      cursor = batch[batch.length - 1].id
      // One extra query per batch, not one per lead.
      const ids = JSON.stringify(batch.map((l) => l.id))
      const names = new Map()
      for (const row of campaignsFor.all(req.wsId, ids)) {
        names.set(row.leadId, (names.get(row.leadId) || []).concat(row.name))
      }
      const engagement = engagementFor(req.wsId, batch.map((l) => l.id), graphs)
      for (const lead of batch) {
        const derived = stages[lead.id] || 'not contacted'
        if (stage && derived !== stage) continue
        const e = engagement.get(lead.id) || NO_ENGAGEMENT
        res.write(csvRow([
          lead.id, lead.email, lead.first_name, lead.last_name, lead.company, lead.title,
          lead.phone, lead.website, lead.linkedin, lead.location, lead.status, derived,
          (names.get(lead.id) || []).join('; '),
          JSON.stringify(parseObject(lead.custom_fields)),
          lead.unsubscribed_at || '', lead.created_at,
          e.step, e.opens, e.clicks, e.replies,
        ]))
        rows++
      }
      if (batch.length < EXPORT_BATCH) break
    }
    res.end()

    // Exporting personal data is an act worth recording, so it earns a trail
    // entry naming the actor — one row for the export, not one per lead.
    audit(req, {
      campaignId: campaign ? campaign.id : null,
      type: 'leads_exported',
      detail: `${req.user.email} exported ${rows} lead(s)${campaign ? ` from "${campaign.name}"` : ''}`,
    })
    meter('leads.export', Date.now() - started, true, `rows=${rows}`)
  }))

  // ---- GET /api/leads/:id ---------------------------------------------------
  // The person plus their enrolments, in one query. A cross-workspace id is
  // "No such lead" and carries nothing about them.
  api.get('/leads/:id', handler((req) => {
    const lead = owned('leads', req.params.id, req.wsId, 'lead')
    const rows = db.prepare(`${PERSON_SELECT}
      WHERE l.user_id = ? AND l.id = ? ORDER BY cl.id`).all(req.wsId, lead.id)
    const found = foldPerson(rows)
    const stage = leadStages(req.wsId)[lead.id] || 'not contacted'
    return { ok: true, data: shapeLead(found.lead, { stage }), enrolments: found.enrolments }
  }))

  // ---- GET /api/leads/:id/activities ---------------------------------------
  api.get('/leads/:id/activities', handler((req) => {
    const started = Date.now()
    const lead = owned('leads', req.params.id, req.wsId, 'lead')
    const out = activityQuery(req, lead.id)
    meter('leads.activities', Date.now() - started, true, `lead=${lead.id} n=${out.items.length}`)
    return {
      ok: true,
      leadId: lead.id,
      data: out.items,
      limit: out.limit,
      offset: out.offset,
      hasMore: out.hasMore,
    }
  }))

  // ---- PATCH /api/leads/:id -------------------------------------------------
  // The correction path. PUT /api/leads/:id already exists in server/routes.js
  // with whole-record semantics; this is the partial one, and it is the only
  // one that understands the extended fields and the custom-field bag.
  api.patch('/leads/:id', handler((req) => {
    const lead = owned('leads', req.params.id, req.wsId, 'lead')
    const body = req.body || {}
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key)

    // camelCase is Harry's shape; the snake_case aliases exist because the
    // source API and the import mapper both speak it.
    const TEXT_FIELDS = [
      ['firstName', 'first_name', 120],
      ['lastName', 'last_name', 120],
      ['company', 'company', 200],
      ['title', 'title', 200],
      ['notes', 'notes', 5000],
      ['phone', 'phone', 60],
      ['website', 'website', 500],
      ['linkedin', 'linkedin', 500],
      ['location', 'location', 200],
    ]

    const sets = []
    const args = []
    const changed = []

    for (const [camel, column, max] of TEXT_FIELDS) {
      const key = has(camel) ? camel : has(column) ? column : null
      if (!key) continue
      // An explicit empty string clears the field; an absent key leaves it.
      const value = str(body, key, { max })
      if (value === (lead[column] || '')) continue
      sets.push(`${column} = ?`)
      args.push(value)
      changed.push(camel)
    }

    // Email is the identity of the record, so a change revalidates both the
    // workspace uniqueness index and the suppression list.
    let newEmail = ''
    if (has('email')) {
      newEmail = emailField(body, 'email', { required: true })
      if (newEmail !== lead.email.toLowerCase()) {
        const clash = db.prepare(
          'SELECT id FROM leads WHERE user_id = ? AND lower(trim(email)) = ? AND id != ?'
        ).get(req.wsId, newEmail, lead.id)
        if (clash) {
          throw new HttpError(409, {
            error: 'duplicate_email',
            field: 'email',
            id: clash.id,
            message: `${newEmail} is already in your leads`,
          })
        }
        // Unconditional: there is no request flag that lets an edit move a
        // person onto a suppressed address.
        if (isSuppressed(req.wsId, newEmail)) {
          throw invalid('email', `${newEmail} is on this workspace's suppression list and cannot be used`)
        }
        sets.push('email = ?')
        args.push(newEmail)
        changed.push('email')
      } else {
        newEmail = ''
      }
    }

    // Custom fields merge into the stored bag rather than replacing it, so a
    // partial edit from one screen cannot drop keys another screen wrote.
    let mergedCustom = null
    if (has('customFields') || has('custom_fields')) {
      const key = has('customFields') ? 'customFields' : 'custom_fields'
      const raw = body[key]
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalid('customFields', 'customFields must be an object')
      }
      const merged = { ...parseObject(lead.custom_fields) }
      for (const [name, value] of Object.entries(raw)) {
        if (value === null) { delete merged[name]; continue }
        if (typeof value === 'object') {
          throw invalid('customFields', `customFields.${name} must be a string, number or boolean`)
        }
        const text = String(value)
        if (text.length > MAX_CUSTOM_VALUE) {
          throw invalid('customFields', `customFields.${name} must be ${MAX_CUSTOM_VALUE} characters or fewer`)
        }
        merged[name] = value
      }
      if (Object.keys(merged).length > MAX_CUSTOM_FIELDS) {
        throw invalid('customFields', `customFields may contain at most ${MAX_CUSTOM_FIELDS} keys`)
      }
      mergedCustom = merged
      sets.push('custom_fields = ?')
      args.push(JSON.stringify(merged))
      changed.push('customFields')
    }

    // "Nothing to change" and "nothing I could have changed" are different
    // answers. A body naming no updatable field at all is a malformed request
    // and 422s naming the body. A body that names real fields whose values are
    // already what was sent is a no-op: Docs/leads/update.md TC-6 asks for "200
    // with no change recorded and no activity trail entry", because the form
    // re-submits every field and a user who edits nothing has not erred.
    //
    // The distinction matters beyond the status code — a no-op must not reach
    // the write below, which drops the lead's pending drafts. Treating an
    // unchanged save as a change would discard a queued email for nothing.
    if (!sets.length) {
      const named = TEXT_FIELDS.some(([camel, column]) => has(camel) || has(column))
        || has('email') || has('customFields') || has('custom_fields')
      if (!named) throw invalid('fields', 'no updatable fields were supplied')
      return {
        ok: true,
        data: shapeLead(lead),
        changedFields: [],
        changed: false,
        draftsInvalidated: 0,
        researchRefreshQueued: false,
        customFields: parseObject(lead.custom_fields),
      }
    }

    // The research profile describes a company. If the company or its website
    // moved, the profile now describes someone else — clearing it is what the
    // engine reads as "research this again before the next email"
    // (server/engine.js gates on `!lead.research`).
    const profileStale = changed.includes('company') || changed.includes('website')
    if (profileStale) sets.push("research = ''", "researched_at = ''")

    const result = tx(() => {
      db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .run(...args, lead.id, req.wsId)
      // Same transaction: a queued email written against the old details is
      // dropped rather than sent describing a company that has changed.
      const dropped = dropPendingDrafts(req.wsId, lead.id)
      return {
        dropped,
        row: db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id),
      }
    })

    // Field NAMES only. The trail is meant to say what was corrected, not to
    // become a second copy of the personal data being corrected.
    audit(req, {
      leadId: lead.id,
      type: 'lead_updated',
      detail: `${req.user.email} updated ${changed.join(', ')}`,
    })
    // How often an edit invalidates a queued email is the signal that import
    // data quality is poor, which is why it is metered separately.
    meter('leads.update', 0, true, `fields=${changed.length} draftsDropped=${result.dropped}`)

    return {
      ok: true,
      data: shapeLead(result.row),
      changedFields: changed,
      changed: true,
      draftsInvalidated: result.dropped,
      researchRefreshQueued: profileStale,
      customFields: mergedCustom ?? parseObject(result.row.custom_fields),
    }
  }))

  // ---- POST /api/leads/:id/unsubscribe -------------------------------------
  // The GLOBAL unsubscribe: it suppresses the person everywhere, not in one
  // campaign. `POST /api/campaigns/:id/leads/:leadId/unsubscribe` is the
  // campaign-scoped act and lives in server/parity/campaigns.js; nothing there
  // can undo what this does. There is no bypass flag on this route or any
  // other, which is the "suppression is unconditional" divergence in
  // Docs/README made structural.
  //
  // The state written here is deliberately identical to what the one-click
  // link in server/tracking.js writes, plus the columns that route predates, so
  // a recipient-initiated and a human-initiated unsubscribe cannot diverge.
  api.post('/leads/:id/unsubscribe', handler((req) => {
    const lead = owned('leads', req.params.id, req.wsId, 'lead')
    const source = oneOf(req.body, 'source', UNSUBSCRIBE_SOURCES, { fallback: 'manual' })
    const reason = str(req.body, 'reason', { max: 500 })
    const address = String(lead.email || '').toLowerCase()

    const result = tx(() => {
      const alreadyOut = lead.status === 'unsubscribed' && Boolean(lead.unsubscribed_at)
      if (!alreadyOut) {
        db.prepare(
          `UPDATE leads
              SET status = 'unsubscribed',
                  unsubscribed_at = CASE WHEN COALESCE(unsubscribed_at,'') = '' THEN datetime('now') ELSE unsubscribed_at END,
                  unsubscribed_source = ?,
                  updated_at = datetime('now')
            WHERE id = ? AND user_id = ?`
        ).run(source, lead.id, req.wsId)
      }

      // Every open enrolment, in every campaign in this workspace, is finished
      // with the unsubscribed outcome — which is also what the derived stage
      // reads, so the Leads page agrees without being told.
      const open = db.prepare(
        `SELECT cl.id FROM campaign_leads cl
           JOIN campaigns c ON c.id = cl.campaign_id
          WHERE cl.lead_id = ? AND c.user_id = ?
            AND cl.state IN (${OPEN_STATES.map(() => '?').join(',')})`
      ).all(lead.id, req.wsId, ...OPEN_STATES)
      const finish = db.prepare(
        `UPDATE campaign_leads
            SET state = 'finished', outcome = 'unsubscribed',
                unsubscribed_at = datetime('now'), unsubscribed_by = ?, unsubscribed_source = ?,
                completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      )
      for (const row of open) finish.run(req.user.email, source, row.id)

      // The suppression is written to the workspace block list as well as to
      // the person, keyed on the lowercased address, so deleting the lead — or
      // re-importing them tomorrow — does not undo the opt-out.
      let suppressed = false
      if (!suppressionRow(req.wsId, address)) {
        db.prepare(
          `INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by)
           VALUES (?, ?, 0, 'unsubscribe', ?)`
        ).run(req.wsId, address, req.user.email)
        suppressed = true
      }

      const dropped = dropPendingDrafts(req.wsId, lead.id)
      return { leadChanged: !alreadyOut, finished: open.length, suppressed, dropped }
    })

    const changed = result.leadChanged || result.finished > 0 || result.suppressed || result.dropped > 0
    // Repeat calls report no change and leave no second trail entry.
    if (changed) {
      audit(req, {
        leadId: lead.id,
        type: 'lead_unsubscribed',
        detail: `${req.user.email} unsubscribed ${address} (source: ${source}${reason ? `, ${reason}` : ''}); `
          + `${result.finished} campaign(s) closed, ${result.dropped} queued email(s) dropped`,
      })
    }
    meter('leads.unsubscribe', 0, true, `changed=${changed} campaigns=${result.finished}`)

    return {
      ok: true,
      changed,
      message: changed ? 'Lead unsubscribed everywhere' : 'Lead was already unsubscribed',
      leadId: lead.id,
      status: 'unsubscribed',
      source,
      campaignsClosed: result.finished,
      draftsDropped: result.dropped,
      suppressionAdded: result.suppressed,
    }
  }))
}
