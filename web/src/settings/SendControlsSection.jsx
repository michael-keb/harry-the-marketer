// Send controls — the levers over when a message may leave.
//
// The organising idea, stated on the page rather than left to be discovered:
// these are the outer limits, and a plan or a mailbox can be stricter but never
// looser. Everything below is grouped by what it protects — the clock, the
// volume, and the people on the other end — because "why is nothing sending?"
// is answered by naming a group, not by scanning a list of twenty inputs.
//
// The first thing on the page is the answer to that question, and the second is
// the schedule preview. A control whose effect you cannot see is indistinguishable
// from one that does nothing.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast } from '../ui.jsx'
import { Field, StatusPill, Collapsible, EditableSection, todayDate } from './common.jsx'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const when = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? 'today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export default function SendControlsSection() {
  const toast = useToast()
  const [rules, setRules] = useState(null)     // what this workspace has saved
  const [effective, setEffective] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [view, live] = await Promise.all([
        api.get('/api/send-rules?scope=workspace'),
        api.get('/api/send-status'),
      ])
      // The form is seeded from what is *in force*, not from the empty document
      // this workspace has saved — otherwise every field opens blank and the
      // first save silently rewrites settings the user never looked at.
      setRules({ ...view.effective, ...view.stored })
      setEffective(view.effective)
      setStatus(live)
      setError(null)
    } catch (err) { setError(err) }
  }, [])

  useEffect(() => { load() }, [load])

  // Answers `false` when the save did not happen, which is what keeps the group
  // open with the user's typing still in it rather than closing over a toast.
  const save = async (patch, message) => {
    setBusy(true)
    try {
      const res = await api.put('/api/send-rules', { scope: 'workspace', rules: patch })
      setEffective(res.effective)
      setRules((r) => ({ ...r, ...patch }))
      if (res.warning) toast(res.warning, 'error')
      else if (message) toast(message)
      await load()
      return true
    } catch (err) {
      toast(err.message, 'error')
      return false
    } finally { setBusy(false) }
  }

  if (error) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold text-ink-900">Send controls</h2>
        <p className="mt-2 text-sm text-red-700">{error.message}</p>
      </section>
    )
  }
  if (!rules) return <section className="card p-5 text-sm text-slate-600">Loading the send controls…</section>

  const set = (patch) => setRules((r) => ({ ...r, ...patch }))

  return (
    <>
      <SendStatus status={status} onChanged={load} />

      <section className="card p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-ink-900">Send controls</h2>
          <p className="mt-1 text-sm text-slate-600">
            The outer limits for this workspace. A plan or a mailbox can be stricter than these —
            never looser — so whatever you set here holds everywhere.
          </p>
        </div>

        {/* Cancel re-reads the workspace rather than trusting the draft: what
            you see after backing out is what is actually saved. */}
        <HoursGroup rules={rules} effective={effective} set={set} save={save} cancel={load} busy={busy} />
        <PeopleGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
        <VolumeGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
        <BrakesGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
      </section>

      <SchedulePreview />
    </>
  )
}

// ---- what is happening right now --------------------------------------------

// One sentence naming the gate, and the stop button next to it. This is the
// whole point of the stack: sending that has stopped always says why, and
// stopping it is never more than one click away.
function SendStatus({ status, onChanged }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!status) return null

  const held = status.holds?.find((h) => h.scope === 'workspace')

  const hold = async (hours) => {
    setBusy(true)
    try {
      await api.post('/api/send-holds', {
        scope: 'workspace',
        reason: hours ? `paused for ${hours} hours by you` : 'paused by you',
        hours,
      })
      toast(hours ? `Nothing will send for ${hours} hours` : 'Everything is on hold')
      await onChanged()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const release = async () => {
    setBusy(true)
    try {
      await api.del('/api/send-holds/workspace/0')
      toast('Sending can resume')
      await onChanged()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  return (
    <section className="card p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink-900">Right now</h2>
          <p className="mt-1.5 text-sm text-slate-700">
            {/* Never capitalise the reason: it can begin with an email
                address, and "Elnakeebm@gmail.com" is a different address than
                the one the user typed. The prefix carries the sentence instead,
                which is also how the campaign header words it. */}
            {status.ok
              ? 'Sending is open.'
              : <>Holding — {status.reason}.</>}
            {!status.ok && status.until && <span className="text-slate-600"> Next opening {when(status.until)}.</span>}
            {!status.ok && !status.until && status.needs === 'human' && (
              <span className="text-slate-600"> Nothing clears this on its own — it needs a change here.</span>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {/* Which mailbox this is about. A workspace with a broken Gmail
                account and a working sandbox gets opposite answers depending on
                which one is asked, so unattributed good news is not news. */}
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
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => hold(24)}>Hold for 24 hours</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => hold(0)}>Hold everything</button>
            </>
          )}
      </div>

      {status.holds?.filter((h) => h.scope !== 'workspace').map((h) => (
        <p key={`${h.scope}-${h.id}`} className="text-xs text-amber-700">
          {h.describes}{h.automatic && ' (stopped automatically)'}
        </p>
      ))}
    </section>
  )
}

// ---- hours ------------------------------------------------------------------

function HoursGroup({ rules, effective, set, save, cancel, busy }) {
  const windows = rules.windows?.length ? rules.windows : [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }]

  const setWindow = (i, patch) => set({ windows: windows.map((w, n) => (n === i ? { ...w, ...patch } : w)) })
  const toggleDay = (i, day, on) => setWindow(i, {
    days: on ? [...new Set([...(windows[i].days || []), day])].sort((a, b) => a - b) : windows[i].days.filter((d) => d !== day),
  })

  return (
    <Group
      id="send-hours"
      title="When it may send"
      summary="The hours and days, the dates you are shut, and whose clock counts."
      onCancel={cancel}
      onSave={() => save({
        windows,
        quietHours: rules.quietHours,
        recipientLocal: rules.recipientLocal,
        blackouts: rules.blackouts || [],
      }, 'Sending hours saved')}
      busy={busy}
      note={effective?.windows?.length
        ? `In force: ${effective.windows.map((w) => `${dayLabel(w.days)} ${w.from}–${w.to}`).join(', ')}`
        : 'Nothing can send — these hours leave no time open.'}
    >
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
      <p className="text-xs text-slate-500">
        Two windows a day is how a person actually works — first thing and mid-afternoon — rather than a
        steady drip from nine to five.
      </p>

      <div className="border-t border-slate-200 pt-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          {/* Neither field carries a hint: one hint and one bare label under
              `items-end` puts the two labels at different heights, which reads
              as a broken row. The sentence they share is below both. */}
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
          In the recipient's timezone, where we know it. These can be tightened but not loosened past
          06:00–21:00 — an email at 3am is the single most reliable way to look like a machine to a
          filter and a stranger to a person.
        </p>

        <Toggle
          on={Boolean(rules.recipientLocal)}
          onChange={(v) => set({ recipientLocal: v })}
          label="Use the recipient's clock, not mine"
          hint="Your hours are applied where they are. Where we do not know their timezone, yours is used — it is never guessed."
        />
      </div>

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
      <p className="text-xs text-slate-500">
        Public holidays, a shutdown week, time off. Nothing sends on these days, and follow-ups pick up after.
      </p>
    </div>
  )
}

// ---- the people on the other end --------------------------------------------

function PeopleGroup({ rules, set, save, cancel, busy }) {
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
        <Field id="freq-person" label="Days before approaching the same person again" hint="Counted across every plan, not just this one. 0 turns it off.">
          <input id="freq-person" type="number" min="0" max="365" className="input w-28" value={f.personDays ?? 14}
            onChange={(e) => set({ frequency: { ...f, personDays: e.target.value } })} />
        </Field>
        <Field id="freq-company" label="New people per company per week" hint="0 for no limit.">
          <input id="freq-company" type="number" min="0" max="500" className="input w-28" value={f.companyPerWeek ?? 3}
            onChange={(e) => set({ frequency: { ...f, companyPerWeek: e.target.value } })} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        A follow-up inside a conversation is never held by these — only a fresh approach to someone new.
        Three first emails to three colleagues in one week is what gets a domain blocked by its own IT team.
      </p>
      <Toggle
        on={Boolean(f.oneChannelPerDay)}
        onChange={(v) => set({ frequency: { ...f, oneChannelPerDay: v } })}
        label="One channel per person per day"
        hint="An email and a LinkedIn message hours apart reads as pursuit, not diligence."
      />
    </Group>
  )
}

// ---- volume -----------------------------------------------------------------

function VolumeGroup({ rules, set, save, cancel, busy }) {
  const caps = rules.caps || {}
  return (
    <Group
      id="send-volume"
      title="How much, how fast"
      summary="Ceilings across the workspace, and what is kept back for replies."
      busy={busy}
      onCancel={cancel}
      onSave={() => save({
        caps: {
          daily: Number(caps.daily) || 0,
          campaignDaily: Number(caps.campaignDaily) || 0,
          hourly: Number(caps.hourly) || 0,
        },
        followUpReserve: Number(rules.followUpReserve) || 0,
        minGapMinutes: Number(rules.minGapMinutes) || 0,
      }, 'Saved')}
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field id="cap-daily" label="A day, everything" hint="0 for no cap.">
          <input id="cap-daily" type="number" min="0" className="input w-28" value={caps.daily ?? 0}
            onChange={(e) => set({ caps: { ...caps, daily: e.target.value } })} />
        </Field>
        <Field id="cap-plan" label="A day, per plan">
          <input id="cap-plan" type="number" min="0" className="input w-28" value={caps.campaignDaily ?? 0}
            onChange={(e) => set({ caps: { ...caps, campaignDaily: e.target.value } })} />
        </Field>
        <Field id="cap-hour" label="An hour, per mailbox">
          <input id="cap-hour" type="number" min="0" className="input w-28" value={caps.hourly ?? 0}
            onChange={(e) => set({ caps: { ...caps, hourly: e.target.value } })} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        Each mailbox also has its own daily limit and its warm-up ramp, set on the Mailboxes page. The
        strictest of all of them wins.
      </p>
      <div className="flex flex-wrap items-end gap-4 border-t border-slate-200 pt-4">
        <Field id="reserve" label="Kept for follow-ups (%)" hint="New approaches stop once the day is down to this much; replies still go.">
          <input id="reserve" type="number" min="0" max="90" className="input w-28" value={rules.followUpReserve ?? 30}
            onChange={(e) => set({ followUpReserve: e.target.value })} />
        </Field>
        <Field id="mingap" label="Minutes between sends, at least" hint="0 leaves it to the randomised gap.">
          <input id="mingap" type="number" min="0" max="1440" className="input w-28" value={rules.minGapMinutes ?? 0}
            onChange={(e) => set({ minGapMinutes: e.target.value })} />
        </Field>
      </div>
    </Group>
  )
}

// ---- brakes -----------------------------------------------------------------

function BrakesGroup({ rules, set, save, cancel, busy }) {
  const b = rules.brakes || {}
  const [health, setHealth] = useState([])

  useEffect(() => {
    api.get('/api/send-health').then(setHealth).catch(() => { /* shown on Monitoring */ })
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
        <Field id="brake-abs" label="Bounces in a day that stop a mailbox" hint="0 turns this off. This is the one that protects a small sender.">
          <input id="brake-abs" type="number" min="0" className="input w-28" value={b.bounceAbsolute ?? 2}
            onChange={(e) => set({ brakes: { ...b, bounceAbsolute: e.target.value } })} />
        </Field>
        <Field id="brake-rate" label="Or a bounce rate above (%)" hint="Only applied once there are enough sends to mean anything.">
          <input id="brake-rate" type="number" min="0" max="100" step="0.5" className="input w-28" value={b.bounceRatePercent ?? 3}
            onChange={(e) => set({ brakes: { ...b, bounceRatePercent: e.target.value } })} />
        </Field>
      </div>
      {health.length > 0 && (
        <ul className="space-y-1 border-t border-slate-200 pt-3">
          {health.map((m) => (
            <li key={m.id} className="text-xs text-slate-500">
              <span className="text-slate-700">{m.email}</span> — {m.bounced} of the last {m.sample} bounced
              {m.last24h > 0 && <span className="text-amber-700"> · {m.last24h} in the last day</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">
        A stopped mailbox is held, not switched off: every plan sending from it pauses together, and you
        lift it once you have looked at the list.
      </p>
    </Group>
  )
}

// ---- the preview ------------------------------------------------------------

// The trust lever. Every setting above is a promise about the future, and a
// promise nobody can check is indistinguishable from a setting that does
// nothing — which is precisely what the campaign sending window used to be.
function SchedulePreview() {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.get('/api/send-preview?limit=12').then(setPreview).catch(setError)
  }, [])

  return (
    <Collapsible
      id="send-preview"
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

// ---- small shared bits ------------------------------------------------------

function dayLabel(days = []) {
  const sorted = days.slice().sort((a, b) => a - b)
  if (sorted.length === 7) return 'Every day'
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) return 'Weekdays'
  return sorted.map((d) => DAY_NAMES[d]).join(', ')
}

// Each group saves on its own. One page-wide Save would mean a user who came to
// change their hours also silently rewrites every other lever on the page.
//
// Every group is legible without touching it — the values are on screen in
// their own controls, disabled — and Edit is what makes them typeable. The
// question this page exists to answer is "what are my limits?", and it used to
// take four clicks to read them.
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

function Toggle({ on, onChange, label, hint }) {
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
