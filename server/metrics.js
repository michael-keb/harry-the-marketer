// What the numbers mean. One definition, read by every surface that shows them.
//
// This module exists because two screens disagreed by a factor of three. The
// campaign header said a 13.3% reply rate and Reports said 40.0% for the same
// campaign on the same data, because one divided replying leads by emails sent
// and the other divided them by leads contacted. Both are defensible
// definitions of "reply rate". Only one of them can be on screen.
//
// The rule this file enforces is not "these formulas are correct" — it is
// "there is exactly one formula, and everyone reads it from here". A rate
// defined twice will drift, however carefully both copies are written, because
// the two copies are edited on different days by people fixing different bugs.
//
// Three things are settled here and nowhere else:
//
//   1. WHAT COUNTS AS A SEND. A test send is not outreach. Neither is a
//      forward. `analytics.js` was counting both, so turning on a campaign and
//      pressing "send me a test" moved every headline figure in Reports.
//
//   2. THE DENOMINATOR. Stated in the name and returned alongside the number,
//      so a figure can always be traced: `{ value, numerator, denominator }`.
//
//   3. WHAT AN EMPTY DENOMINATOR PRODUCES. Zero, never NaN, never Infinity,
//      never null — the existing GET /analytics has always returned 0 and two
//      surfaces disagreeing about *that* would be the same bug again.

import { db } from './db.js'

// ---- what counts -------------------------------------------------------------

// A test send and a forward are real emails, and they belong in the thread and
// in the mailbox's daily quota. They are not outreach, so they are not in any
// campaign figure. `send_status` carries the distinction.
//
// Both spellings of forward are listed on purpose. The forward route writes
// `'forwarded'` while this clause was first written against `'forward'`, and
// the mismatch meant every forward silently inflated `sent` and halved the
// open/click/bounce denominators. `tests/metrics.test.js` asserts that every
// literal any module writes appears here, so the next spelling cannot drift.
export const NOT_OUTREACH = ['test', 'forward', 'forwarded', 'cancelled', 'failed', 'seed']
const NOT_OUTREACH_SQL = NOT_OUTREACH.map((s) => `'${s}'`).join(', ')

export const REAL_SEND = `COALESCE(m.send_status,'') NOT IN (${NOT_OUTREACH_SQL})`

// The same clause where the query has no table alias.
export const REAL_SEND_UNALIASED = `COALESCE(send_status,'') NOT IN (${NOT_OUTREACH_SQL})`

// ---- rates -------------------------------------------------------------------

// A percentage to one decimal, with its working shown. Zero denominator is 0:
// "no data yet" is a UI decision, and the UI can tell from `denominator === 0`
// without every caller having to handle a null.
export function rate(numerator, denominator) {
  const n = Number(numerator) || 0
  const d = Number(denominator) || 0
  return {
    value: d > 0 ? Math.round((n / d) * 1000) / 10 : 0,
    numerator: n,
    denominator: d,
  }
}

// The canonical set. Each name says its own denominator, which is the whole
// point: `replyRate` is per lead contacted and `openRate` is per email sent,
// and nobody has to read two modules to find out which.
export function ratesFor(t) {
  return {
    // Per email sent — a provider's view. An email can be opened twice; these
    // count messages with any open, not opens.
    open_rate: rate(t.opened, t.sent),
    click_rate: rate(t.clicked, t.sent),
    bounce_share: rate(t.bounced, t.sent),

    // Per lead contacted — a campaign's view. One person replying three times
    // is one reply. This is the definition GET /analytics has always used and
    // the one the Reports benchmarks are graded against.
    reply_rate: rate(t.repliedLeads, t.contacted),
    positive_reply_rate: rate(t.positiveRepliedLeads, t.contacted),
    win_rate: rate(t.won, t.contacted),
    unsubscribe_rate: rate(t.unsubscribed, t.contacted),
    bounce_rate: rate(t.bouncedLeads, t.contacted),
  }
}

// ---- counts ------------------------------------------------------------------

// Every figure for one campaign, optionally inside a window.
//
// The window applies to everything or to nothing. The previous version windowed
// sends but not bounces or unsubscribes, so a seven-day request compared this
// week's sends against all-time bounces and produced a bounce rate that could
// exceed 100%.
export function campaignTotals(campaignId, window = null) {
  const win = window ? 'AND datetime(m.created_at) >= ? AND datetime(m.created_at) < ?' : ''
  const winArgs = window ? [window.from, window.to] : []

  const out = db.prepare(
    `SELECT COUNT(*) sent,
            COUNT(DISTINCT m.lead_id) contacted,
            SUM(CASE WHEN COALESCE(m.opened_at,'') != '' THEN 1 ELSE 0 END) opened,
            SUM(CASE WHEN COALESCE(m.clicked_at,'') != '' THEN 1 ELSE 0 END) clicked
       FROM messages m
      WHERE m.campaign_id = ? AND m.direction = 'out' AND ${REAL_SEND} ${win}`
  ).get(campaignId, ...winArgs)

  const inbound = db.prepare(
    `SELECT COUNT(*) n, COUNT(DISTINCT m.lead_id) leads
       FROM messages m
      WHERE m.campaign_id = ? AND m.direction = 'in' ${win}`
  ).get(campaignId, ...winArgs)

  // Outcome-shaped figures hang off campaign_leads, whose own timestamps are
  // what the window has to bite on — not the message timestamps above.
  const clWin = window ? 'AND datetime(cl.updated_at) >= ? AND datetime(cl.updated_at) < ?' : ''
  const outcomes = db.prepare(
    `SELECT
       SUM(CASE WHEN l.status = 'bounced' THEN 1 ELSE 0 END) bouncedLeads,
       SUM(CASE WHEN COALESCE(cl.unsubscribed_at,'') != '' THEN 1 ELSE 0 END) unsubscribed,
       SUM(CASE WHEN cl.outcome = 'won' THEN 1 ELSE 0 END) won,
       SUM(CASE WHEN cl.intent = 'interested' THEN 1 ELSE 0 END) positiveRepliedLeads
     FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = ? ${clWin}`
  ).get(campaignId, ...winArgs)

  const bouncedMessages = db.prepare(
    `SELECT COUNT(*) n FROM messages m
      WHERE m.campaign_id = ? AND m.direction = 'out'
        AND COALESCE(m.send_status,'') = 'bounced' ${win}`
  ).get(campaignId, ...winArgs).n

  const sent = out.sent || 0
  const totals = {
    sent,
    contacted: out.contacted || 0,
    delivered: Math.max(sent - bouncedMessages, 0),
    opened: out.opened || 0,
    clicked: out.clicked || 0,
    replied: inbound.n || 0,
    repliedLeads: inbound.leads || 0,
    positiveRepliedLeads: outcomes?.positiveRepliedLeads || 0,
    bounced: bouncedMessages,
    bouncedLeads: outcomes?.bouncedLeads || 0,
    unsubscribed: outcomes?.unsubscribed || 0,
    won: outcomes?.won || 0,
  }
  return { ...totals, rates: ratesFor(totals) }
}

// Flatten `{ value, numerator, denominator }` down to the bare percentages for
// callers whose response shape predates this module. New callers should return
// the objects — a number with no denominator cannot be checked by the reader.
export function flatRates(rates) {
  const out = {}
  for (const [key, r] of Object.entries(rates)) out[key] = r.value
  return out
}
