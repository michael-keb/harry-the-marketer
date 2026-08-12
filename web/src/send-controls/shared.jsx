// Shared send-control UI — workspace ceiling and per-campaign narrowing use the
// same building blocks so the two surfaces never drift apart.
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast } from '../ui.jsx'
import { Field, StatusPill, Collapsible, EditableSection, todayDate } from '../settings/common.jsx'

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const when = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? 'today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function dayLabel(days = []) {
  const sorted = days.slice().sort((a, b) => a - b)
  if (sorted.length === 7) return 'Every day'
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) return 'Weekdays'
  return sorted.map((d) => DAY_NAMES[d]).join(', ')
}

function Group({ id, title, summary, note, children, onSave, onCancel, busy }) {
  return (
    <EditableSection
      id={id}
      variant="inline"
      title={title}
      note={note || summary}
      onSave={onSave}
      onCancel={onCancel}
      busy={busy}
    >
      {children}
    </EditableSection>
  )
}

export function Toggle({ on, onChange, label, hint }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-700">{label}</div>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer ${on ? 'bg-accent-500' : 'bg-slate-300'}`}>
        <span className={`block size-5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export function SendStatus({ status, scope = 'workspace', scopeId = 0, onChanged }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!status) return null

  const held = status.holds?.find((h) => h.scope === scope && Number(h.id) === Number(scopeId))

  const hold = async (hours) => {
    setBusy(true)
    try {
      await api.post('/api/send-holds', {
        scope,
        id: scopeId,
        reason: hours ? `paused for ${hours} hours by you` : 'paused by you',
        hours,
      })
      toast(hours
        ? (scope === 'campaign' ? 'This campaign is on hold' : `Nothing will send for ${hours} hours`)
        : (scope === 'campaign' ? 'This campaign is on hold' : 'Everything is on hold'))
      await onChanged()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const release = async () => {
    setBusy(true)
    try {
      await api.del(`/api/send-holds/${scope}/${scopeId}`)
      toast('Sending can resume')
      await onChanged()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const holdLabel = scope === 'campaign' ? 'Hold this campaign' : 'Hold everything'
  const hold24Label = scope === 'campaign' ? 'Hold for 24 hours' : 'Hold for 24 hours'

  return (
    <section className="card p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink-900">Right now</h2>
          <p className="mt-1.5 text-sm text-slate-700">
            {status.ok
              ? 'Sending is open.'
              : <>Holding — {status.reason}.</>}
            {!status.ok && status.until && <span className="text-slate-600"> Next opening {when(status.until)}.</span>}
            {!status.ok && !status.until && status.needs === 'human' && (
              <span className="text-slate-600"> Nothing clears this on its own — it needs a change here.</span>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {status.mailbox
              ? `${status.mailbox.email}${status.mailbox.provider === 'sandbox' ? ' (sandbox — it ignores the clock)' : ''} · `
              : ''}
            {status.hours} · {status.timezone} · quiet outside {status.quietHours?.from}–{status.quietHours?.to} where they are
          </p>
        </div>
        <StatusPill tone={status.ok ? 'good' : 'warn'}>{status.ok ? 'Open' : 'Holding'}</StatusPill>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
        {held
          ? <button type="button" className="btn-ghost" disabled={busy} onClick={release}>Lift the hold</button>
          : (
            <>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => hold(24)}>{hold24Label}</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => hold(0)}>{holdLabel}</button>
            </>
          )}
      </div>

      {status.holds?.filter((h) => !(h.scope === scope && Number(h.id) === Number(scopeId))).map((h) => (
        <p key={`${h.scope}-${h.id}`} className="text-xs text-amber-700">
          {h.describes}{h.automatic && ' (stopped automatically)'}
        </p>
      ))}
    </section>
  )
}

const COMMON_ZONES = [
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth',
  'Pacific/Auckland', 'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'Asia/Singapore', 'UTC',
]

export function HoursGroup({ rules, effective, inherited, set, save, cancel, busy, variant = 'workspace' }) {
  const windows = rules.windows?.length ? rules.windows : [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }]
  const campaign = variant === 'campaign'

  const setWindow = (i, patch) => set({ windows: windows.map((w, n) => (n === i ? { ...w, ...patch } : w)) })
  const toggleDay = (i, day, on) => setWindow(i, {
    days: on ? [...new Set([...(windows[i].days || []), day])].sort((a, b) => a - b) : windows[i].days.filter((d) => d !== day),
  })

  const savePayload = {
    windows,
    recipientLocal: rules.recipientLocal,
    blackouts: rules.blackouts || [],
  }
  if (rules.timezone !== undefined) savePayload.timezone = rules.timezone || ''
  if (!campaign) {
    savePayload.quietHours = rules.quietHours
  }

  return (
    <Group
      id={campaign ? 'campaign-send-hours' : 'send-hours'}
      title="When it may send"
      summary={campaign
        ? 'The hours and days for this campaign — can only narrow your workspace default.'
        : 'The hours and days, the dates you are shut, and whose clock counts.'}
      onCancel={cancel}
      onSave={() => save(savePayload, 'Sending hours saved')}
      busy={busy}
      note={effective?.windows?.length
        ? `In force: ${effective.windows.map((w) => `${dayLabel(w.days)} ${w.from}–${w.to}`).join(', ')}`
        : 'Nothing can send — these hours leave no time open.'}
    >
      {campaign && inherited?.windows?.length > 0 && (
        <p className="text-xs text-slate-500">
          Workspace allows {inherited.windows.map((w) => `${dayLabel(w.days)} ${w.from}–${w.to}`).join(', ')}.
          This campaign can only be stricter.
        </p>
      )}

      {windows.map((w, i) => (
        <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-3">
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">Days</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {FULL_DAYS.map((name, day) => {
                const on = (w.days || []).includes(day)
                return (
                  <label key={name} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
                    on ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-600'
                  }`}>
                    <input type="checkbox" className="accent-accent-500" checked={on}
                      onChange={(e) => toggleDay(i, day, e.target.checked)} />
                    <span aria-hidden>{DAY_NAMES[day]}</span>
                    <span className="sr-only">{name}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <Field id={`w-${i}-from`} label="From">
              <input id={`w-${i}-from`} type="time" className="input w-32" value={w.from}
                onChange={(e) => setWindow(i, { from: e.target.value })} />
            </Field>
            <Field id={`w-${i}-to`} label="To">
              <input id={`w-${i}-to`} type="time" className="input w-32" value={w.to}
                onChange={(e) => setWindow(i, { to: e.target.value })} />
            </Field>
            {windows.length > 1 && (
              <button type="button" className="btn-ghost mb-0.5"
                onClick={() => set({ windows: windows.filter((_, n) => n !== i) })}>Remove</button>
            )}
          </div>
        </div>
      ))}

      {windows.length < 3 && (
        <button type="button" className="btn-ghost"
          onClick={() => set({ windows: [...windows, { days: [1, 2, 3, 4, 5], from: '14:00', to: '16:00' }] })}>
          Add another window
        </button>
      )}

      <Field
        id="send-tz"
        label="Timezone"
        hint={campaign ? 'Leave empty to follow the workspace default.' : 'Applied to the windows above.'}
      >
        <input
          id="send-tz"
          className="input"
          list="send-control-timezones"
          placeholder="Australia/Sydney"
          value={rules.timezone || ''}
          onChange={(e) => set({ timezone: e.target.value })}
        />
        <datalist id="send-control-timezones">
          {COMMON_ZONES.map((z) => <option key={z} value={z} />)}
        </datalist>
      </Field>

      {!campaign && (
        <div className="border-t border-slate-200 pt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field id="quiet-from" label="Never before">
              <input id="quiet-from" type="time" className="input w-32" min="06:00" value={rules.quietHours?.from || '07:00'}
                onChange={(e) => set({ quietHours: { ...rules.quietHours, from: e.target.value } })} />
            </Field>
            <Field id="quiet-to" label="Never after">
              <input id="quiet-to" type="time" className="input w-32" max="21:00" value={rules.quietHours?.to || '20:00'}
                onChange={(e) => set({ quietHours: { ...rules.quietHours, to: e.target.value } })} />
            </Field>
          </div>
          <p className="text-xs text-slate-500">
            In the recipient&apos;s timezone, where we know it. These can be tightened but not loosened past
            06:00–21:00.
          </p>
        </div>
      )}

      <Toggle
        on={Boolean(rules.recipientLocal)}
        onChange={(v) => set({ recipientLocal: v })}
        label="Use the recipient's clock, not mine"
        hint="Your hours are applied where they are. Where we do not know their timezone, yours is used."
      />

      <Blackouts value={rules.blackouts || []} onChange={(blackouts) => set({ blackouts })} />
    </Group>
  )
}

function Blackouts({ value, onChange }) {
  const [from, setFrom] = useState(todayDate())
  const [to, setTo] = useState(todayDate())
  const [label, setLabel] = useState('')

  return (
    <div className="border-t border-slate-200 pt-4 space-y-3">
      <div className="text-sm text-slate-700">Days you are shut</div>
      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((b, i) => (
            <li key={i} className="flex items-center justify-between gap-3 text-sm text-slate-600">
              <span>{b.label || 'Blackout'} — {b.from}{b.to && b.to !== b.from ? ` to ${b.to}` : ''}</span>
              <button type="button" className="text-xs text-slate-500 underline hover:text-slate-700"
                onClick={() => onChange(value.filter((_, n) => n !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field id="bo-from" label="From"><input id="bo-from" type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="bo-to" label="To"><input id="bo-to" type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field id="bo-label" label="What it is"><input id="bo-label" className="input w-44" placeholder="Annual leave" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <button type="button" className="btn-ghost mb-0.5" disabled={!from}
          onClick={() => { onChange([...value, { from, to: to || from, label }]); setLabel('') }}>Add</button>
      </div>
    </div>
  )
}

export function PeopleGroup({ rules, set, save, cancel, busy }) {
  const f = rules.frequency || {}
  return (
    <Group
      id="send-people"
      title="Protecting the people you write to"
      summary="How often one person, or one company, can hear from you."
      busy={busy}
      onCancel={cancel}
      onSave={() => save({ frequency: {
        personDays: Number(f.personDays) || 0,
        companyPerWeek: Number(f.companyPerWeek) || 0,
        oneChannelPerDay: Boolean(f.oneChannelPerDay),
      } }, 'Saved')}
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field id="freq-person" label="Days before approaching the same person again" hint="Counted across every plan. 0 turns it off.">
          <input id="freq-person" type="number" min="0" max="365" className="input w-28" value={f.personDays ?? 14}
            onChange={(e) => set({ frequency: { ...f, personDays: e.target.value } })} />
        </Field>
        <Field id="freq-company" label="New people per company per week" hint="0 for no limit.">
          <input id="freq-company" type="number" min="0" max="500" className="input w-28" value={f.companyPerWeek ?? 3}
            onChange={(e) => set({ frequency: { ...f, companyPerWeek: e.target.value } })} />
        </Field>
      </div>
      <Toggle
        on={Boolean(f.oneChannelPerDay)}
        onChange={(v) => set({ frequency: { ...f, oneChannelPerDay: v } })}
        label="One channel per person per day"
        hint="An email and a LinkedIn message hours apart reads as pursuit, not diligence."
      />
    </Group>
  )
}

export function VolumeGroup({ rules, set, save, cancel, busy, variant = 'workspace' }) {
  const caps = rules.caps || {}
  const campaign = variant === 'campaign'

  return (
    <Group
      id={campaign ? 'campaign-send-volume' : 'send-volume'}
      title="How much, how fast"
      summary={campaign
        ? 'Daily cap and minimum gap for this campaign.'
        : 'Ceilings across the workspace, and what is kept back for replies.'}
      busy={busy}
      onCancel={cancel}
      onSave={() => save(
        campaign
          ? {
            caps: { campaignDaily: Number(caps.campaignDaily) || 0 },
            minGapMinutes: Number(rules.minGapMinutes) || 0,
          }
          : {
            caps: {
              daily: Number(caps.daily) || 0,
              campaignDaily: Number(caps.campaignDaily) || 0,
              hourly: Number(caps.hourly) || 0,
            },
            followUpReserve: Number(rules.followUpReserve) || 0,
            minGapMinutes: Number(rules.minGapMinutes) || 0,
          },
        'Saved',
      )}
    >
      <div className="flex flex-wrap items-end gap-4">
        {!campaign && (
          <>
            <Field id="cap-daily" label="A day, everything" hint="0 for no cap.">
              <input id="cap-daily" type="number" min="0" className="input w-28" value={caps.daily ?? 0}
                onChange={(e) => set({ caps: { ...caps, daily: e.target.value } })} />
            </Field>
            <Field id="cap-hour" label="An hour, per mailbox">
              <input id="cap-hour" type="number" min="0" className="input w-28" value={caps.hourly ?? 0}
                onChange={(e) => set({ caps: { ...caps, hourly: e.target.value } })} />
            </Field>
          </>
        )}
        <Field id="cap-plan" label="A day, for this plan" hint="0 for no cap.">
          <input id="cap-plan" type="number" min="0" className="input w-28" value={caps.campaignDaily ?? 0}
            onChange={(e) => set({ caps: { ...caps, campaignDaily: e.target.value } })} />
        </Field>
        <Field id="mingap" label="Minutes between sends, at least" hint="0 leaves it to the randomised gap.">
          <input id="mingap" type="number" min="0" max="1440" className="input w-28" value={rules.minGapMinutes ?? 0}
            onChange={(e) => set({ minGapMinutes: e.target.value })} />
        </Field>
      </div>
      {!campaign && (
        <div className="flex flex-wrap items-end gap-4 border-t border-slate-200 pt-4">
          <Field id="reserve" label="Kept for follow-ups (%)" hint="New approaches stop once the day is down to this much; replies still go.">
            <input id="reserve" type="number" min="0" max="90" className="input w-28" value={rules.followUpReserve ?? 30}
              onChange={(e) => set({ followUpReserve: e.target.value })} />
          </Field>
        </div>
      )}
    </Group>
  )
}

export function BrakesGroup({ rules, set, save, cancel, busy }) {
  const b = rules.brakes || {}
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(false)

  useEffect(() => {
    // A failed load must read differently from "no bounces" — otherwise an
    // outage looks like a clean bill of health.
    api.get('/api/send-health')
      .then((rows) => { setHealth(rows || []); setHealthError(false) })
      .catch(() => { setHealth(null); setHealthError(true) })
  }, [])

  return (
    <Group
      id="send-brakes"
      title="Stopping before the damage"
      summary="When bounces climb, sending stops on its own."
      busy={busy}
      onCancel={cancel}
      onSave={() => save({ brakes: {
        bounceAbsolute: Number(b.bounceAbsolute) || 0,
        bounceRatePercent: Number(b.bounceRatePercent) || 0,
        bounceSample: Number(b.bounceSample) || 50,
        stopOnComplaint: true,
      } }, 'Saved')}
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field id="brake-abs" label="Bounces in a day that stop a mailbox" hint="0 turns this off.">
          <input id="brake-abs" type="number" min="0" className="input w-28" value={b.bounceAbsolute ?? 2}
            onChange={(e) => set({ brakes: { ...b, bounceAbsolute: e.target.value } })} />
        </Field>
        <Field id="brake-rate" label="Or a bounce rate above (%)">
          <input id="brake-rate" type="number" min="0" max="100" step="0.5" className="input w-28" value={b.bounceRatePercent ?? 3}
            onChange={(e) => set({ brakes: { ...b, bounceRatePercent: e.target.value } })} />
        </Field>
      </div>
      {healthError ? (
        <p className="border-t border-slate-200 pt-3 text-xs text-amber-700">
          Couldn&apos;t load bounce health — this list may be out of date. Reopen this section to try again.
        </p>
      ) : health?.length > 0 ? (
        <ul className="space-y-1 border-t border-slate-200 pt-3">
          {health.map((m) => (
            <li key={m.id} className="text-xs text-slate-500">
              <span className="text-slate-700">{m.email}</span> — {m.bounced} of the last {m.sample} bounced
            </li>
          ))}
        </ul>
      ) : null}
    </Group>
  )
}

const MS_DAY = 86400e3
const MS_HOUR = 3600e3

function timeoutParts(ms) {
  const n = Number(ms) || 0
  if (n > 0 && n % MS_DAY === 0) return { amount: n / MS_DAY, unit: 'days' }
  if (n > 0 && n % MS_HOUR === 0) return { amount: n / MS_HOUR, unit: 'hours' }
  return { amount: Math.max(0, Math.round(n / MS_DAY)) || 2, unit: 'days' }
}

function timeoutMs(amount, unit) {
  const n = Math.max(0, Number(amount) || 0)
  return Math.round(n * (unit === 'hours' ? MS_HOUR : MS_DAY))
}

// Workspace defaults for no-reply channel switching and randomized send windows.
// Campaigns snapshot these at create/re-save so later workspace edits do not
// silently move live automation (Coral Marten / Cobalt Pike).
export function AutomationDefaultsGroup({ rules, set, save, cancel, busy }) {
  const rh = rules.replyHandling || {}
  const email = rh.email || {}
  const sms = rh.sms || {}
  const rw = rules.randomWindow || {}
  const emailT = timeoutParts(email.timeoutMs ?? 2 * MS_DAY)
  const smsT = timeoutParts(sms.timeoutMs ?? 2 * MS_DAY)

  const setSide = (side, patch) => set({
    replyHandling: {
      ...rh,
      [side]: { ...(rh[side] || {}), ...patch },
    },
  })

  return (
    <Group
      id="send-automation-defaults"
      title="Campaign automation defaults"
      summary="No-reply channel switching and randomized send windows new campaigns inherit."
      note="Already-running campaigns keep the defaults they launched with until they are re-saved."
      busy={busy}
      onCancel={cancel}
      onSave={() => save({
        replyHandling: {
          email: {
            noReplySwitchTo: email.noReplySwitchTo || 'sms',
            timeoutMs: timeoutMs(emailT.amount, emailT.unit),
          },
          sms: {
            noReplySwitchTo: sms.noReplySwitchTo || 'email',
            timeoutMs: timeoutMs(smsT.amount, smsT.unit),
          },
        },
        randomWindow: {
          enabled: Boolean(rw.enabled),
          from: rw.from || '09:00',
          to: rw.to || '11:00',
        },
      }, 'Automation defaults saved')}
    >
      <fieldset className="space-y-3">
        <legend className="text-xs font-medium text-slate-700">When nobody replies</legend>
        {[
          { side: 'email', label: 'After an email', parts: emailT, cfg: email, options: [
            { value: 'sms', label: 'Switch to SMS' },
            { value: 'none', label: "Don't switch" },
            { value: 'email', label: 'Follow up by email' },
          ] },
          { side: 'sms', label: 'After an SMS', parts: smsT, cfg: sms, options: [
            { value: 'email', label: 'Switch to email' },
            { value: 'none', label: "Don't switch" },
            { value: 'sms', label: 'Follow up by SMS' },
          ] },
        ].map(({ side, label, parts, cfg, options }) => (
          <div key={side} className="flex flex-wrap items-end gap-3">
            <Field id={`def-switch-${side}`} label={label}>
              <select
                id={`def-switch-${side}`}
                className="input w-auto"
                value={cfg.noReplySwitchTo || options[0].value}
                onChange={(e) => setSide(side, { noReplySwitchTo: e.target.value })}
              >
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field id={`def-wait-${side}`} label="Wait">
              <div className="flex items-center gap-2">
                <input
                  id={`def-wait-${side}`}
                  type="number"
                  min="0"
                  className="input w-20"
                  value={parts.amount}
                  onChange={(e) => setSide(side, {
                    timeoutMs: timeoutMs(e.target.value, parts.unit),
                  })}
                />
                <select
                  className="input w-auto"
                  value={parts.unit}
                  aria-label={`${label} wait unit`}
                  onChange={(e) => setSide(side, {
                    timeoutMs: timeoutMs(parts.amount, e.target.value),
                  })}
                >
                  <option value="days">days</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </Field>
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-3 border-t border-slate-200 pt-3">
        <legend className="text-xs font-medium text-slate-700">Randomized send window</legend>
        <Toggle
          on={Boolean(rw.enabled)}
          onChange={(on) => set({ randomWindow: { ...rw, enabled: on } })}
          label="Pick a random time inside a window"
          hint="Chosen once per recipient and step, then reused on retry. Inclusive at both ends."
        />
        <div className="flex flex-wrap gap-3">
          <Field id="def-rw-from" label="From (HH:MM)">
            <input
              id="def-rw-from"
              type="time"
              className="input w-36"
              value={rw.from || '09:00'}
              disabled={!rw.enabled}
              onChange={(e) => set({ randomWindow: { ...rw, from: e.target.value } })}
            />
          </Field>
          <Field id="def-rw-to" label="To (HH:MM)">
            <input
              id="def-rw-to"
              type="time"
              className="input w-36"
              value={rw.to || '11:00'}
              disabled={!rw.enabled}
              onChange={(e) => set({ randomWindow: { ...rw, to: e.target.value } })}
            />
          </Field>
        </div>
      </fieldset>
    </Group>
  )
}

export function SchedulePreview({ campaignId = null, limit = 12 }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const q = campaignId ? `?campaignId=${campaignId}&limit=${limit}` : `?limit=${limit}`
    api.get(`/api/send-preview${q}`).then(setPreview).catch(setError)
  }, [campaignId, limit])

  return (
    <Collapsible
      id={campaignId ? 'campaign-send-preview' : 'send-preview'}
      title="When the next emails would actually leave"
      summary="Replays every setting above, in order, and reports the times it lands on."
    >
      {error && <p className="text-sm text-red-700">{error.message}</p>}
      {preview && !preview.mailbox && <p className="text-sm text-slate-600">{preview.note}</p>}
      {preview?.mailbox && (
        <>
          <p className="text-xs text-slate-500">
            From {preview.mailbox.email} · {preview.hours} · {preview.timezone}
          </p>
          {preview.sends.length === 0 && (
            <p className="text-sm text-amber-700">
              Nothing would go out{preview.blocked ? ` — ${preview.blocked.reason}` : '.'}
            </p>
          )}
          <ol className="space-y-1">
            {preview.sends.map((s) => (
              <li key={s.number} className="text-sm text-slate-700">
                <span className="text-slate-500 tabular-nums">{String(s.number).padStart(2, ' ')}.</span>{' '}
                {when(s.at)}
              </li>
            ))}
          </ol>
          {preview.blocked && preview.sends.length > 0 && (
            <p className="text-xs text-amber-700">Then it stops — {preview.blocked.reason}</p>
          )}
          <p className="text-xs text-slate-500">{preview.note}</p>
        </>
      )}
    </Collapsible>
  )
}
