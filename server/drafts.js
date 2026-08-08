// The approval queue.
//
// The engine still does all the work — research, personalisation, timing — but
// it stops one step short of the send and leaves the email here. You read it,
// change it if you want, and hit send. Your name is on it, so you sign it off.
import { db, logEvent } from './db.js'

export const approvalRequired = (owner) => Boolean(owner?.require_approval)

// The one open draft for a lead in a campaign, if there is one.
export function openDraft(campaignId, leadId) {
  return db.prepare(
    "SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','approved')"
  ).get(campaignId, leadId)
}

export function createDraft({ userId, campaignId, leadId, nodeId, subject, body }) {
  const info = db.prepare(
    'INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, campaignId, leadId, nodeId, subject, body)
  logEvent(userId, { campaignId, leadId, type: 'awaiting_approval', detail: subject })
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid)
}

export function markDraftSent(id) {
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(id)
}

// A lead can be rerouted (a late reply, a manual resume) while an email for its
// old step is still queued. That email now answers a question nobody asked, so
// it is dropped rather than sent at the wrong step — and the trail says so.
export function discardStaleDraft(draft) {
  db.prepare('DELETE FROM drafts WHERE id = ?').run(draft.id)
  logEvent(draft.user_id, {
    campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'draft_stale',
    detail: `dropped the email queued for step ${draft.node_id} — the lead has moved on`,
  })
}

export function pendingCount(wsId) {
  return db.prepare("SELECT COUNT(*) n FROM drafts WHERE user_id = ? AND status = 'pending'").get(wsId).n
}

// Everything waiting on a human, newest first, with enough context to decide
// without opening anything else.
export function pendingDrafts(wsId, limit = 200) {
  return db.prepare(
    `SELECT d.*, l.email AS lead_email, l.first_name, l.last_name, l.company, l.title,
            c.name AS campaign_name, c.status AS campaign_status,
            (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = d.campaign_id AND m.lead_id = d.lead_id) AS thread_length,
            (SELECT m.body FROM messages m WHERE m.campaign_id = d.campaign_id AND m.lead_id = d.lead_id
              AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS last_reply
     FROM drafts d
     JOIN leads l ON l.id = d.lead_id
     JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.user_id = ? AND d.status = 'pending'
     ORDER BY d.id ASC LIMIT ?`
  ).all(wsId, limit)
}
