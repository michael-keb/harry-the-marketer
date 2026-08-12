// Step-level send timing: exact clocks and randomised windows.
//
// Precedence when both a delay and an exactTime are present:
//   - delay picks the calendar day (fromMs + delayMs)
//   - exactTime wins for the clock on that day (HH:MM in timezone)
// If both exactTime and randomWindow are set, exactTime wins for the clock;
// the random window is ignored (no slot is written).
//
// Random picks are sticky: getOrCreateStepSlot persists once per
// (campaign, lead, node). Later blackout / window / quiet-hour advances must
// not re-roll — they only walk the chosen instant forward with nextOpen.
import { db } from './db.js'
import { hashFraction } from './pacing.js'
import { blackoutOn, isOpen, localAt, nextOpen } from './schedule.js'

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/
const DAY_MS = 86_400_000

// An `at HH:MM` or `window HH:MM-HH:MM` that resolves to a clock earlier than
// the base instant lands in the PAST — and the engine then sends immediately,
// outside the declared window. Roll such a pick forward to the next occurrence:
// today when the clock is still ahead of the base, otherwise the same clock
// tomorrow. `atLocalMinutes(tz, base + DAY, mins)` is re-resolved rather than
// `+ DAY_MS` added to the instant, so a DST boundary between the two days keeps
// the wall-clock exact.
function rollForwardClock(tz, baseMs, mins, resolved) {
  return resolved < baseMs ? atLocalMinutes(tz, baseMs + DAY_MS, mins) : resolved
}

export function parseClock(hhmm) {
  const m = CLOCK_RE.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function padClock(minutes) {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function validateRandomWindow(window) {
  if (!window || typeof window !== 'object') {
    return { ok: false, error: 'window needs { from, to } as HH:MM' }
  }
  const from = parseClock(window.from)
  const to = parseClock(window.to)
  if (from === null || to === null) {
    return { ok: false, error: 'window needs HH:MM–HH:MM clocks' }
  }
  // Inclusive bounds: from === to is a one-minute slot (span 1).
  if (to < from) return { ok: false, error: 'window end must be at or after start' }
  return { ok: true }
}

// Offset (local − UTC) in ms that `tz` was at the given instant.
function offsetAt(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return asUtc - date.getTime()
}

// Wall-clock in `tz` → UTC ms. Two passes so DST boundaries resolve correctly.
function zonedInstant(tz, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0)
  const first = guess - offsetAt(tz, new Date(guess))
  return guess - offsetAt(tz, new Date(first))
}

function atLocalMinutes(tz, baseMs, minutes) {
  const local = localAt(tz, baseMs)
  const [y, mo, d] = local.date.split('-').map(Number)
  const hh = Math.floor(minutes / 60)
  const mm = minutes % 60
  return zonedInstant(tz, y, mo, d, hh, mm)
}

// Inclusive pick of a minute inside [from, to], stable for the same inputs.
export function pickRandomInWindow({ campaignId, leadId, nodeId, from, to, timezone, dayKey }) {
  const fromMin = parseClock(from)
  const toMin = parseClock(to)
  if (fromMin === null || toMin === null || toMin < fromMin) return null
  const span = toMin - fromMin + 1
  const frac = hashFraction(campaignId, leadId, nodeId, timezone || '', dayKey || '', from, to)
  const offset = Math.min(span - 1, Math.floor(frac * span))
  return fromMin + offset
}

export function getOrCreateStepSlot({
  campaignId, leadId, nodeId, window, timezone, baseMs, source = 'step',
}) {
  const existing = db.prepare(
    'SELECT * FROM step_send_slots WHERE campaign_id = ? AND lead_id = ? AND node_id = ?'
  ).get(campaignId, leadId, nodeId)
  if (existing) {
    return {
      at: existing.chosen_at,
      reused: true,
      window: { from: existing.window_from, to: existing.window_to },
    }
  }

  const v = validateRandomWindow(window)
  if (!v.ok) throw new Error(v.error)

  const tz = timezone || 'UTC'
  let dayKey = ''
  try { dayKey = localAt(tz, baseMs).date } catch { dayKey = new Date(baseMs).toISOString().slice(0, 10) }

  const mins = pickRandomInWindow({
    campaignId, leadId, nodeId,
    from: window.from, to: window.to,
    timezone: tz, dayKey,
  })
  // Roll forward before persisting: a window whose clock has already passed today
  // must fire tomorrow, not immediately in the past.
  const at = rollForwardClock(tz, baseMs, mins, atLocalMinutes(tz, baseMs, mins))

  db.prepare(`
    INSERT INTO step_send_slots
      (campaign_id, lead_id, node_id, chosen_at, window_from, window_to, timezone, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    campaignId, leadId, String(nodeId), at,
    padClock(parseClock(window.from)), padClock(parseClock(window.to)),
    tz, source || 'step',
  )

  return { at, reused: false, window: { from: padClock(parseClock(window.from)), to: padClock(parseClock(window.to)) } }
}

// Walk forward until every provided schedule is open. Mirrors gates.nextOpenAll
// without importing gates (avoids a cycle through send-rules).
function nextOpenAll(schedules, at, tries = 40) {
  let t = at
  for (let i = 0; i < tries; i++) {
    let moved = false
    for (const s of schedules) {
      if (isOpen(s, t)) continue
      const next = nextOpen(s, t)
      if (next === null) return null
      if (next > t) { t = next; moved = true }
    }
    if (!moved) return t
  }
  return null
}

function advanceToOpen(at, { timezone, blackouts, windows, quietHours }) {
  const tz = timezone || 'UTC'
  const schedules = []
  if (Array.isArray(windows) && windows.length) {
    schedules.push({ tz, blackouts: blackouts || [], windows })
  } else if (Array.isArray(blackouts) && blackouts.length) {
    // Blackouts alone: open all day except shut dates.
    schedules.push({
      tz,
      blackouts,
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }],
    })
  }
  if (quietHours?.from && quietHours?.to) {
    schedules.push({
      tz,
      blackouts: [],
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: quietHours.from, to: quietHours.to }],
    })
  }
  if (!schedules.length) return at
  // Also honour blackouts when only quiet hours were supplied.
  if (Array.isArray(blackouts) && blackouts.length && !schedules.some((s) => s.blackouts?.length)) {
    try {
      const date = localAt(tz, at).date
      if (blackoutOn(blackouts, date)) {
        schedules.push({
          tz,
          blackouts,
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }],
        })
      }
    } catch { /* unknown tz — leave alone */ }
  }
  return nextOpenAll(schedules, at) ?? at
}

export function scheduleStepTime({
  delayMs = 0,
  exactTime = null,
  randomWindow = null,
  timezone = 'UTC',
  fromMs,
  blackouts = [],
  windows = [],
  quietHours = null,
  campaignId = null,
  leadId = null,
  nodeId = null,
}) {
  // Day offset first; clock comes from exactTime or the sticky random slot.
  let at = Number(fromMs) + (Number(delayMs) || 0)
  let reused = false
  let usedWindow = null
  const tz = timezone || 'UTC'

  if (exactTime) {
    const mins = parseClock(exactTime)
    if (mins !== null) {
      // Pin the clock on the delay-adjusted day. Roll forward a day only when the
      // clock lands in the actual past (relative to `fromMs`, i.e. now) — not merely
      // earlier than the delay-adjusted base time. A delay that already moved us to a
      // future day keeps the clock on that day even if it is earlier than the base
      // time-of-day (e.g. `no reply 3d at 09:30` from a 10:00 start → +3d 09:30, not +4d).
      let resolved = atLocalMinutes(tz, at, mins)
      if (resolved < Number(fromMs)) resolved = atLocalMinutes(tz, at + DAY_MS, mins)
      at = resolved
    }
  } else if (randomWindow && campaignId != null && leadId != null && nodeId != null) {
    const slot = getOrCreateStepSlot({
      campaignId, leadId, nodeId,
      window: randomWindow,
      timezone: tz,
      baseMs: at,
    })
    at = slot.at
    reused = slot.reused
    usedWindow = slot.window
  } else if (randomWindow) {
    // No identity to pin a slot — pick ephemerally for this call only.
    const v = validateRandomWindow(randomWindow)
    if (v.ok) {
      let dayKey = ''
      try { dayKey = localAt(tz, at).date } catch { dayKey = '' }
      const mins = pickRandomInWindow({
        campaignId: campaignId ?? 0, leadId: leadId ?? 0, nodeId: nodeId ?? '',
        from: randomWindow.from, to: randomWindow.to,
        timezone: tz, dayKey,
      })
      if (mins !== null) {
        at = rollForwardClock(tz, at, mins, atLocalMinutes(tz, at, mins))
        usedWindow = {
          from: padClock(parseClock(randomWindow.from)),
          to: padClock(parseClock(randomWindow.to)),
        }
      }
    }
  }

  at = advanceToOpen(at, { timezone: tz, blackouts, windows, quietHours })

  const exactMins = exactTime ? parseClock(exactTime) : null
  return {
    at,
    window: usedWindow,
    exactTime: exactMins === null ? null : padClock(exactMins),
    reused,
  }
}
