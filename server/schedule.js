// Calendar maths for the send controls: windows, blackout dates, quiet hours.
//
// `server/pacing.js` answers "is it inside the one workspace window" and stays
// exactly as it was. This file answers the richer question the controls need:
// several windows a day, different hours on different days, dates the workspace
// is shut, and the recipient's own clock — all in a shape that can be
// intersected, because the whole control stack is built on narrowing (a
// campaign may only ever restrict the workspace, never widen it).
//
// Everything here is pure. The store lives in `server/send-rules.js` and the
// decision in `server/gates.js`.
//
// Times are wall-clock minutes past local midnight. Days are 0=Sunday..6, the
// same numbering the campaign schedule API already uses.

const formatters = new Map()

function formatter(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Wall-clock in a given zone: the minute of the day, the weekday number, and
// the local calendar date (which is what a blackout is written against — a
// holiday is a date where the recipient is, not a UTC instant).
export function localAt(tz, at) {
  const parts = formatter(tz).formatToParts(new Date(at))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  const hour = Number(get('hour')) % 24
  return {
    minutes: hour * 60 + Number(get('minute')),
    day: WEEKDAY_INDEX[get('weekday')] ?? 1,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

export function toMinutes(hhmm, fallback = null) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return fallback
  const mins = Number(m[1]) * 60 + Number(m[2])
  return mins >= 0 && mins <= 24 * 60 ? mins : fallback
}

export function toClock(minutes) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(minutes)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// ---- windows ----------------------------------------------------------------

// A window list is authored as [{ days: [1,2,3,4,5], from: '08:30', to: '12:00' }].
// Internally it is a map of day → sorted, merged [fromMin, toMin] segments,
// which is the only shape that intersects cleanly.
export function segmentsOf(windows) {
  const byDay = new Map()
  for (const w of Array.isArray(windows) ? windows : []) {
    const from = toMinutes(w?.from)
    const to = toMinutes(w?.to)
    // A window that ends before it starts is not a window that crosses
    // midnight — it is a typo. Dropping it is safer than sending at 3am.
    if (from === null || to === null || to <= from) continue
    for (const day of Array.isArray(w?.days) ? w.days : []) {
      const d = Number(day)
      if (!Number.isInteger(d) || d < 0 || d > 6) continue
      if (!byDay.has(d)) byDay.set(d, [])
      byDay.get(d).push([from, to])
    }
  }
  for (const [day, segs] of byDay) byDay.set(day, merge(segs))
  return byDay
}

function merge(segments) {
  const sorted = segments.slice().sort((a, b) => a[0] - b[0])
  const out = []
  for (const [from, to] of sorted) {
    const last = out[out.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}

// Back to the authored shape, with days that share identical hours collapsed
// into one entry so what comes back out reads like what went in.
export function windowsOf(byDay) {
  const groups = new Map()
  for (const [day, segs] of [...byDay].sort((a, b) => a[0] - b[0])) {
    for (const [from, to] of segs) {
      const key = `${from}-${to}`
      if (!groups.has(key)) groups.set(key, { days: [], from: toClock(from), to: toClock(to) })
      groups.get(key).days.push(day)
    }
  }
  return [...groups.values()].sort((a, b) => toMinutes(a.from) - toMinutes(b.from) || a.days[0] - b.days[0])
}

// The heart of the narrowing rule: the time both sides allow, and nothing else.
// An empty result means the two disagree completely — which is a real answer,
// reported as "your plan's hours fall outside your workspace hours".
export function intersectWindows(a, b) {
  const left = segmentsOf(a)
  const right = segmentsOf(b)
  const out = new Map()
  for (const [day, segs] of left) {
    const other = right.get(day)
    if (!other) continue
    const both = []
    for (const [af, at] of segs) {
      for (const [bf, bt] of other) {
        const from = Math.max(af, bf)
        const to = Math.min(at, bt)
        if (to > from) both.push([from, to])
      }
    }
    if (both.length) out.set(day, merge(both))
  }
  return windowsOf(out)
}

// Clamp every window to a floor, e.g. hard quiet hours. Same as intersecting
// with "this range, every day", but says what it means at the call site.
export function clampWindows(windows, { from, to }) {
  const lo = toMinutes(from)
  const hi = toMinutes(to)
  if (lo === null || hi === null || hi <= lo) return windows
  return intersectWindows(windows, [{ days: [0, 1, 2, 3, 4, 5, 6], from: toClock(lo), to: toClock(hi) }])
}

// ---- blackouts --------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Dates the workspace is shut: a public holiday, a shutdown week, annual leave.
// Written as local calendar dates and compared as strings, because that is what
// a human means by "the 25th" — no instant arithmetic, no off-by-one at
// midnight, no timezone surprise.
export function blackoutOn(blackouts, date) {
  for (const b of Array.isArray(blackouts) ? blackouts : []) {
    const from = DATE_RE.test(b?.from) ? b.from : null
    const to = DATE_RE.test(b?.to) ? b.to : from
    if (!from) continue
    if (date >= from && date <= (to || from)) return b
  }
  return null
}

// ---- openness ---------------------------------------------------------------

// Is this instant inside the windows, on a day that is not blacked out?
// An unknown timezone must never wedge a campaign shut — same rule as
// `pacing.isOpen`, and for the same reason.
export function isOpen(schedule, at) {
  const { windows, blackouts, tz } = schedule
  let local
  try {
    local = localAt(tz, at)
  } catch {
    return true
  }
  if (blackoutOn(blackouts, local.date)) return false
  const segs = segmentsOf(windows).get(local.day)
  if (!segs) return false
  return segs.some(([from, to]) => local.minutes >= from && local.minutes < to)
}

// The first moment from `at` that the schedule is open. Stepped rather than
// computed, deliberately: daylight saving, half-hour zones and a blackout that
// ends mid-week all come out right without a special case for any of them.
// Returns null if nothing opens inside the horizon — an empty intersection, or
// a blackout longer than three weeks — so the caller can say so rather than
// print a wrong time.
const STEP_MS = 15 * 60_000
const HORIZON_DAYS = 21

export function nextOpen(schedule, at) {
  const limit = at + HORIZON_DAYS * 86_400_000
  // Start on a 15-minute boundary so two calls a second apart agree, which is
  // what makes the countdown in the queue stop jittering.
  let t = Math.ceil(at / STEP_MS) * STEP_MS
  if (isOpen(schedule, at)) return at
  for (; t < limit; t += STEP_MS) {
    if (isOpen(schedule, t)) return t
  }
  return null
}

// A sentence a person can check at a glance. Used in the UI note and in the
// activity trail, so support and the user are reading the same words.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]

export function describeWindows(windows) {
  const entries = windowsOf(segmentsOf(windows))
  if (!entries.length) return 'never — no hours are open'
  return entries.map((w) => {
    const days = w.days.slice().sort((a, b) => a - b)
    const label = days.length === 7
      ? 'Every day'
      : days.length === 5 && WEEKDAYS.every((d) => days.includes(d))
        ? 'Weekdays'
        : days.map((d) => DAY_NAMES[d]).join(', ')
    return `${label} ${w.from}–${w.to}`
  }).join(', ')
}
