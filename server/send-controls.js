// The send controls API: read and set the levers, place and lift holds, and
// see what the stack actually decides.
//
// The preview endpoint is the one that matters most. Every other lever here is
// a promise about the future, and a promise nobody can check is indistinguishable
// from a setting that does nothing — which is exactly what the campaign sending
// window was before this shipped. So the API can always answer "given
// everything currently set, when do the next twenty emails leave?".

import { db, logEvent } from './db.js'
import { resolveSend, sendingContext, bounceStats, recipientZone } from './gates.js'
import {
  storedRules, saveRules, effectiveRules, workspaceRules, validate, RuleError,
  WORKSPACE_DEFAULTS, QUIET_FLOOR, syncCampaignScheduleColumn,
} from './send-rules.js'
import { activeHolds, placeHold, releaseHold, describeHold, AUTOMATIC, SCOPES } from './holds.js'
import { describeWindows } from './schedule.js'
import { nextGapMs, sendWindow, dailyCap, remainingToday } from './pacing.js'

const owner = (wsId) => db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)

// The mailbox a workspace-wide answer should be about.
//
// A real mailbox first — and a *broken* real mailbox still beats a working
// sandbox one, because "reconnect elnakeebm@gmail.com" is the thing the user
// needs to hear and "sending is open" from a sandbox that ignores the clock is
// noise dressed as good news. Connected ones are preferred among the real ones;
// the sandbox fallback exists so a workspace that only has one still gets an
// answer rather than an empty screen.
const realMailbox = (wsId) =>
  db.prepare(
    "SELECT * FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL AND provider != 'sandbox' ORDER BY (status = 'connected') DESC, id LIMIT 1"
  ).get(wsId)
  || db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1').get(wsId)

function scopeTarget(wsId, scope, id) {
  if (scope === 'workspace') return { ok: true, campaign: null, mailbox: null }
  if (scope === 'campaign') {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(id, wsId)
    return campaign ? { ok: true, campaign, mailbox: null } : { ok: false }
  }
  if (scope === 'mailbox') {
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, wsId)
    return mailbox ? { ok: true, campaign: null, mailbox } : { ok: false }
  }
  return { ok: false }
}

// What the user sees on the settings screen: what this scope set itself, what
// it ends up with once everything above it has narrowed, and the floor it can
// never go outside. Three separate things, because a user who cannot tell
// "I set this" from "this was handed down" cannot work out why a change did
// nothing.
function rulesView(wsId, scope, id) {
  const user = owner(wsId)
  const target = scopeTarget(wsId, scope, id)
  if (!target.ok) return null
  const stored = storedRules(wsId, scope, scope === 'workspace' ? 0 : id)
  const effective = scope === 'workspace'
    ? workspaceRules(user)
    : effectiveRules({ owner: user, campaign: target.campaign, mailbox: target.mailbox })
  const inherited = scope === 'workspace' ? WORKSPACE_DEFAULTS : workspaceRules(user)
  return {
    scope,
    id: scope === 'workspace' ? 0 : Number(id),
    stored,
    effective,
    inherited,
    quietFloor: QUIET_FLOOR,
    describes: describeWindows(effective.windows),
    // Narrowing is the rule the whole stack rests on, so it is stated on the
    // screen rather than left for someone to discover.
    note: scope === 'workspace'
      ? 'These are the outer limits. A plan or a mailbox can be stricter than this, never looser.'
      : 'This can only narrow your workspace settings. Anything wider is ignored.',
  }
}

export function registerSendControls(api) {
  // ---- rules ----------------------------------------------------------------

  api.get('/send-rules', (req, res) => {
    const scope = String(req.query.scope || 'workspace')
    const view = rulesView(req.wsId, scope, req.query.id)
    if (!view) return res.status(404).json({ error: 'Not found' })
    res.json(view)
  })

  api.put('/send-rules', (req, res) => {
    const scope = String(req.body?.scope || 'workspace')
    const id = scope === 'workspace' ? 0 : Number(req.body?.id)
    const target = scopeTarget(req.wsId, scope, id)
    if (!target.ok) return res.status(404).json({ error: 'Not found' })
    let clean
    try {
      clean = validate(req.body?.rules || {})
    } catch (err) {
      if (err instanceof RuleError) return res.status(400).json({ error: err.message, field: err.field })
      throw err
    }
    saveRules(req.wsId, scope, id, clean, req.user?.email || '')
    const view = rulesView(req.wsId, scope, id)
    if (scope === 'campaign') syncCampaignScheduleColumn(id, view.effective)
    // A window that narrows to nothing is a saved setting that silently stops
    // every send. Saying so at the moment of saving is the difference between
    // a control and a trap.
    if (!view.effective.windows.length) {
      view.warning = 'These hours do not overlap your workspace hours, so nothing can send. Widen one of them.'
    }
    logEvent(req.wsId, {
      campaignId: scope === 'campaign' ? id : null,
      type: 'send_rules_changed',
      detail: `${scope} — ${view.describes}`,
    })
    res.json(view)
  })

  api.get('/send-rules/history', (req, res) => {
    const rows = db.prepare(
      `SELECT id, scope, scope_id, before_rules, after_rules, changed_by, created_at
       FROM send_rule_changes WHERE workspace_id = ? ORDER BY id DESC LIMIT 50`
    ).all(req.wsId)
    res.json(rows.map((r) => ({
      ...r,
      before: JSON.parse(r.before_rules || '{}'),
      after: JSON.parse(r.after_rules || '{}'),
    })))
  })

  // ---- holds ----------------------------------------------------------------

  api.get('/send-holds', (req, res) => {
    const holds = activeHolds(req.wsId)
    res.json(holds.map((h) => ({
      ...h,
      automatic: AUTOMATIC.has(h.source),
      describes: describeHold(h),
    })))
  })

  api.post('/send-holds', (req, res) => {
    const { scope = 'workspace', id = 0, reason = '', hours = 0 } = req.body || {}
    if (!SCOPES.includes(scope)) {
      return res.status(400).json({ error: 'Unknown scope', field: 'scope' })
    }
    if (scope !== 'workspace') {
      const target = scope === 'lead'
        ? db.prepare('SELECT id FROM leads WHERE id = ? AND user_id = ?').get(id, req.wsId)
        : scopeTarget(req.wsId, scope, id).ok
      if (!target) return res.status(404).json({ error: 'Not found' })
    }
    const releaseAt = Number(hours) > 0 ? Date.now() + Number(hours) * 3600_000 : 0
    const hold = placeHold(req.wsId, {
      scope, id, source: 'manual', by: req.user?.email || '',
      reason: String(reason || '').trim() || 'held by you',
      releaseAt,
    })
    res.json({ ...hold, describes: describeHold(hold) })
  })

  api.delete('/send-holds/:scope/:id', (req, res) => {
    const released = releaseHold(req.wsId, {
      scope: req.params.scope, id: Number(req.params.id) || 0, by: req.user?.email || '',
    })
    if (!released) return res.status(404).json({ error: 'No hold there' })
    res.json({ released: true, was: describeHold(released) })
  })

  // ---- what the stack decides -----------------------------------------------

  // The single sentence every screen shows. Given a campaign (or just a
  // mailbox), what is stopping sending right now and when does it clear?
  api.get('/send-status', (req, res) => {
    const user = owner(req.wsId)
    const campaign = req.query.campaignId
      ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.query.campaignId, req.wsId)
      : null
    // Without a campaign, answer for a real mailbox in preference to a sandbox
    // one. A sandbox skips the clock by design, so reporting "sending is open"
    // from one at 3am on a Sunday would be true and useless.
    const mailbox = campaign?.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
      : realMailbox(req.wsId)
    if (req.query.campaignId && !campaign) return res.status(404).json({ error: 'Not found' })
    const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })
    const slot = resolveSend({ owner: user, campaign, mailbox, rules, holds })
    res.json({
      ok: slot.ok,
      gate: slot.gate,
      reason: slot.reason,
      needs: slot.needs,
      until: slot.until ? new Date(slot.until).toISOString() : null,
      // Which mailbox this answer is about. A workspace with a broken Gmail
      // account and a working sandbox gets two very different answers depending
      // on which one is asked, so the screen has to say which one it asked.
      mailbox: mailbox ? { id: mailbox.id, email: mailbox.email, provider: mailbox.provider } : null,
      hours: describeWindows(rules.windows),
      timezone: rules.timezone,
      quietHours: rules.quietHours,
      remainingToday: mailbox ? remainingToday(mailbox) : 0,
      dailyCap: mailbox ? dailyCap(mailbox) : 0,
      holds: holds.map((h) => ({ scope: h.scope, id: h.scope_id, automatic: AUTOMATIC.has(h.source), describes: describeHold(h) })),
    })
  })

  // The trust lever: replay the whole stack forward and say when the next N
  // emails actually leave. Every other control is guesswork without it.
  //
  // This is a projection, not a promise — a reply, a bounce or an approval
  // changes it — so it is labelled as one and it re-runs the real resolver
  // rather than a simplified copy of the rules, which is the only way it stays
  // honest as levers are added.
  // Grid-friendly schedule for a campaign: projected sends, queued rows, pending
  // drafts and recent history — everything the commit-style heatmap needs.
  api.get('/send-schedule', (req, res) => {
    const user = owner(req.wsId)
    const campaign = req.query.campaignId
      ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.query.campaignId, req.wsId)
      : null
    if (req.query.campaignId && !campaign) return res.status(404).json({ error: 'Not found' })
    const mailbox = campaign?.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
      : realMailbox(req.wsId)
    if (!mailbox) {
      return res.json({
        mailbox: null, timezone: user?.send_timezone || 'UTC', windows: [], markers: [],
        note: 'No mailbox connected yet.',
      })
    }

    const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 120))
    const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })
    const projected = { ...mailbox }
    const window = sendWindow(user)
    const sends = []
    let at = Date.now()
    let blocked = null

    for (let steps = 0; sends.length < limit && steps < limit * 8; steps++) {
      const slot = resolveSend({ owner: user, campaign, mailbox: projected, rules, holds, at })
      if (!slot.ok) {
        if (!slot.until || slot.until <= at) { blocked = slot; break }
        at = slot.until
        continue
      }
      sends.push({ at: new Date(at).toISOString(), kind: 'projected' })
      const today = new Date(at).toISOString().slice(0, 10)
      projected.sent_today = projected.sent_today_date === today ? projected.sent_today + 1 : 1
      projected.sent_today_date = today
      at += nextGapMs(window, projected, at)
      projected.next_send_at = at
    }

    const markers = [...sends]
    if (campaign) {
      for (const d of db.prepare(
        "SELECT id, subject, node_id, created_at FROM drafts WHERE campaign_id = ? AND status = 'pending'"
      ).all(campaign.id)) {
        markers.push({
          at: null,
          kind: 'pending',
          id: d.id,
          label: d.subject || `Step ${d.node_id}`,
        })
      }
      for (const m of db.prepare(
        `SELECT id, subject, scheduled_at, created_at FROM messages
         WHERE campaign_id = ? AND direction = 'out' AND send_status = 'queued'`
      ).all(campaign.id)) {
        const when = m.scheduled_at || m.created_at
        markers.push({
          at: when ? new Date(when.replace(' ', 'T') + 'Z').toISOString() : null,
          kind: 'queued',
          id: m.id,
          label: m.subject || 'Queued reply',
        })
      }
      for (const m of db.prepare(
        `SELECT id, subject, created_at FROM messages
         WHERE campaign_id = ? AND direction = 'out' AND send_status = 'sent'
           AND created_at >= datetime('now', '-35 days')
         ORDER BY created_at ASC`
      ).all(campaign.id)) {
        markers.push({
          at: new Date(m.created_at.replace(' ', 'T') + 'Z').toISOString(),
          kind: 'sent',
          id: m.id,
          label: m.subject || 'Sent',
        })
      }
    }

    res.json({
      mailbox: { id: mailbox.id, email: mailbox.email },
      timezone: rules.timezone,
      windows: rules.windows,
      hours: describeWindows(rules.windows),
      markers,
      blocked: blocked ? { gate: blocked.gate, reason: blocked.reason } : null,
      note: 'A projection from the settings as they stand. Pending drafts need your OK before they appear in green.',
    })
  })

  api.get('/send-preview', (req, res) => {
    const user = owner(req.wsId)
    const campaign = req.query.campaignId
      ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.query.campaignId, req.wsId)
      : null
    if (req.query.campaignId && !campaign) return res.status(404).json({ error: 'Not found' })
    const mailbox = campaign?.mailbox_id
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
      : realMailbox(req.wsId)
    if (!mailbox) return res.json({ mailbox: null, sends: [], note: 'No mailbox connected yet.' })

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })

    // A working copy of the mailbox, advanced as the projection spends its
    // allowance — the real row is never touched.
    const projected = { ...mailbox }
    const window = sendWindow(user)
    const sends = []
    let at = Date.now()
    let blocked = null

    // Waiting for a window to open is not a send, so it must not count against
    // the limit — otherwise asking for twenty gets you twelve and a night.
    // The guard is only there to stop a pathological rule set spinning.
    for (let steps = 0; sends.length < limit && steps < limit * 8; steps++) {
      const slot = resolveSend({ owner: user, campaign, mailbox: projected, rules, holds, at })
      if (!slot.ok) {
        // A gate with a known clearing time is a wait; one without is the end
        // of the projection, and the reason is what the user needs to read.
        if (!slot.until || slot.until <= at) { blocked = slot; break }
        at = slot.until
        continue
      }
      sends.push({ at: new Date(at).toISOString(), number: sends.length + 1 })
      const today = new Date(at).toISOString().slice(0, 10)
      projected.sent_today = projected.sent_today_date === today ? projected.sent_today + 1 : 1
      projected.sent_today_date = today
      at += nextGapMs(window, projected, at)
      projected.next_send_at = at
    }

    res.json({
      mailbox: { id: mailbox.id, email: mailbox.email },
      hours: describeWindows(rules.windows),
      timezone: rules.timezone,
      sends,
      blocked: blocked ? { gate: blocked.gate, reason: blocked.reason } : null,
      note: 'A projection from the settings as they stand. A reply, a bounce or an approval will move it.',
    })
  })

  // Health, as the brakes see it. Shown next to the bounce brake so the number
  // that would stop sending is visible before it does.
  api.get('/send-health', (req, res) => {
    const user = owner(req.wsId)
    const rules = workspaceRules(user)
    const mailboxes = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL ORDER BY id').all(req.wsId)
    res.json(mailboxes.map((m) => {
      const stats = bounceStats(m.id, rules.brakes.bounceSample)
      return {
        id: m.id,
        email: m.email,
        status: m.status,
        sample: stats.sample,
        bounced: stats.bounced,
        ratePercent: Number(stats.ratePercent.toFixed(1)),
        last24h: stats.last24h,
        threshold: rules.brakes,
      }
    }))
  })

  // ---- one queued email at a time -------------------------------------------

  const draftOf = (wsId, id) => db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(id, wsId)

  // Send now skips the spacing gap and nothing else. Every refusal, the quiet
  // hours, the caps and the frequency rules still apply — and the response says
  // so when one of them is what is actually holding it.
  api.post('/queue/:id/send-now', (req, res) => {
    const draft = draftOf(req.wsId, req.params.id)
    if (!draft) return res.status(404).json({ error: 'Not found' })
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(draft.campaign_id)
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign?.mailbox_id)
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(draft.lead_id)
    db.prepare("UPDATE drafts SET send_after = 0 WHERE id = ?").run(draft.id)
    if (mailbox) db.prepare('UPDATE mailboxes SET next_send_at = 0 WHERE id = ?').run(mailbox.id)
    const fresh = { ...mailbox, next_send_at: 0 }
    const slot = resolveSend({
      owner: owner(req.wsId), campaign, mailbox: fresh, lead,
      draft: { ...draft, send_after: 0 },
    })
    logEvent(req.wsId, {
      campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'send_now',
      detail: slot.ok ? 'queued to go on the next tick' : `still held — ${slot.reason}`,
    })
    res.json({
      queued: slot.ok,
      reason: slot.ok ? 'It goes on the next pass, within twenty seconds.' : slot.reason,
      gate: slot.gate,
      note: 'Sending now skips the spacing between emails. It does not skip your quiet hours, your daily limit, or anyone on the never-contact list.',
    })
  })

  // Hold one email back — a specific time, or a snooze.
  api.post('/queue/:id/send-at', (req, res) => {
    const draft = draftOf(req.wsId, req.params.id)
    if (!draft) return res.status(404).json({ error: 'Not found' })
    const { at = '', hours = 0 } = req.body || {}
    let when = 0
    if (hours) when = Date.now() + Number(hours) * 3600_000
    else if (at) {
      when = Date.parse(at)
      if (!when) return res.status(400).json({ error: 'I cannot read that time', field: 'at' })
      if (when < Date.now()) return res.status(400).json({ error: 'That time has passed', field: 'at' })
    }
    db.prepare('UPDATE drafts SET send_after = ? WHERE id = ?').run(when, draft.id)
    logEvent(req.wsId, {
      campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'send_scheduled',
      detail: when ? `held until ${new Date(when).toISOString().replace('T', ' ').slice(0, 16)}` : 'released',
    })
    res.json({
      sendAfter: when ? new Date(when).toISOString() : null,
      note: when
        ? 'It will not go before then, and it still waits for your sending hours after that.'
        : 'Back in the normal queue.',
    })
  })

  // ---- the recipient's clock ------------------------------------------------

  // Setting a lead's timezone is what turns recipient-local sending from a
  // guess into a fact, so it is editable rather than inferred-only.
  api.put('/leads/:id/timezone', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
    if (!lead) return res.status(404).json({ error: 'Not found' })
    const tz = String(req.body?.timezone || '')
    if (tz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch {
        return res.status(400).json({ error: `${tz} is not a timezone I recognise`, field: 'timezone' })
      }
    }
    db.prepare("UPDATE leads SET timezone = ?, updated_at = datetime('now') WHERE id = ?").run(tz, lead.id)
    const updated = { ...lead, timezone: tz }
    res.json({ timezone: tz, resolved: recipientZone(updated), guessed: !tz && Boolean(recipientZone(updated)) })
  })
}
