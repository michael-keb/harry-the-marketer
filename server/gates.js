// May this message leave, and if not, why and when?
//
// One resolver, a stack of named gates, most-restrictive-wins, first blocker
// reported. Every caller — the engine, the approval queue, the campaign header,
// the schedule preview — asks this function and nothing else, so no two screens
// can disagree about why sending has stopped.
//
// The order is fixed and it matters. A person who has unsubscribed must be told
// that, not "outside your sending hours", even though both are true. So the
// gates run widest-consequence first:
//
//   1. refusals            — hold, mailbox broken, plan not running
//   2. consent             — approval missing or stale, they have replied
//   3. recipient           — their quiet hours, how recently we touched them
//   4. calendar            — the windows, blackout dates, start and end dates
//   5. volume              — client allowance, workspace, mailbox, plan, reserve
//   6. spacing             — the randomised gap between sends
//
// Every block returns a sentence a person can act on and, where it is knowable,
// the moment it clears. "Holding" with no explanation is a defect, not a state.

import { db } from './db.js'
import { isOAuthProvider } from './providers.js'
import { isOpen, nextOpen, localAt, describeWindows, blackoutOn } from './schedule.js'
import { effectiveRules } from './send-rules.js'
import { activeHolds, holdFor, describeHold } from './holds.js'
import { lastTouch, companyKey, companyTouchCount, companyTouchedNames, touchedTodayByOtherChannel } from './touches.js'
import { remainingToday, dailyCap, isWarmingUp } from './pacing.js'
// The client partition's own ceiling. Counted where the allowance is stored, so
// the gate and the Settings panel cannot drift apart on what "over" means.
import { clientAllowance } from './parity/clients.js'

const DAY_MS = 86_400_000

const ok = { ok: true, gate: '', reason: '', until: null, needs: null }
const block = (gate, reason, until = null, needs = null) => ({ ok: false, gate, reason, until, needs })

// ---- context ----------------------------------------------------------------

// Built once per campaign per tick, not once per lead: the rules merge reads
// three rows and the hold sweep writes, and doing either two hundred times a
// tick would be the most expensive thing the engine does.
export function sendingContext({ owner, campaign = null, mailbox = null, at = Date.now() }) {
  return {
    owner,
    rules: effectiveRules({ owner, campaign, mailbox }),
    holds: activeHolds(owner.id, at),
  }
}

// ---- recipient clock --------------------------------------------------------

// Country-code domains we can place with confidence. Deliberately short: a
// wrong guess here sends at the wrong hour, which is the exact harm the lever
// exists to prevent, so anything ambiguous stays unknown and falls back to the
// sender's window.
const CCTLD_ZONES = {
  uk: 'Europe/London', ie: 'Europe/Dublin', fr: 'Europe/Paris', de: 'Europe/Berlin',
  nl: 'Europe/Amsterdam', es: 'Europe/Madrid', it: 'Europe/Rome', pt: 'Europe/Lisbon',
  se: 'Europe/Stockholm', no: 'Europe/Oslo', dk: 'Europe/Copenhagen', fi: 'Europe/Helsinki',
  pl: 'Europe/Warsaw', ch: 'Europe/Zurich', at: 'Europe/Vienna', be: 'Europe/Brussels',
  nz: 'Pacific/Auckland', sg: 'Asia/Singapore', jp: 'Asia/Tokyo', kr: 'Asia/Seoul',
  in: 'Asia/Kolkata', hk: 'Asia/Hong_Kong', il: 'Asia/Jerusalem', ae: 'Asia/Dubai',
  za: 'Africa/Johannesburg', br: 'America/Sao_Paulo', mx: 'America/Mexico_City',
}

// Australia and the United States span too many zones for a domain to place
// anyone, so they are not in the map above — .com.au tells you the country and
// nothing about the hour, and guessing Sydney for a Perth recipient is a
// three-hour error in the wrong direction.
export function recipientZone(lead) {
  if (lead?.timezone) return lead.timezone
  const domain = String(lead?.email || '').split('@')[1] || ''
  const parts = domain.toLowerCase().split('.')
  const tld = parts[parts.length - 1]
  return CCTLD_ZONES[tld] || null
}

// ---- helpers ----------------------------------------------------------------

// The first instant every schedule is open at once. Each one is stepped
// forward in turn until they agree, which they do quickly: the windows are the
// coarse constraint and quiet hours only ever trim their edges.
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

function localDayStart(tz, at) {
  try {
    return at - localAt(tz, at).minutes * 60_000
  } catch {
    return at - (at % DAY_MS)
  }
}

const quietSchedule = (rules, tz) => ({
  tz,
  blackouts: [],
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: rules.quietHours.from, to: rules.quietHours.to }],
})

const sendSchedule = (rules, tz) => ({ tz, blackouts: rules.blackouts, windows: rules.windows })

// A date turned into an instant at midday, so no timezone can push it onto
// the day before or the day after.
const atMidday = (date) => Date.parse(`${date}T12:00:00Z`)

// Has this plan already written to this person? A follow-up inside a
// conversation is not a new approach, and the frequency caps must not treat it
// as one — otherwise a three-step sequence stalls after step one.
function isFirstTouch(campaignId, leadId) {
  if (!campaignId || !leadId) return true
  return !db.prepare(
    "SELECT 1 FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' LIMIT 1"
  ).get(campaignId, leadId)
}

// ---- the stack --------------------------------------------------------------

export function resolveSend({
  owner, campaign = null, mailbox = null, lead = null, draft = null,
  channel = 'email', rules, holds, at = Date.now(),
}) {
  rules = rules || effectiveRules({ owner, campaign, mailbox })
  holds = holds || activeHolds(owner.id, at)

  // -- 1. refusals ------------------------------------------------------------

  const hold = holdFor(holds, { campaignId: campaign?.id, mailboxId: mailbox?.id, leadId: lead?.id })
  if (hold) return block('hold', describeHold(hold), hold.release_at || null, hold.release_at ? null : 'human')

  if (campaign && campaign.status !== 'running') {
    return block('campaign_stopped', `${campaign.name} is ${campaign.status}`, null, 'human')
  }
  if (mailbox) {
    if (mailbox.is_suspended) {
      return block('mailbox_suspended', `${mailbox.email} is suspended — ${mailbox.suspended_reason || 'no reason recorded'}`, null, 'human')
    }
    if (mailbox.status !== 'connected') {
      // "is error" is not English, and the status column is a machine's word.
      return block(
        'mailbox_health',
        `${mailbox.email} ${mailbox.status === 'error' ? 'cannot connect' : 'is disconnected'} — reconnect it before anything can send`,
        null, 'reconnect'
      )
    }
  }

  // -- 2. consent -------------------------------------------------------------

  if (draft) {
    if (draft.status === 'pending') return block('awaiting_approval', 'waiting for your OK', null, 'human')
    if (draft.send_after > at) {
      return block('snoozed', `you asked for this one to wait until ${new Date(draft.send_after).toISOString().replace('T', ' ').slice(0, 16)}`, draft.send_after)
    }
    // An approval is a decision about a moment. Three weeks later the reason it
    // made sense may be gone, and the sender has no idea it is still queued —
    // so it goes back to the queue to be looked at again rather than out.
    const reviewedAt = Date.parse(String(draft.reviewed_at || '').replace(' ', 'T') + 'Z') || 0
    const staleMs = rules.staleApprovalDays * DAY_MS
    if (reviewedAt && at - reviewedAt > staleMs) {
      return block('stale_approval', `you approved this ${Math.floor((at - reviewedAt) / DAY_MS)} days ago — worth a second look before it goes`, null, 'human')
    }
    if (campaign && lead && reviewedAt) {
      const replied = db.prepare(
        `SELECT created_at FROM messages
         WHERE campaign_id = ? AND lead_id = ? AND direction = 'in'
         ORDER BY id DESC LIMIT 1`
      ).get(campaign.id, lead.id)
      const repliedAt = Date.parse(String(replied?.created_at || '').replace(' ', 'T') + 'Z') || 0
      if (repliedAt > reviewedAt) {
        return block('replied_since_approval', 'they replied after you approved this — it would answer a question nobody asked', null, 'human')
      }
    }
  }

  // -- 3. the recipient -------------------------------------------------------

  // A sandbox mailbox delivers to nobody, so there is no recipient to protect
  // and no reputation to lose. It skips the frequency caps for the same reason
  // it has always skipped the clock: this is the mailbox you demo and test
  // with, and a fortnight's cooling-off between touches would make a five-lead
  // walkthrough impossible. Suppression, the ceiling and every refusal still
  // apply to it — those are about what the workspace has been told, not about
  // who is on the other end.
  const real = !mailbox || mailbox.provider !== 'sandbox'

  const senderTz = rules.timezone
  const theirTz = lead ? recipientZone(lead) : null
  // Their clock governs when it is rude to arrive; the sender's window governs
  // when the workspace is working. Where we do not know their zone we fall back
  // to the sender's, and never guess.
  const quiet = quietSchedule(rules, theirTz || senderTz)

  if (real && lead && rules.frequency.personDays > 0 && isFirstTouch(campaign?.id, lead.id)) {
    const last = lastTouch(owner.id, lead.id)
    const clearsAt = last ? last.sent_at + rules.frequency.personDays * DAY_MS : 0
    if (clearsAt > at) {
      const days = Math.ceil((clearsAt - at) / DAY_MS)
      return block(
        'person_frequency',
        `we contacted ${lead.email} ${Math.floor((at - last.sent_at) / DAY_MS)} days ago — leaving ${days} more day${days === 1 ? '' : 's'} before approaching them again`,
        clearsAt
      )
    }
  }

  if (real && lead && rules.frequency.companyPerWeek > 0 && isFirstTouch(campaign?.id, lead.id)) {
    const domain = companyKey(lead.email)
    const since = at - 7 * DAY_MS
    const reached = companyTouchCount(owner.id, domain, since)
    if (domain && reached >= rules.frequency.companyPerWeek) {
      const names = companyTouchedNames(owner.id, domain, since)
      return block(
        'company_frequency',
        `${reached} people at ${domain} have heard from you this week (${names.join(', ')}) — that is the limit`,
        since + 7 * DAY_MS
      )
    }
  }

  if (real && lead && rules.frequency.oneChannelPerDay) {
    const dayStart = localDayStart(theirTz || senderTz, at)
    const other = touchedTodayByOtherChannel(owner.id, lead.id, channel, dayStart)
    if (other) {
      return block(
        'channel_spacing',
        `you already reached ${lead.email} by ${other.channel} today — a second channel the same day reads as pursuit`,
        dayStart + DAY_MS
      )
    }
  }

  // Sandbox mailboxes exist to be tested in seconds, so the clock and the gap
  // do not apply to them — the ceiling and every refusal above still do. Same
  // bargain `pacing.canSendNow` has always struck, kept deliberately.
  const onTheClock = mailbox ? isOAuthProvider(mailbox.provider) && rules.paced !== false : true

  // Quiet hours are checked here, before the calendar, and deliberately *not*
  // behind `onTheClock`. Turning "send at a human pace" off means "do not space
  // my emails across my working hours" — it cannot mean "you may now write to
  // people at 3am". That is the one thing the floor exists to prevent, and a
  // toggle elsewhere on the settings page must not be able to lift it.
  if (real && !isOpen(quiet, at)) {
    const send = sendSchedule(rules, rules.recipientLocal && theirTz ? theirTz : senderTz)
    const until = onTheClock ? nextOpenAll([send, quiet], at) : nextOpen(quiet, at)
    // No overlap at all is a real answer, and a common one: a Sydney working
    // day is the London night, so a sender in one and a recipient in the other
    // can never satisfy both windows as written. Saying which lever fixes it
    // beats reporting an empty schedule.
    const stuck = until === null
    const advice = stuck && theirTz && !rules.recipientLocal
      ? ' — your hours never reach their daytime, so switch on recipient-local sending or widen your hours'
      : stuck ? ' — nothing in the next three weeks opens, so a setting has to change' : ''
    return block(
      'recipient_quiet_hours',
      (theirTz
        ? `it is outside ${rules.quietHours.from}–${rules.quietHours.to} where ${lead?.email || 'they'} are`
        : `it is outside ${rules.quietHours.from}–${rules.quietHours.to}`) + advice,
      until,
      stuck ? 'human' : null
    )
  }

  // -- 4. the calendar --------------------------------------------------------

  if (onTheClock) {
    const today = (() => { try { return localAt(senderTz, at).date } catch { return '' } })()
    if (rules.notBefore && today && today < rules.notBefore) {
      return block('not_before', `this plan does not start until ${rules.notBefore}`, atMidday(rules.notBefore))
    }
    if (rules.notAfter && today && today > rules.notAfter) {
      return block('not_after', `this plan stopped sending after ${rules.notAfter}`, null, 'human')
    }

    const send = sendSchedule(rules, rules.recipientLocal && theirTz ? theirTz : senderTz)

    if (!rules.windows.length) {
      return block('no_window', 'your plan\'s hours and your workspace hours do not overlap — nothing can send until one of them changes', null, 'human')
    }

    const blackout = (() => {
      try { return blackoutOn(rules.blackouts, localAt(senderTz, at).date) } catch { return null }
    })()
    if (blackout) {
      const until = nextOpenAll([send, quiet], at)
      return block('blackout', `${blackout.label || 'a blackout date'} — nothing sends today`, until)
    }

    if (!isOpen(send, at)) {
      const until = nextOpenAll([send, quiet], at)
      return block(
        'outside_window',
        `outside your sending hours (${describeWindows(rules.windows)})`
          + (until === null ? ' — nothing in the next three weeks opens, so a setting has to change' : ''),
        until,
        until === null ? 'human' : null
      )
    }
  }

  // -- 5. volume --------------------------------------------------------------

  // The client's allowance, first among the ceilings because it is the widest:
  // a mailbox cap stops one address until tomorrow, this stops every campaign
  // belonging to one brand until a person changes something. Reporting the
  // narrower blocker first would have the campaign header say "sent its 50 for
  // today" when the real answer is "this client is out of allowance".
  //
  // Docs/clients/update.md AC 4: lowering an allowance below what the client has
  // used "pauses sending for that client with a clear reason rather than
  // silently failing mid-campaign". This is that pause. It lives here rather
  // than in a status column on `campaigns` because a breach is a condition, not
  // an event: raise the allowance and sending resumes on the next tick, with
  // nothing to un-pause by hand and no campaign left stopped by a number that
  // has since changed.
  //
  // `client_id` is null for every single-brand workspace, so the count below is
  // never reached by anyone who has no clients.
  if (campaign?.client_id) {
    const spent = clientAllowance(owner.id, campaign.client_id)
    if (spent?.over) {
      return block(
        'client_allowance',
        `${spent.name} has used ${spent.used} of its ${spent.allowed}-email allowance — raise it in Settings → Clients, or return ${spent.name} to the agency pool, before its campaigns send again`,
        null, 'human'
      )
    }
  }

  if (mailbox) {
    const left = remainingToday(mailbox, at)
    if (left <= 0) {
      const cap = dailyCap(mailbox, at)
      const tomorrow = nextOpenAll([sendSchedule(rules, senderTz), quiet], at - (at % DAY_MS) + DAY_MS)
      return block(
        'mailbox_daily_cap',
        isWarmingUp(mailbox, at)
          ? `${mailbox.email} is still warming up — ${cap} a day for now, and today's are gone`
          : `${mailbox.email} has sent its ${cap} for today`,
        tomorrow
      )
    }
    if (rules.caps.hourly > 0) {
      const lastHour = db.prepare(
        `SELECT COUNT(*) n FROM messages
         WHERE mailbox_id = ? AND direction = 'out' AND created_at >= datetime('now', '-60 minutes')`
      ).get(mailbox.id).n
      if (lastHour >= rules.caps.hourly) {
        return block('hourly_cap', `${mailbox.email} has sent its ${rules.caps.hourly} for this hour`, at + 15 * 60_000)
      }
    }
    // Hold back part of the day's allowance for follow-ups. Replies come from
    // conversations already started; spending the whole day on strangers is how
    // a sequence stalls at step one while the inbox fills with people waiting.
    if (rules.followUpReserve > 0 && campaign && lead && isFirstTouch(campaign.id, lead.id)) {
      const reserve = Math.ceil(dailyCap(mailbox, at) * (rules.followUpReserve / 100))
      if (left <= reserve) {
        const tomorrow = nextOpenAll([sendSchedule(rules, senderTz), quiet], at - (at % DAY_MS) + DAY_MS)
        return block(
          'follow_up_reserve',
          `the last ${reserve} of today's allowance is kept for follow-ups — new approaches resume tomorrow`,
          tomorrow
        )
      }
    }
  }

  const dayStart = localDayStart(senderTz, at)
  if (rules.caps.daily > 0) {
    const sentToday = db.prepare(
      'SELECT COUNT(*) n FROM touches WHERE workspace_id = ? AND sent_at >= ?'
    ).get(owner.id, dayStart).n
    if (sentToday >= rules.caps.daily) {
      return block('workspace_daily_cap', `your workspace has sent its ${rules.caps.daily} for today`, dayStart + DAY_MS)
    }
  }
  if (campaign && rules.caps.campaignDaily > 0) {
    const sentToday = db.prepare(
      'SELECT COUNT(*) n FROM touches WHERE workspace_id = ? AND campaign_id = ? AND sent_at >= ?'
    ).get(owner.id, campaign.id, dayStart).n
    if (sentToday >= rules.caps.campaignDaily) {
      return block('campaign_daily_cap', `${campaign.name} has sent its ${rules.caps.campaignDaily} for today`, dayStart + DAY_MS)
    }
  }

  // -- 6. spacing -------------------------------------------------------------

  if (onTheClock && mailbox) {
    if (mailbox.next_send_at && mailbox.next_send_at > at) {
      return block('spacing', 'spacing out sends', mailbox.next_send_at)
    }
    if (rules.minGapMinutes > 0) {
      const last = db.prepare(
        `SELECT created_at FROM messages WHERE mailbox_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1`
      ).get(mailbox.id)
      const lastAt = Date.parse(String(last?.created_at || '').replace(' ', 'T') + 'Z') || 0
      const clears = lastAt + rules.minGapMinutes * 60_000
      if (lastAt && clears > at) {
        return block('min_gap', `at least ${rules.minGapMinutes} minutes between sends`, clears)
      }
    }
  }

  return ok
}

// ---- the automatic brakes ---------------------------------------------------

// Bounces are the signal a mailbox is burning. Two hard bounces in a day, or a
// rate above the threshold across the recent sample, and the mailbox stops
// until a person looks at it.
//
// The absolute trigger matters more than the rate for a small sender: at twenty
// emails a day a percentage of the last fifty is a week behind the problem,
// which is a week of sending to a list that is already hurting the domain.
export function bounceStats(mailboxId, sample) {
  const recent = db.prepare(
    `SELECT l.status FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.mailbox_id = ? AND m.direction = 'out'
     ORDER BY m.id DESC LIMIT ?`
  ).all(mailboxId, sample)
  const bounced = recent.filter((r) => r.status === 'bounced').length
  const today = db.prepare(
    `SELECT COUNT(*) n FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.mailbox_id = ? AND m.direction = 'out'
       AND m.created_at >= datetime('now', '-1 day') AND l.status = 'bounced'`
  ).get(mailboxId).n
  return {
    sample: recent.length,
    bounced,
    ratePercent: recent.length ? (bounced / recent.length) * 100 : 0,
    last24h: today,
  }
}

// Returns the reason to stop, or null. The caller places the hold, so this
// stays a pure question and can be asked by the monitoring page too.
export function brakeReason(mailbox, rules) {
  const brakes = rules.brakes || {}
  const stats = bounceStats(mailbox.id, brakes.bounceSample || 50)
  if (brakes.bounceAbsolute > 0 && stats.last24h >= brakes.bounceAbsolute) {
    return `${stats.last24h} address${stats.last24h === 1 ? '' : 'es'} bounced from ${mailbox.email} in the last day — sending stopped so the domain does not take the damage`
  }
  // The rate needs a sample worth believing. Ten sends and one bounce is 10%
  // and means nothing; the absolute trigger above is what protects small
  // senders, and this catches the slow burn on larger ones.
  if (brakes.bounceRatePercent > 0 && stats.sample >= 25 && stats.ratePercent > brakes.bounceRatePercent) {
    return `${stats.ratePercent.toFixed(1)}% of the last ${stats.sample} emails from ${mailbox.email} bounced — sending stopped before it costs the domain its reputation`
  }
  return null
}
