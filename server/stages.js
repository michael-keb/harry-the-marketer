// Where each prospect actually is: not contacted → contacted → replied →
// interested → agreed → won (or lost / unsubscribed).
//
// Nothing new is stored. The stage is read off the messages, outcomes and
// signed agreements that already exist, so it can never drift out of sync with
// what the engine did.
import { db } from './db.js'

export const STAGES = [
  { key: 'not contacted', rank: 0 },
  { key: 'contacted', rank: 1 },
  { key: 'replied', rank: 2 },
  { key: 'interested', rank: 3 },
  { key: 'agreed', rank: 4 },
  { key: 'won', rank: 5 },
  // Ends the journey wherever it got to.
  { key: 'lost', rank: -1 },
  { key: 'unsubscribed', rank: -1 },
  { key: 'bounced', rank: -1 },
]

export const stageRank = (key) => STAGES.find((s) => s.key === key)?.rank ?? 0

// One pass over the workspace, returning { [leadId]: stage }. Callers with a
// single lead can index into it — it is cheaper than six per-lead queries.
export function leadStages(wsId) {
  const stage = {}
  const set = (leadId, key) => {
    if (!leadId) return
    const current = stage[leadId]
    // Terminal states win over progress; otherwise the furthest stage wins.
    if (current && (stageRank(current) === -1 || stageRank(current) >= stageRank(key))) return
    stage[leadId] = key
  }

  for (const row of db.prepare("SELECT id FROM leads WHERE user_id = ?").all(wsId)) {
    stage[row.id] = 'not contacted'
  }
  for (const row of db.prepare(
    "SELECT DISTINCT lead_id FROM messages WHERE user_id = ? AND direction = 'out'"
  ).all(wsId)) set(row.lead_id, 'contacted')
  for (const row of db.prepare(
    "SELECT DISTINCT lead_id FROM messages WHERE user_id = ? AND direction = 'in'"
  ).all(wsId)) set(row.lead_id, 'replied')
  for (const row of db.prepare(
    "SELECT DISTINCT lead_id FROM messages WHERE user_id = ? AND direction = 'in' AND intent = 'interested'"
  ).all(wsId)) set(row.lead_id, 'interested')
  for (const row of db.prepare(
    "SELECT lead_id FROM consents WHERE user_id = ? AND status = 'signed'"
  ).all(wsId)) set(row.lead_id, 'agreed')
  // Lost ends the ladder wherever the lead got to; a win in any campaign
  // outranks a loss in another, so wins are applied last.
  const outcomes = db.prepare(
    `SELECT cl.lead_id, cl.outcome FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
     WHERE c.user_id = ? AND cl.outcome IN ('won','lost','unsubscribed')`
  ).all(wsId)
  for (const row of outcomes) if (row.outcome !== 'won') stage[row.lead_id] = row.outcome
  for (const row of outcomes) if (row.outcome === 'won') stage[row.lead_id] = 'won'
  // A lead that opted out or bounced is done regardless of which campaign did it.
  for (const row of db.prepare(
    "SELECT id, status FROM leads WHERE user_id = ? AND status IN ('unsubscribed','bounced')"
  ).all(wsId)) stage[row.id] = row.status

  return stage
}

// A one-line preview of the last inbound, for the board card. Whitespace is
// collapsed so a quoted reply does not become a blank card.
export function messageSnippet(body, max = 140) {
  const text = String(body || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Latest inbound per lead in one pass. The board (and GET /api/leads) read
// this rather than N per-lead queries, so a workspace of a few thousand people
// stays one round-trip.
export function lastInbounds(wsId) {
  const rows = db.prepare(`
    SELECT m.lead_id AS leadId, m.body, m.intent, m.created_at AS createdAt
    FROM messages m
    INNER JOIN (
      SELECT lead_id, MAX(id) AS id
      FROM messages
      WHERE user_id = ? AND direction = 'in' AND lead_id IS NOT NULL
      GROUP BY lead_id
    ) latest ON latest.id = m.id
  `).all(wsId)
  const map = {}
  for (const row of rows) {
    map[row.leadId] = {
      snippet: messageSnippet(row.body),
      intent: row.intent || '',
      createdAt: row.createdAt,
    }
  }
  return map
}
