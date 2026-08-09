// Everything that makes an address un-emailable, in one place.
//
// This lives on its own, importing nothing but the database, for two reasons.
// It is read from `server/mailer.js` — the single line every send passes
// through — and from the parity routes that guard the entry points, and those
// two import each other; putting it here breaks the cycle. And it is the rule
// most worth being unable to work around: there is no bypass parameter, so no
// caller can remember the block list and forget the unsubscribe.
//
// Docs/README.md states it plainly: "Suppression is unconditional." SmartLead's
// `ignore_unsubscribe_list` and `ignore_global_block_list` are not offered, and
// a request carrying one is refused rather than ignored.

import { db } from './db.js'

const SOURCES = { manual: 'Added by you', bounced: 'Bounced', unsubscribed: 'Unsubscribed' }

// An exact address match, or any parent domain of it. `competitor.com` blocks
// `ana@mail.competitor.com`; walking the labels is what makes a subdomain a
// hit without needing a row per subdomain. Stops at the registrable pair, so a
// bare TLD row could never match everything.
export function blockMatch(wsId, address) {
  const addr = String(address || '').trim().toLowerCase()
  if (!addr) return null
  const exact = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?').get(wsId, addr)
  if (exact) return exact
  const at = addr.lastIndexOf('@')
  if (at < 0) return null
  const labels = addr.slice(at + 1).split('.')
  const find = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ? AND is_domain = 1')
  for (let i = 0; i <= labels.length - 2; i++) {
    const row = find.get(wsId, labels.slice(i).join('.'))
    if (row) return row
  }
  return null
}

// Returns the reason this address cannot be emailed, or null. `lead` is passed
// when the caller already has the row, so the send path costs one query rather
// than two.
export function suppressionFor(wsId, { address, lead = null } = {}) {
  const addr = String(address || '').trim().toLowerCase()
  const blocked = blockMatch(wsId, addr)
  if (blocked) {
    return {
      reason: 'blocked',
      matched: blocked.value,
      message: `${addr} is on the never-contact list (${blocked.value}) — it was ${(SOURCES[blocked.source] || blocked.source).toLowerCase()}`,
    }
  }
  const row = lead || (addr
    ? db.prepare('SELECT * FROM leads WHERE user_id = ? AND lower(trim(email)) = ?').get(wsId, addr)
    : null)
  if (row && (row.status === 'unsubscribed' || String(row.unsubscribed_at || '') !== '')) {
    return { reason: 'unsubscribed', matched: row.email, message: `${row.email} has unsubscribed and will never be emailed again` }
  }
  if (row && row.status === 'bounced') {
    return { reason: 'bounced', matched: row.email, message: `${row.email} hard bounced and will not be emailed again` }
  }
  return null
}

// A refusal, not a failure. The engine treats it as a terminal outcome for that
// lead rather than something to retry, because retrying cannot help: the reason
// an address is suppressed does not expire.
export class SuppressedError extends Error {
  constructor({ reason, matched, message }) {
    super(message)
    this.name = 'SuppressedError'
    this.suppressed = true
    this.reason = reason
    this.matched = matched
  }
}

// Blocking someone has consequences for work already in flight, and those
// consequences must be identical whichever route did the blocking.
//
// They were not. `POST /api/blocked-domains` stopped enrolments and declined
// queued drafts; `POST /api/block-list` — the route the Settings screen
// actually calls — wrote the rows and stopped there. So the block a user could
// reach did the least. One function now, called by both.
//
// Returns what it changed so each route can report it honestly.
export function applySuppression(wsId, values, actor = '') {
  let stoppedLeads = 0
  let declinedDrafts = 0

  for (const entry of values) {
    const value = String(entry?.value ?? entry ?? '').trim().toLowerCase()
    if (!value) continue
    const isDomain = entry?.isDomain ?? entry?.is_domain ?? !value.includes('@')

    // A domain entry catches every address at it or under it, which is the same
    // rule blockMatch applies when deciding — matching it here keeps "what was
    // blocked" and "what got stopped" the same set.
    const leads = db.prepare(
      isDomain
        ? "SELECT id FROM leads WHERE user_id = ? AND (LOWER(email) LIKE ? OR LOWER(email) LIKE ?)"
        : 'SELECT id FROM leads WHERE user_id = ? AND LOWER(TRIM(email)) = ?'
    ).all(wsId, ...(isDomain ? [`%@${value}`, `%.${value}`] : [value]))

    for (const lead of leads) {
      stoppedLeads += db.prepare(
        `UPDATE campaign_leads SET state = 'stopped', outcome = 'blocked', updated_at = datetime('now')
          WHERE lead_id = ? AND state NOT IN ('finished','stopped')
            AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`
      ).run(lead.id, wsId).changes
      declinedDrafts += db.prepare(
        `UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now')
          WHERE user_id = ? AND lead_id = ? AND status IN ('pending','approved')`
      ).run(actor ? `${actor} (blocked)` : 'blocked', wsId, lead.id).changes
      // A reply queued for later is a send that has not happened yet.
      db.prepare(
        `UPDATE messages SET send_status = 'cancelled'
          WHERE user_id = ? AND lead_id = ? AND direction = 'out' AND send_status = 'queued'`
      ).run(wsId, lead.id)
    }
  }
  return { stoppedLeads, declinedDrafts }
}

// ---- unsubscribe -------------------------------------------------------------

// Honour an unsubscribe, everywhere it has to land.
//
// There were two implementations of this and they disagreed. The route a person
// clicks in Settings wrote the timestamps, stopped the enrolments and declined
// the queued drafts. The footer link in the email — the one a *recipient*
// clicks, which is the one that legally matters — set `leads.status` and
// nothing else. So an unsubscribe from the outside world left
// `campaign_leads.unsubscribed_at` empty, which is the column Reports counts,
// and the campaign went on reporting zero unsubscribes while a draft to that
// person sat waiting for approval.
//
// One function now, called by both, because the failure mode here is two
// implementations drifting rather than either one being hard to write.
export function unsubscribeLead(wsId, leadId, { source = 'link', actor = '' } = {}) {
  const at = new Date().toISOString()

  // Read before the update: the address is what the block-list row is keyed on,
  // and it is the only part of this that has to outlive the row it came from.
  const lead = db.prepare('SELECT email FROM leads WHERE id = ? AND user_id = ?').get(leadId, wsId)
  const address = String(lead?.email || '').trim().toLowerCase()

  db.prepare(
    `UPDATE leads SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribed_source = ?,
       updated_at = datetime('now') WHERE id = ? AND user_id = ?`
  ).run(at, source, leadId, wsId)

  // The opt-out is written to the workspace block list as well as to the person.
  //
  // Without this row the suppression lived only on the `leads` row, and
  // `leads` cascades: deleting the person took `campaign_leads`,
  // `lead_list_leads` and every other trace with it. So a recipient who clicked
  // the footer link, was later deleted in a tidy-up, and appeared again in next
  // month's CSV came back as a brand-new active lead — the importer had nothing
  // left to match on — and the engine emailed them. Docs/leads/delete.md is
  // explicit about the rule this restores: "the suppression entry survives the
  // deletion, so re-importing that address is still refused."
  //
  // `POST /api/leads/:id/unsubscribe` already did this; the recipient-facing
  // path and the campaign-scoped route, which both come through here, did not.
  let suppressed = 0
  if (address) {
    suppressed = db.prepare(
      `INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by)
       VALUES (?, ?, 0, 'unsubscribe', ?)`
    ).run(wsId, address, actor || 'recipient').changes
  }

  // Every campaign, not just the one whose email they clicked. Opting out of
  // one is opting out of all of them — anything else is a loophole.
  const stopped = db.prepare(
    `UPDATE campaign_leads SET state = 'stopped', outcome = 'unsubscribed', unsubscribed_at = ?,
       unsubscribed_by = ?, unsubscribed_source = ?, wait_until = '', updated_at = datetime('now')
     WHERE lead_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)
       AND COALESCE(unsubscribed_at, '') = ''`
  ).run(at, actor || 'recipient', source, leadId, wsId).changes

  // A pending draft is an email that has not been sent yet, which makes it the
  // one thing still stoppable at this point.
  const declined = db.prepare(
    `UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now')
     WHERE user_id = ? AND lead_id = ? AND status IN ('pending','approved')`
  ).run(actor || 'unsubscribed', wsId, leadId).changes

  const cancelled = db.prepare(
    `UPDATE messages SET send_status = 'cancelled'
     WHERE user_id = ? AND lead_id = ? AND direction = 'out' AND send_status IN ('queued','scheduled')`
  ).run(wsId, leadId).changes

  return { at, stopped, declined, cancelled, suppressed }
}
