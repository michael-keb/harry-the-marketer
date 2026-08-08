// Holds: the stop button, at every scope, with a reason attached.
//
// One table covers all of it — the workspace-wide "hold everything", a paused
// mailbox, a plan parked for a fortnight, a single person left alone, and the
// automatic holds the brakes place when bounces climb. Keeping them in one
// place means "what is stopping this send?" is one query rather than five, and
// that a hold placed by a machine and a hold placed by a person look the same
// to the resolver and read the same to the user.
//
// A hold always carries who placed it and why. A stop with no reason attached
// is the thing support cannot explain and the user cannot undo with confidence.

import { db, logEvent } from './db.js'

export const SCOPES = ['workspace', 'campaign', 'mailbox', 'lead']

// Automatic holds are the ones the system placed. They can be released by a
// person, but they say so, and releasing one is recorded.
export const AUTOMATIC = new Set(['bounce_brake', 'complaint_brake', 'mailbox_health'])

function scopeId(scope, id) {
  return scope === 'workspace' ? 0 : Number(id) || 0
}

// Every hold currently in force for a workspace, expired ones swept first.
// Called once per tick, not per lead: the result is passed down.
export function activeHolds(wsId, now = Date.now()) {
  db.prepare(
    `DELETE FROM send_holds
     WHERE workspace_id = ? AND release_at > 0 AND release_at <= ?`
  ).run(wsId, now)
  return db.prepare('SELECT * FROM send_holds WHERE workspace_id = ? ORDER BY id').all(wsId)
}

// The hold that stops this particular send, if any. Workspace holds win because
// they are the widest: if everything is held, the reason the user needs to see
// is "everything is held", not "this mailbox is paused".
export function holdFor(holds, { campaignId = null, mailboxId = null, leadId = null } = {}) {
  const match = (scope, id) => holds.find((h) => h.scope === scope && h.scope_id === (id || 0))
  return match('workspace', 0)
    || match('mailbox', mailboxId)
    || match('campaign', campaignId)
    || match('lead', leadId)
    || null
}

export function placeHold(wsId, { scope, id = 0, reason, source = 'manual', by = '', releaseAt = 0 }) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown hold scope ${scope}`)
  const sid = scopeId(scope, id)
  const existing = db.prepare(
    'SELECT * FROM send_holds WHERE workspace_id = ? AND scope = ? AND scope_id = ?'
  ).get(wsId, scope, sid)
  // An automatic hold never overwrites one a person placed: the machine's
  // reason is not more important than the human's, and replacing it would lose
  // the only record of why sending was stopped in the first place.
  if (existing && AUTOMATIC.has(source) && !AUTOMATIC.has(existing.source)) return existing
  db.prepare(
    `INSERT INTO send_holds (workspace_id, scope, scope_id, reason, source, created_by, release_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, scope, scope_id)
     DO UPDATE SET reason = excluded.reason, source = excluded.source,
                   created_by = excluded.created_by, release_at = excluded.release_at,
                   created_at = datetime('now')`
  ).run(wsId, scope, sid, String(reason || '').slice(0, 300), source, String(by || '').slice(0, 200), Number(releaseAt) || 0)
  logEvent(wsId, {
    campaignId: scope === 'campaign' ? sid : null,
    leadId: scope === 'lead' ? sid : null,
    type: 'send_held',
    detail: `${scope === 'workspace' ? 'all sending' : scope} held — ${reason}`,
  })
  return db.prepare('SELECT * FROM send_holds WHERE workspace_id = ? AND scope = ? AND scope_id = ?').get(wsId, scope, sid)
}

export function releaseHold(wsId, { scope, id = 0, by = '' }) {
  const sid = scopeId(scope, id)
  const existing = db.prepare(
    'SELECT * FROM send_holds WHERE workspace_id = ? AND scope = ? AND scope_id = ?'
  ).get(wsId, scope, sid)
  if (!existing) return null
  db.prepare('DELETE FROM send_holds WHERE id = ?').run(existing.id)
  logEvent(wsId, {
    campaignId: scope === 'campaign' ? sid : null,
    leadId: scope === 'lead' ? sid : null,
    type: 'send_released',
    detail: `${scope === 'workspace' ? 'all sending' : scope} released${by ? ` by ${by}` : ''}`,
  })
  return existing
}

// "Held until Monday" reads better than an ISO string, and a hold with no end
// is the one people forget they placed — so it says that too.
export function describeHold(hold) {
  if (!hold) return ''
  const who = AUTOMATIC.has(hold.source) ? 'Sending stopped automatically' : 'Sending is on hold'
  const until = hold.release_at
    ? ` until ${new Date(hold.release_at).toISOString().replace('T', ' ').slice(0, 16)}`
    : ' until you lift it'
  return `${who}${until} — ${hold.reason}`
}
