// Sending rhythm: when a running campaign is actually allowed to send.
//
// A campaign that fires twenty identical-looking emails in one second, at 3am,
// from a mailbox connected an hour ago, is the exact pattern spam filters are
// built to catch. So sending is governed by three things, all on by default and
// none of which anyone has to think about:
//
//   1. Hours    — only inside your working hours, on your working days.
//   2. Spacing  — one email per mailbox at a time, with a randomised gap.
//   3. Ceiling  — the mailbox's daily limit, ramped up over its first fortnight.
//
// Randomness here is *deterministic*: the gap is derived from a hash of the
// mailbox, the day, and how many have gone already. Two mailboxes never fire in
// lockstep and no two gaps are the same, but a given situation always produces
// the same answer — so this is reproducible in tests and explainable in support.
//
// Sandbox mailboxes ignore all of it: they exist to be tested in seconds.
import crypto from 'node:crypto'
import { isOAuthProvider } from './providers.js'

export const DEFAULT_WINDOW = { from: '08:30', to: '17:30', days: 'weekdays' }

// Warm-up: a brand-new mailbox that immediately sends its full allowance looks
// exactly like a compromised one.
const RAMP_START = 10
const RAMP_PER_DAY = 5
const MIN_GAP_MS = 45_000
const MAX_GAP_MS = 45 * 60_000

// 0..1 from the inputs. Stable across restarts, unlike Math.random.
export function hashFraction(...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest()
  return digest.readUInt32BE(0) / 0xffffffff
}

const toMinutes = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return fallback
  const mins = Number(m[1]) * 60 + Number(m[2])
  return mins >= 0 && mins <= 24 * 60 ? mins : fallback
}

export function sendWindow(owner) {
  return {
    fromMin: toMinutes(owner?.send_from, toMinutes(DEFAULT_WINDOW.from)),
    toMin: toMinutes(owner?.send_to, toMinutes(DEFAULT_WINDOW.to)),
    days: owner?.send_days === 'everyday' ? 'everyday' : 'weekdays',
    // Falls back to the host's zone until a browser has told us otherwise.
    tz: owner?.send_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    on: owner?.paced === undefined ? true : Boolean(owner.paced),
  }
}

// Local wall-clock in the workspace's timezone, without pulling in a date library.
function localAt(tz, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(at))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  const hour = Number(get('hour')) % 24
  return { minutes: hour * 60 + Number(get('minute')), weekday: get('weekday') }
}

const WEEKEND = new Set(['Sat', 'Sun'])

export function isOpen(window, at) {
  let local
  try {
    local = localAt(window.tz, at)
  } catch {
    return true // an unknown timezone must never wedge a campaign shut
  }
  if (window.days === 'weekdays' && WEEKEND.has(local.weekday)) return false
  return local.minutes >= window.fromMin && local.minutes < window.toMin
}

// First moment from `at` that the window is open. Stepped rather than computed
// so daylight saving, half-hour zones, and a window that crosses midnight all
// come out right without special cases.
export function nextOpen(window, at) {
  const STEP = 15 * 60_000
  for (let t = at; t < at + 8 * 86_400_000; t += STEP) {
    if (isOpen(window, t)) return t
  }
  return at
}

// Today's ceiling for this mailbox: its own limit, held down while it warms up,
// and held down further by a warm-up count the user has set by hand.
//
// That last clause is load-bearing. `PUT /api/mailboxes/:id/warmup` has always
// stored `warmup_daily_count`, reported it back as "today's effective cap", and
// let server/upkeep.js tune it up and down off bounce telemetry — while nothing
// on the send path ever read it. A mailbox set to 5 a day sent 50, and the only
// thing the setting changed was the number on the screen. It is read here, in
// the one function the engine, the approval queue, the campaign header and the
// mailer all ask, so there is a single answer rather than two that disagree.
//
// It can only ever *tighten*: the min against the ramp is deliberate, so no
// value posted to the warm-up route can hand a mailbox connected an hour ago
// its full allowance. `warmup_ramp_enabled: false` therefore means "do not
// climb past the count you chose", not "start there on day one" — Harry's own
// first-fortnight floor is not switchable, and that divergence is recorded in
// Docs/email-accounts/warmup-settings.md.
export function dailyCap(mailbox, now = Date.now()) {
  const limit = mailbox.daily_limit
  if (!isOAuthProvider(mailbox.provider)) return limit
  const chosen = mailbox.warmup_enabled && mailbox.warmup_daily_count > 0
    ? Math.max(1, Math.min(limit, mailbox.warmup_daily_count))
    : limit
  const connected = Date.parse(String(mailbox.created_at || '').replace(' ', 'T') + 'Z')
  if (!connected) return chosen
  const days = Math.max(0, Math.floor((now - connected) / 86_400_000))
  return Math.max(1, Math.min(chosen, RAMP_START + days * RAMP_PER_DAY))
}

export function isWarmingUp(mailbox, now = Date.now()) {
  return dailyCap(mailbox, now) < mailbox.daily_limit
}

export function remainingToday(mailbox, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10)
  const sent = mailbox.sent_today_date === today ? mailbox.sent_today : 0
  return Math.max(0, dailyCap(mailbox, now) - sent)
}

// The gap before this mailbox may send again: the day's remaining allowance
// spread across the hours left in the window, then scattered by ±50%.
export function nextGapMs(window, mailbox, now = Date.now()) {
  const left = Math.max(1, remainingToday(mailbox, now))
  let minutesLeft = Math.max(30, window.toMin - localAt(window.tz, now).minutes)
  if (!Number.isFinite(minutesLeft)) minutesLeft = 480
  const even = (minutesLeft / left) * 60_000
  const jitter = 0.5 + hashFraction(mailbox.id, mailbox.sent_today, new Date(now).toISOString().slice(0, 10))
  return Math.round(Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, even * jitter)))
}

// May this mailbox send right now, and if not, when?
// Returns { ok } or { ok: false, reason, until }.
export function canSendNow(owner, mailbox, now = Date.now()) {
  const outOfAllowance = { ok: false, reason: 'daily limit reached', until: null }
  // The ceiling is a number a human set, so it always applies. Only the clock
  // and the spacing are skipped — for sandbox mailboxes, and when pacing is off.
  const hasAllowance = remainingToday(mailbox, now) > 0
  if (!isOAuthProvider(mailbox.provider)) return hasAllowance ? { ok: true } : outOfAllowance
  const window = sendWindow(owner)
  if (!window.on) return hasAllowance ? { ok: true } : outOfAllowance
  if (!hasAllowance) {
    // The counter rolls at UTC midnight (mailer.js keys it on the ISO date),
    // so that is the earliest the allowance can come back.
    const midnightUtc = now - (now % 86_400_000) + 86_400_000
    return {
      ok: false,
      until: nextOpen(window, midnightUtc),
      reason: isWarmingUp(mailbox, now)
        ? `warming up — ${dailyCap(mailbox, now)} a day for now`
        : 'daily limit reached',
    }
  }
  if (!isOpen(window, now)) {
    return { ok: false, reason: 'outside your sending hours', until: nextOpen(window, now) }
  }
  if (mailbox.next_send_at && mailbox.next_send_at > now) {
    return { ok: false, reason: 'spacing out sends', until: mailbox.next_send_at }
  }
  return { ok: true }
}

// A follow-up that lands exactly 72.0 hours later, for every lead, reads as a
// machine. Fixed per lead and step, so the schedule is stable, not jittery.
export function followUpJitter(leadId, nodeId) {
  return 0.85 + hashFraction('followup', leadId, nodeId) * 0.3
}
