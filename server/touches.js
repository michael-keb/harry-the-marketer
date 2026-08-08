// The touch ledger: who this workspace has contacted, when, and by which
// channel — across every plan and every mailbox.
//
// `messages` cannot answer this. It is per-campaign, it is email only, and the
// question the frequency caps ask is deliberately wider than either: *has this
// person heard from us at all lately, whoever sent it and however it went?*
// Two plans that each politely wait three days between touches still land two
// emails on the same person on the same morning if neither knows about the
// other. That is the pattern a recipient reads as spam, and it is the one the
// product promises not to do — "every touch stands alone".

import { db } from './db.js'

// Capping "three people per week" at gmail.com would be nonsense: it is not a
// company, it is a country's worth of individuals. Free providers are counted
// per person and never per domain.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com',
])

export function companyKey(email) {
  const at = String(email || '').lastIndexOf('@')
  if (at < 0) return ''
  const domain = String(email).slice(at + 1).trim().toLowerCase()
  if (!domain || FREE_MAIL.has(domain)) return ''
  return domain
}

export function recordTouch({ wsId, leadId, email = '', channel = 'email', campaignId = null, at = Date.now() }) {
  // A send with no lead behind it is not a touch. Deliverability seed sends go
  // to inboxes the workspace owns in order to find out where mail lands; they
  // are not an approach to a person, and counting one against a frequency cap
  // would mean running a placement test could silence a campaign. The ledger
  // is keyed on lead_id precisely because its question is "has this *person*
  // heard from us" — a question a seed inbox is not an answer to.
  if (leadId === null || leadId === undefined) return
  db.prepare(
    `INSERT INTO touches (workspace_id, lead_id, company_domain, channel, campaign_id, sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, leadId, companyKey(email), channel, campaignId, at)
}

// The last time this person heard from us, by any channel, from any plan.
export function lastTouch(wsId, leadId) {
  return db.prepare(
    'SELECT * FROM touches WHERE workspace_id = ? AND lead_id = ? ORDER BY sent_at DESC LIMIT 1'
  ).get(wsId, leadId) || null
}

// How many *different people* at this company have been touched since `since`.
// People, not messages: a three-email sequence to one person at a firm is one
// relationship, while three first emails to three colleagues in a week is what
// gets a domain blocked by its own IT department.
export function companyTouchCount(wsId, domain, since) {
  if (!domain) return 0
  return db.prepare(
    `SELECT COUNT(DISTINCT lead_id) n FROM touches
     WHERE workspace_id = ? AND company_domain = ? AND sent_at >= ?`
  ).get(wsId, domain, since).n
}

// Anyone else at this company we have already reached in the window — named,
// so the reason can say who instead of just a number.
export function companyTouchedNames(wsId, domain, since, limit = 3) {
  if (!domain) return []
  return db.prepare(
    `SELECT DISTINCT l.email FROM touches t JOIN leads l ON l.id = t.lead_id
     WHERE t.workspace_id = ? AND t.company_domain = ? AND t.sent_at >= ? LIMIT ?`
  ).all(wsId, domain, since, limit).map((r) => r.email)
}

// A touch on this person today through a different channel. An email and a
// LinkedIn message landing within hours of each other reads as pursuit, not
// diligence — and the product's rule is that no touch may reference another.
export function touchedTodayByOtherChannel(wsId, leadId, channel, dayStart) {
  return db.prepare(
    `SELECT * FROM touches
     WHERE workspace_id = ? AND lead_id = ? AND channel != ? AND sent_at >= ?
     ORDER BY sent_at DESC LIMIT 1`
  ).get(wsId, leadId, channel, dayStart) || null
}

// One-time backfill from `messages` so the caps are not blind to everything
// that happened before this table existed. Without it, a workspace mid-campaign
// would double-touch every person in flight on the day this ships.
export function backfillTouches(database = db) {
  const already = database.prepare('SELECT COUNT(*) n FROM touches').get().n
  if (already) return 0
  const rows = database.prepare(
    `SELECT m.user_id, m.lead_id, m.campaign_id, m.to_email, m.created_at
     FROM messages m WHERE m.direction = 'out' AND m.lead_id IS NOT NULL`
  ).all()
  const insert = database.prepare(
    `INSERT INTO touches (workspace_id, lead_id, company_domain, channel, campaign_id, sent_at)
     VALUES (?, ?, ?, 'email', ?, ?)`
  )
  const run = database.transaction((all) => {
    for (const r of all) {
      const at = Date.parse(String(r.created_at || '').replace(' ', 'T') + 'Z') || 0
      if (!at) continue
      insert.run(r.user_id, r.lead_id, companyKey(r.to_email), r.campaign_id, at)
    }
  })
  run(rows)
  return rows.length
}
