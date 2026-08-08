// The send rules: every lever a person can pull over when a message may leave,
// stored per scope and merged by narrowing.
//
// One document per scope object — workspace, campaign, mailbox — rather than
// another dozen columns, because these settings are read together on every send
// and are always edited as a set. The merge is the interesting part:
//
//   **A narrower scope may only restrict a wider one.**
//
// Campaign hours intersect workspace hours, never extend them. A campaign cap
// can be lower than the workspace cap, never higher. This is what makes the
// whole stack safe to hand to a user: no lever anywhere, at any scope, can make
// sending more aggressive than the workspace allows — so the workspace settings
// are a real ceiling rather than a suggestion.
//
// Timezone is the one field that overrides rather than narrows: it is a frame
// of reference, not a permission.

import { db } from './db.js'
import { intersectWindows, clampWindows, toMinutes, toClock } from './schedule.js'

// Hard quiet hours. Not a preference — the floor every window is clamped to,
// including one a user drew themselves. Sending at 03:00 is the single most
// reliable way to look like a machine to a spam filter and like a stranger to a
// person, and no legitimate outreach needs it.
export const QUIET_FLOOR = { from: '06:00', to: '21:00' }
export const QUIET_DEFAULT = { from: '07:00', to: '20:00' }

export const WORKSPACE_DEFAULTS = {
  timezone: '',
  windows: [{ days: [1, 2, 3, 4, 5], from: '08:30', to: '17:30' }],
  quietHours: { ...QUIET_DEFAULT },
  recipientLocal: false,
  blackouts: [],
  notBefore: '',
  notAfter: '',
  // Each cap is counted against its own denominator, whoever set it: `daily`
  // across the workspace, `campaignDaily` within one plan, `hourly` per
  // mailbox. So a workspace can say "no plan may send more than 50 a day"
  // without that becoming a workspace-wide 50. 0 = no ceiling.
  caps: { daily: 0, campaignDaily: 0, hourly: 0 },
  minGapMinutes: 0,                   // an explicit floor under the randomised gap
  followUpReserve: 30,                // % of the day's allowance kept for follow-ups
  frequency: { personDays: 14, companyPerWeek: 3, oneChannelPerDay: true },
  brakes: { bounceRatePercent: 3, bounceSample: 50, bounceAbsolute: 2, stopOnComplaint: true },
  staleApprovalDays: 7,
}

const SCOPES = new Set(['workspace', 'campaign', 'mailbox'])

// ---- narrowing --------------------------------------------------------------

const tighterMin = (a, b) => {          // caps: the lower non-zero one wins
  const list = [a, b].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return list.length ? Math.min(...list) : 0
}
const laterDate = (a, b) => (a && b ? (a > b ? a : b) : a || b || '')
const earlierDate = (a, b) => (a && b ? (a < b ? a : b) : a || b || '')

function narrowQuiet(base, patch) {
  const from = Math.max(toMinutes(base?.from, 0), toMinutes(patch?.from, 0), toMinutes(QUIET_FLOOR.from))
  const to = Math.min(
    toMinutes(base?.to, 24 * 60), toMinutes(patch?.to, 24 * 60), toMinutes(QUIET_FLOOR.to)
  )
  return { from: toClock(from), to: toClock(Math.max(from + 60, to)) }
}

// Fold a scope's stored document onto the rules inherited from above it.
// Absent fields inherit; present fields narrow.
export function narrow(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = { ...base }

  if (patch.timezone) out.timezone = patch.timezone          // frame, not permission
  if (Array.isArray(patch.windows) && patch.windows.length) {
    out.windows = intersectWindows(base.windows, patch.windows)
  }
  if (patch.quietHours) out.quietHours = narrowQuiet(base.quietHours, patch.quietHours)
  if (patch.recipientLocal !== undefined) {
    out.recipientLocal = Boolean(base.recipientLocal || patch.recipientLocal)
  }
  if (Array.isArray(patch.blackouts) && patch.blackouts.length) {
    out.blackouts = [...base.blackouts, ...patch.blackouts]  // a shut day stays shut
  }
  if (patch.notBefore) out.notBefore = laterDate(base.notBefore, patch.notBefore)
  if (patch.notAfter) out.notAfter = earlierDate(base.notAfter, patch.notAfter)
  if (patch.caps) {
    out.caps = {
      daily: tighterMin(base.caps?.daily, patch.caps.daily),
      campaignDaily: tighterMin(base.caps?.campaignDaily, patch.caps.campaignDaily),
      hourly: tighterMin(base.caps?.hourly, patch.caps.hourly),
    }
  }
  if (Number.isFinite(patch.minGapMinutes)) {
    out.minGapMinutes = Math.max(base.minGapMinutes || 0, patch.minGapMinutes)
  }
  if (Number.isFinite(patch.followUpReserve)) {
    out.followUpReserve = Math.max(base.followUpReserve, patch.followUpReserve)
  }
  if (patch.frequency) {
    out.frequency = {
      personDays: Math.max(base.frequency.personDays, Number(patch.frequency.personDays) || 0),
      companyPerWeek: tighterMin(base.frequency.companyPerWeek, patch.frequency.companyPerWeek),
      oneChannelPerDay: Boolean(base.frequency.oneChannelPerDay || patch.frequency.oneChannelPerDay),
    }
  }
  if (patch.brakes) out.brakes = { ...base.brakes, ...patch.brakes }
  if (Number.isFinite(patch.staleApprovalDays)) {
    out.staleApprovalDays = tighterMin(base.staleApprovalDays, patch.staleApprovalDays) || base.staleApprovalDays
  }
  return out
}

// ---- store ------------------------------------------------------------------

function parse(text) {
  try {
    const value = JSON.parse(text || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

export function storedRules(wsId, scope, scopeId = 0) {
  const row = db.prepare(
    'SELECT rules FROM send_rules WHERE workspace_id = ? AND scope = ? AND scope_id = ?'
  ).get(wsId, scope, scopeId || 0)
  return parse(row?.rules)
}

export function saveRules(wsId, scope, scopeId, rules, updatedBy = '') {
  if (!SCOPES.has(scope)) throw new Error(`Unknown scope ${scope}`)
  const before = storedRules(wsId, scope, scopeId)
  db.prepare(
    `INSERT INTO send_rules (workspace_id, scope, scope_id, rules, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workspace_id, scope, scope_id)
     DO UPDATE SET rules = excluded.rules, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(wsId, scope, scopeId || 0, JSON.stringify(rules), String(updatedBy || '').slice(0, 200))
  // Who changed which lever, when, from what to what. Cheap to write and the
  // first thing anyone wants when sending stops for a reason nobody set today.
  db.prepare(
    `INSERT INTO send_rule_changes (workspace_id, scope, scope_id, before_rules, after_rules, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, scope, scopeId || 0, JSON.stringify(before), JSON.stringify(rules), String(updatedBy || '').slice(0, 200))
  return rules
}

// The workspace layer, built from the legacy `users` columns so a workspace
// that has never opened the new settings behaves exactly as it did: the same
// window, the same days, the same timezone. Anything it has since saved narrows
// that. Quiet hours are applied last, to the result, so they hold whatever the
// legacy columns say.
export function workspaceRules(owner) {
  const legacy = {
    timezone: owner?.send_timezone || '',
    windows: [{
      days: owner?.send_days === 'everyday' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
      from: owner?.send_from || WORKSPACE_DEFAULTS.windows[0].from,
      to: owner?.send_to || WORKSPACE_DEFAULTS.windows[0].to,
    }],
  }
  const base = { ...WORKSPACE_DEFAULTS, ...legacy, quietHours: { ...QUIET_DEFAULT } }
  const stored = storedRules(owner.id, 'workspace', 0)
  const merged = narrow(base, stored)
  merged.windows = clampWindows(merged.windows, merged.quietHours)
  merged.timezone = merged.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  merged.paced = owner?.paced === undefined ? true : Boolean(owner.paced)
  return merged
}

// Workspace → campaign → mailbox, each one narrowing the last. The campaign's
// own `schedule` column is folded in as well: it predates this file, it is what
// the campaign Settings page has always written, and until now nothing enforced
// it. Reading it here is what turns that setting from decoration into a rule.
export function effectiveRules({ owner, campaign = null, mailbox = null }) {
  let rules = workspaceRules(owner)
  if (campaign) {
    rules = narrow(rules, legacyCampaignSchedule(campaign))
    rules = narrow(rules, storedRules(owner.id, 'campaign', campaign.id))
  }
  if (mailbox) rules = narrow(rules, storedRules(owner.id, 'mailbox', mailbox.id))
  rules.windows = clampWindows(rules.windows, rules.quietHours)
  return rules
}

// `campaigns.schedule` as written by the existing Settings page:
// { timezone, days: [0..6], start_hour, end_hour, min_gap_minutes }.
export function legacyCampaignSchedule(campaign) {
  const stored = parse(campaign?.schedule)
  if (!stored.start_hour && !stored.end_hour && !Array.isArray(stored.days)) return null
  const days = Array.isArray(stored.days) && stored.days.length ? stored.days : [1, 2, 3, 4, 5]
  return {
    timezone: stored.timezone || '',
    windows: [{ days, from: stored.start_hour || '00:00', to: stored.end_hour || '24:00' }],
    minGapMinutes: Number(stored.min_gap_minutes) || 0,
  }
}

// ---- validation -------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export class RuleError extends Error {
  constructor(field, message) {
    super(message)
    this.field = field
    this.status = 400
  }
}

// Accept only what the resolver can act on, and say which field is wrong.
// A silently-dropped lever is worse than a rejected one: the user believes it
// is holding.
export function validate(patch = {}) {
  const out = {}
  if (patch.timezone !== undefined) {
    const tz = String(patch.timezone || '')
    if (tz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch {
        throw new RuleError('timezone', `${tz} is not a timezone I recognise`)
      }
    }
    out.timezone = tz
  }
  if (patch.windows !== undefined) {
    if (!Array.isArray(patch.windows) || !patch.windows.length) {
      throw new RuleError('windows', 'Give at least one window of hours it may send')
    }
    out.windows = patch.windows.map((w, i) => {
      if (!HHMM.test(String(w?.from)) || !HHMM.test(String(w?.to))) {
        throw new RuleError('windows', `Window ${i + 1} needs a start and end time as HH:MM`)
      }
      if (toMinutes(w.to) <= toMinutes(w.from)) {
        throw new RuleError('windows', `Window ${i + 1} ends before it starts`)
      }
      const days = (Array.isArray(w.days) ? w.days : []).map(Number).filter((d) => d >= 0 && d <= 6)
      if (!days.length) throw new RuleError('windows', `Window ${i + 1} has no days selected`)
      return { days: [...new Set(days)].sort(), from: w.from, to: w.to }
    })
  }
  if (patch.quietHours !== undefined) {
    const q = patch.quietHours || {}
    if (!HHMM.test(String(q.from)) || !HHMM.test(String(q.to))) {
      throw new RuleError('quietHours', 'Quiet hours need a start and end time as HH:MM')
    }
    if (toMinutes(q.from) < toMinutes(QUIET_FLOOR.from) || toMinutes(q.to) > toMinutes(QUIET_FLOOR.to)) {
      throw new RuleError(
        'quietHours',
        `Quiet hours can be narrower than ${QUIET_FLOOR.from}–${QUIET_FLOOR.to}, never wider`
      )
    }
    out.quietHours = { from: q.from, to: q.to }
  }
  if (patch.recipientLocal !== undefined) out.recipientLocal = Boolean(patch.recipientLocal)
  if (patch.blackouts !== undefined) {
    if (!Array.isArray(patch.blackouts)) throw new RuleError('blackouts', 'Blackout dates must be a list')
    out.blackouts = patch.blackouts.map((b, i) => {
      if (!ISO_DATE.test(String(b?.from))) throw new RuleError('blackouts', `Blackout ${i + 1} needs a date as YYYY-MM-DD`)
      const to = b.to ? String(b.to) : b.from
      if (!ISO_DATE.test(to)) throw new RuleError('blackouts', `Blackout ${i + 1} has an end date I cannot read`)
      if (to < b.from) throw new RuleError('blackouts', `Blackout ${i + 1} ends before it starts`)
      return { from: b.from, to, label: String(b.label || '').slice(0, 80) }
    })
  }
  for (const field of ['notBefore', 'notAfter']) {
    if (patch[field] !== undefined) {
      const v = String(patch[field] || '')
      if (v && !ISO_DATE.test(v)) throw new RuleError(field, 'Use a date as YYYY-MM-DD')
      out[field] = v
    }
  }
  if (patch.caps !== undefined) {
    const num = (v, name) => {
      const n = Number(v || 0)
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw new RuleError('caps', `${name} must be a whole number, or 0 for no cap`)
      return n
    }
    out.caps = {
      daily: num(patch.caps?.daily, 'The daily cap'),
      campaignDaily: num(patch.caps?.campaignDaily, 'The per-plan daily cap'),
      hourly: num(patch.caps?.hourly, 'The hourly cap'),
    }
  }
  if (patch.minGapMinutes !== undefined) {
    const n = Number(patch.minGapMinutes || 0)
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw new RuleError('minGapMinutes', 'The minimum gap is a whole number of minutes, up to 1440')
    out.minGapMinutes = n
  }
  if (patch.followUpReserve !== undefined) {
    const n = Number(patch.followUpReserve)
    if (!Number.isFinite(n) || n < 0 || n > 90) throw new RuleError('followUpReserve', 'The follow-up reserve is a percentage between 0 and 90')
    out.followUpReserve = n
  }
  if (patch.frequency !== undefined) {
    const f = patch.frequency || {}
    const days = Number(f.personDays ?? WORKSPACE_DEFAULTS.frequency.personDays)
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new RuleError('frequency', 'The gap between touches is a whole number of days')
    const company = Number(f.companyPerWeek ?? WORKSPACE_DEFAULTS.frequency.companyPerWeek)
    if (!Number.isInteger(company) || company < 0 || company > 500) throw new RuleError('frequency', 'People per company per week must be a whole number, or 0 for no cap')
    out.frequency = { personDays: days, companyPerWeek: company, oneChannelPerDay: Boolean(f.oneChannelPerDay) }
  }
  if (patch.brakes !== undefined) {
    const b = patch.brakes || {}
    const rate = Number(b.bounceRatePercent ?? WORKSPACE_DEFAULTS.brakes.bounceRatePercent)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new RuleError('brakes', 'The bounce threshold is a percentage')
    const absolute = Number(b.bounceAbsolute ?? WORKSPACE_DEFAULTS.brakes.bounceAbsolute)
    if (!Number.isInteger(absolute) || absolute < 0) throw new RuleError('brakes', 'The bounce count must be a whole number')
    out.brakes = {
      bounceRatePercent: rate,
      bounceSample: Number(b.bounceSample) || WORKSPACE_DEFAULTS.brakes.bounceSample,
      bounceAbsolute: absolute,
      stopOnComplaint: b.stopOnComplaint === undefined ? true : Boolean(b.stopOnComplaint),
    }
  }
  if (patch.staleApprovalDays !== undefined) {
    const n = Number(patch.staleApprovalDays)
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new RuleError('staleApprovalDays', 'Approvals go stale after a whole number of days, 1 to 90')
    out.staleApprovalDays = n
  }
  return out
}
