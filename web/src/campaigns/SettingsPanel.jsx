// Behaviour and Sending window.
//
// `PUT /api/campaigns/:id/settings` validates against a fixed allow-list: an
// unknown key is a 422 naming it. So this form offers exactly the eight keys the
// backend accepts and sends only the ones that changed — there is nothing here
// the server will reject, and nothing the server accepts that is hidden.
//
// No raw constant name reaches the screen. `DONT_TRACK_EMAIL_OPEN` is a
// checkbox that reads "Record when someone opens an email", and every control
// carries the consequence of turning it off as described text.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { LiveRegion } from '../parity-ui.jsx'
import { useToast } from '../ui.jsx'
import { Field, Panel, DAY_NAMES, errorFor, messageOf } from './shared.jsx'

const DONT_OPEN = 'DONT_TRACK_EMAIL_OPEN'
const DONT_CLICK = 'DONT_TRACK_LINK_CLICK'
const DONT_REPLY = 'DONT_TRACK_REPLY_TO_AN_EMAIL'

// The day pills show the short name and read out the long one, so both forms
// are needed here. Indexes match `DAY_NAMES` (0 = Sunday), which is what the
// schedule API stores in `days`.
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Suggestions for the timezone box only — it stays a free-text input backed by
// a datalist, because the server accepts any IANA zone and the browser's own
// zone is offered first.
const COMMON_ZONES = [
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth',
  'Pacific/Auckland', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata', 'UTC',
]

const STOP_WHEN = [
  { value: 'REPLY_TO_AN_EMAIL', label: 'they reply to an email' },
  { value: 'OPEN_AN_EMAIL', label: 'they open an email' },
  { value: 'CLICK_ON_A_LINK', label: 'they click a link' },
]

const TRACKING = [
  {
    flag: DONT_OPEN,
    label: 'Record when someone opens an email',
    consequence: 'Turning this off means Reports cannot show an open rate for this campaign — it will say "not tracked" rather than 0%.',
  },
  {
    flag: DONT_CLICK,
    label: 'Record when someone clicks a link',
    consequence: 'Turning this off removes click wrapping from links in this campaign, and the click rate stops being measurable.',
  },
  {
    flag: DONT_REPLY,
    label: 'Treat a reply as a signal to stop emailing',
    consequence: 'Turning this off means a lead who answers keeps receiving the rest of the playbook.',
  },
]

// The fields that have a control of their own, so a 422 naming one of them is
// shown there rather than repeated at the bottom of the form.
const NAMED_FIELDS = [
  'name', 'track_settings', 'stop_lead_settings', 'unsubscribe_text',
  'follow_up_percentage', 'out_of_office_detection_settings',
]

export function BehaviourPanel({ campaign, onSaved }) {
  const toast = useToast()
  const saved = campaign.settings
  const [form, setForm] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState('')

  useEffect(() => { setForm(campaign.settings) }, [campaign.settings])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setOoo = (patch) => setForm((f) => ({ ...f, out_of_office_detection_settings: { ...f.out_of_office_detection_settings, ...patch } }))

  const trackOn = (flag) => !(form.track_settings || []).includes(flag)
  const toggleTrack = (flag, on) => set({
    track_settings: on
      ? (form.track_settings || []).filter((v) => v !== flag)
      : [...new Set([...(form.track_settings || []), flag])],
  })

  // Only what actually changed travels, so a save never touches a key the user
  // did not look at.
  const changed = useMemo(() => {
    const out = {}
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    if (form.name !== undefined && form.name !== campaign.name) out.name = form.name
    for (const key of ['stop_lead_settings', 'send_as_plain_text', 'force_plain_text', 'unsubscribe_text', 'follow_up_percentage']) {
      if (!same(form[key], saved[key])) out[key] = form[key]
    }
    if (!same([...(form.track_settings || [])].sort(), [...(saved.track_settings || [])].sort())) {
      out.track_settings = form.track_settings || []
    }
    if (!same(form.out_of_office_detection_settings, saved.out_of_office_detection_settings)) {
      out.out_of_office_detection_settings = form.out_of_office_detection_settings
    }
    return out
  }, [form, saved, campaign.name])

  const dirty = Object.keys(changed).length > 0

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.put(`/api/campaigns/${campaign.id}/settings`, changed)
      setNote('Settings updated successfully')
      toast('Behaviour saved')
      await onSaved?.()
    } catch (error) {
      setErr(error)
      toast(messageOf(error), 'error')
    } finally { setBusy(false) }
  }

  const summary = [
    trackOn(DONT_OPEN) ? 'opens tracked' : 'opens not tracked',
    trackOn(DONT_CLICK) ? 'clicks tracked' : 'clicks not tracked',
    `stops when ${STOP_WHEN.find((s) => s.value === form.stop_lead_settings)?.label || 'they reply'}`,
    form.send_as_plain_text ? 'plain text' : 'HTML',
  ].join(', ')

  return (
    <Panel id="behaviour" title="Behaviour" note={`Currently: ${summary}.`}>
      <details className="group">
        <summary className="cursor-pointer list-none text-sm text-accent-700 hover:underline">
          <span className="group-open:hidden">Show behaviour settings</span>
          <span className="hidden group-open:inline">Hide behaviour settings</span>
        </summary>

        <div className="mt-4 space-y-5">
          <Field label="Campaign name" htmlFor="cs-name" error={errorFor(err, 'name')}>
            <input
              id="cs-name"
              className="input"
              value={form.name ?? campaign.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-slate-700">What this campaign records</legend>
            {errorFor(err, 'track_settings') && (
              <p className="text-[11px] text-red-700" role="alert">{errorFor(err, 'track_settings')}</p>
            )}
            {TRACKING.map((t) => (
              <label key={t.flag} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-accent-500"
                  checked={trackOn(t.flag)}
                  aria-describedby={`why-${t.flag}`}
                  onChange={(e) => toggleTrack(t.flag, e.target.checked)}
                />
                <span>
                  {t.label}
                  <span id={`why-${t.flag}`} className="mt-0.5 block text-[11px] text-slate-500">{t.consequence}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Field
            label="Stop emailing a lead when…"
            htmlFor="cs-stop"
            hint="The playbook still decides what happens next; this is the signal that ends the sequence for that person."
            error={errorFor(err, 'stop_lead_settings')}
          >
            <select
              id="cs-stop"
              className="input w-auto"
              value={form.stop_lead_settings}
              onChange={(e) => set({ stop_lead_settings: e.target.value })}
            >
              {STOP_WHEN.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-slate-700">How emails are written</legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500" checked={Boolean(form.send_as_plain_text)}
                aria-describedby="why-plain" onChange={(e) => set({ send_as_plain_text: e.target.checked })} />
              <span>
                Send as plain text
                <span id="why-plain" className="mt-0.5 block text-[11px] text-slate-500">
                  Plain text often lands better, but link clicks cannot be measured without HTML.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500" checked={Boolean(form.force_plain_text)}
                aria-describedby="why-force" onChange={(e) => set({ force_plain_text: e.target.checked })} />
              <span>
                Never fall back to HTML
                <span id="why-force" className="mt-0.5 block text-[11px] text-slate-500">
                  Even where an HTML version would normally be attached, only the plain-text body is sent.
                </span>
              </span>
            </label>
          </fieldset>

          <Field
            label="Opt-out wording"
            htmlFor="cs-unsub"
            hint="Leave it empty to use Harry's default wording. An email with no way to opt out is never sent, so this line cannot be removed — only changed."
            error={errorFor(err, 'unsubscribe_text')}
          >
            <input
              id="cs-unsub"
              className="input"
              placeholder="Reply STOP and I won't write again."
              value={form.unsubscribe_text || ''}
              onChange={(e) => set({ unsubscribe_text: e.target.value })}
            />
          </Field>
          <p className="-mt-3 text-[11px] text-slate-500">
            Preview: “{(form.unsubscribe_text || '').trim() || 'Reply STOP and I won’t write again.'}”
          </p>

          <Field
            label="Share of leads that get follow-ups"
            htmlFor="cs-followup"
            hint="100 means every lead runs the whole playbook. Lower it to hold part of the audience back."
            error={errorFor(err, 'follow_up_percentage')}
          >
            <div className="flex items-center gap-2">
              <input
                id="cs-followup"
                type="number"
                min="0"
                max="100"
                className="input w-28"
                value={form.follow_up_percentage}
                onChange={(e) => set({ follow_up_percentage: e.target.value === '' ? '' : Number(e.target.value) })}
              />
              <span className="text-sm text-slate-600">per cent</span>
            </div>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-slate-700">Out-of-office replies</legend>
            {errorFor(err, 'out_of_office_detection_settings') && (
              <p className="text-[11px] text-red-700" role="alert">{errorFor(err, 'out_of_office_detection_settings')}</p>
            )}
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500"
                checked={Boolean(form.out_of_office_detection_settings?.ignoreOOOasReply)}
                onChange={(e) => setOoo({ ignoreOOOasReply: e.target.checked })} />
              <span>Do not count an auto-reply as a real reply</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500"
                checked={Boolean(form.out_of_office_detection_settings?.autoCategorizeOOO)}
                onChange={(e) => setOoo({ autoCategorizeOOO: e.target.checked })} />
              <span>Label those replies as “out of office” automatically</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500"
                checked={Boolean(form.out_of_office_detection_settings?.autoReactivateOOO)}
                onChange={(e) => setOoo({ autoReactivateOOO: e.target.checked })} />
              <span>Pick the sequence back up when they are expected back</span>
            </label>
            <label className="block text-sm text-slate-700">
              <span className="text-xs text-slate-600">Wait this many days before picking it back up</span>
              <input
                type="number"
                min="0"
                max="90"
                className="input mt-1 w-28"
                value={form.out_of_office_detection_settings?.reactivateOOOwithDelay ?? 0}
                onChange={(e) => setOoo({ reactivateOOOwithDelay: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            </label>
          </fieldset>

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[11px] text-slate-500">
            <span className="text-slate-600">What the engine reads right now:</span>{' '}
            opens {saved.track_opens ? 'on' : 'off'} · clicks {saved.track_clicks ? 'on' : 'off'} ·
            stop on reply {saved.stop_on_reply ? 'on' : 'off'}
            {saved.tracking_domain ? ` · tracking domain ${saved.tracking_domain}` : ''}
            {saved.reply_to ? ` · replies go to ${saved.reply_to}` : ''}
          </div>

          {campaign.state === 'START' && dirty && (
            <p className="text-xs text-amber-700">
              This campaign is running. Leads part-way through a step finish it under the old settings; the change
              applies from the next step onwards.
            </p>
          )}
          {/* A 422 already shows against its own field; anything else is said here. */}
          {err && !NAMED_FIELDS.includes(err?.payload?.field) && (
            <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button className="btn-ghost cursor-pointer" disabled={!dirty || busy} onClick={() => setForm(saved)}>Discard</button>
            <button className="btn-primary cursor-pointer" disabled={!dirty || busy} onClick={save}>
              {busy ? 'Saving…' : dirty ? 'Save behaviour' : 'Saved'}
            </button>
          </div>
          <LiveRegion message={note} />
        </div>
      </details>
    </Panel>
  )
}

function scheduleSentence(s) {
  if (!s) return ''
  const days = (s.days || []).slice().sort()
  const weekdays = [1, 2, 3, 4, 5]
  const label = days.length === 7
    ? 'Every day'
    : days.length === 5 && weekdays.every((d) => days.includes(d))
      ? 'Weekdays'
      : days.map((d) => DAY_NAMES[d]).join(', ') || 'No days selected'
  const gap = s.min_gap_minutes
    ? `, at least ${s.min_gap_minutes >= 60 ? `${Math.round(s.min_gap_minutes / 60)} hour${s.min_gap_minutes >= 120 ? 's' : ''}` : `${s.min_gap_minutes} minutes`} apart`
    : ''
  return `${label}, ${s.start_hour}–${s.end_hour}${s.timezone ? `, ${s.timezone.replace('_', ' ')} time` : ''}${gap}`
}

export function SchedulePanel({ campaign, onSaved }) {
  const toast = useToast()
  const saved = campaign.schedule
  const [form, setForm] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState('')

  useEffect(() => { setForm(campaign.schedule) }, [campaign.schedule])

  const browserZone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
  }, [])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const toggleDay = (d, on) => set({
    days: on ? [...new Set([...(form.days || []), d])].sort() : (form.days || []).filter((x) => x !== d),
  })

  const dirty = JSON.stringify(form) !== JSON.stringify(saved)

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.put(`/api/campaigns/${campaign.id}/schedule`, {
        timezone: form.timezone || '',
        days: form.days,
        start_hour: form.start_hour,
        end_hour: form.end_hour,
        min_gap_minutes: Number(form.min_gap_minutes) || 0,
      })
      setNote(`Sending window saved — ${scheduleSentence(res.schedule)}`)
      toast('Sending window saved')
      await onSaved?.()
    } catch (error) {
      setErr(error)
      toast(messageOf(error), 'error')
    } finally { setBusy(false) }
  }

  return (
    <Panel
      id="schedule"
      title="Sending window"
      note={
        <>
          {scheduleSentence(saved)}
          {saved?.isDefault && <span className="ml-1 text-slate-600">— inherited from your workspace default</span>}
        </>
      }
    >
      <details className="group">
        <summary className="cursor-pointer list-none text-sm text-accent-700 hover:underline">
          <span className="group-open:hidden">Change the sending window</span>
          <span className="hidden group-open:inline">Hide the sending window</span>
        </summary>

        <div className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">Days it may send</legend>
            {errorFor(err, 'days') && <p className="mt-1 text-[11px] text-red-700" role="alert">{errorFor(err, 'days')}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {FULL_DAYS.map((name, index) => {
                const on = (form.days || []).includes(index)
                return (
                  <label
                    key={name}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
                      on ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent-500"
                      checked={on}
                      onChange={(e) => toggleDay(index, e.target.checked)}
                    />
                    <span aria-hidden>{DAY_NAMES[index]}</span>
                    <span className="sr-only">{name}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-3">
            <Field label="Earliest send (24-hour, HH:MM)" htmlFor="sc-start" error={errorFor(err, 'start_hour')}>
              <input id="sc-start" type="time" className="input w-36" value={form.start_hour || ''}
                onChange={(e) => set({ start_hour: e.target.value })} />
            </Field>
            <Field label="Latest send (24-hour, HH:MM)" htmlFor="sc-end" error={errorFor(err, 'end_hour')}>
              <input id="sc-end" type="time" className="input w-36" value={form.end_hour || ''}
                onChange={(e) => set({ end_hour: e.target.value })} />
            </Field>
            <Field
              label="Minimum gap between emails"
              htmlFor="sc-gap"
              hint="Minutes. Zero lets the sending rhythm decide."
              error={errorFor(err, 'min_gap_minutes')}
            >
              <input id="sc-gap" type="number" min="0" max="1440" className="input w-28"
                value={form.min_gap_minutes ?? 0}
                onChange={(e) => set({ min_gap_minutes: e.target.value === '' ? 0 : Number(e.target.value) })} />
            </Field>
          </div>

          <Field
            label="Timezone"
            htmlFor="sc-tz"
            hint={browserZone ? `Your browser says ${browserZone}. Leave it empty to follow the workspace default.` : 'An IANA zone such as Australia/Sydney.'}
            error={errorFor(err, 'timezone')}
          >
            <input
              id="sc-tz"
              className="input"
              list="campaign-timezones"
              placeholder={browserZone || 'Australia/Sydney'}
              value={form.timezone || ''}
              onChange={(e) => set({ timezone: e.target.value })}
            />
            <datalist id="campaign-timezones">
              {[browserZone, ...COMMON_ZONES].filter(Boolean).filter((z, i, a) => a.indexOf(z) === i)
                .map((z) => <option key={z} value={z} />)}
            </datalist>
          </Field>

          {campaign.state === 'START' && dirty && (
            <p className="text-xs text-amber-700">This campaign is running — the new window applies from the next send onwards.</p>
          )}
          <p className="text-xs text-slate-500">
            This window can only narrow your workspace hours, never widen them. If the two do not overlap,
            nothing sends — and the campaign header says so rather than going quiet.
          </p>
          {err && !['days', 'start_hour', 'end_hour', 'min_gap_minutes', 'timezone'].includes(err?.payload?.field) && (
            <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">{scheduleSentence(form)}</span>
            <div className="flex gap-2">
              <button className="btn-ghost cursor-pointer" disabled={!dirty || busy} onClick={() => setForm(saved)}>Discard</button>
              <button className="btn-primary cursor-pointer" disabled={!dirty || busy} onClick={save}>
                {busy ? 'Saving…' : dirty ? 'Save window' : 'Saved'}
              </button>
            </div>
          </div>
          <LiveRegion message={note} />
        </div>
      </details>

      <p className="mt-4 border-t border-slate-200 pt-4 text-xs text-slate-500">
        See the block grid on the <strong className="font-medium text-slate-700">Schedule</strong> tab of this campaign.
      </p>
    </Panel>
  )
}
