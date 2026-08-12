// Behaviour and Sending window.
//
// `PUT /api/campaigns/:id/settings` validates against a fixed allow-list: an
// unknown key is a 422 naming it. So this form offers exactly the keys the
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
import { Field, Panel, errorFor, messageOf } from './shared.jsx'

const DONT_OPEN = 'DONT_TRACK_EMAIL_OPEN'
const DONT_CLICK = 'DONT_TRACK_LINK_CLICK'
const DONT_REPLY = 'DONT_TRACK_REPLY_TO_AN_EMAIL'

const MS_HOUR = 3600e3
const MS_DAY = 86400e3

const NO_REPLY_SWITCH = [
  { value: 'sms', label: 'Switch to SMS' },
  { value: 'email', label: 'Switch to email' },
  { value: 'none', label: "Don't switch" },
]

// Engine defaults when the campaign has never set reply_handling.
const REPLY_DEFAULTS = {
  email: { noReplySwitchTo: 'sms', timeoutMs: 2 * MS_DAY },
  sms: { noReplySwitchTo: 'email', timeoutMs: 2 * MS_DAY },
}

function timeoutParts(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return { amount: 2, unit: 'days' }
  if (n === 0) return { amount: 0, unit: 'days' }
  if (n % MS_DAY === 0) return { amount: n / MS_DAY, unit: 'days' }
  if (n % MS_HOUR === 0) return { amount: n / MS_HOUR, unit: 'hours' }
  if (n >= MS_DAY) return { amount: Math.round((n / MS_DAY) * 10) / 10, unit: 'days' }
  return { amount: Math.max(1, Math.round(n / MS_HOUR)), unit: 'hours' }
}

function timeoutMsOf(amount, unit) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return 0
  return unit === 'hours' ? n * MS_HOUR : n * MS_DAY
}

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
  'email_subject', 'reply_handling',
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
  const setReplySide = (side, patch) => setForm((f) => {
    const rh = f.reply_handling || {}
    return {
      ...f,
      reply_handling: {
        ...rh,
        [side]: { ...(rh[side] || {}), ...patch },
      },
    }
  })

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
    for (const key of ['stop_lead_settings', 'send_as_plain_text', 'force_plain_text', 'unsubscribe_text', 'follow_up_percentage', 'email_subject']) {
      if (!same(form[key], saved[key])) out[key] = form[key]
    }
    if (!same([...(form.track_settings || [])].sort(), [...(saved.track_settings || [])].sort())) {
      out.track_settings = form.track_settings || []
    }
    if (!same(form.out_of_office_detection_settings, saved.out_of_office_detection_settings)) {
      out.out_of_office_detection_settings = form.out_of_office_detection_settings
    }
    if (!same(form.reply_handling, saved.reply_handling)) {
      out.reply_handling = form.reply_handling
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
            label="Email subject"
            htmlFor="cs-email-subject"
            hint="Used for all email steps in this campaign when set. Leave blank to keep the existing template/AI subject."
            error={errorFor(err, 'email_subject')}
          >
            <input
              id="cs-email-subject"
              className="input"
              maxLength={200}
              placeholder="Leave blank for template/AI subject"
              value={form.email_subject ?? ''}
              onChange={(e) => set({ email_subject: e.target.value })}
            />
          </Field>

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
            label={<>Share of leads that get follow-ups <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 align-middle">Not yet active</span></>}
            htmlFor="cs-followup"
            hint="Coming soon — the engine does not yet hold any audience back, so every lead runs the whole playbook regardless of this value."
            error={errorFor(err, 'follow_up_percentage')}
          >
            <div className="flex items-center gap-2">
              <input
                id="cs-followup"
                type="number"
                min="0"
                max="100"
                disabled
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
            {/* The reactivation controls below are not wired into the engine yet;
                shown disabled so the panel does not promise behaviour it can't
                deliver. Only "Do not count an auto-reply" above is enforced. */}
            <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Coming soon — not yet acted on by the engine
            </p>
            <label className="flex items-start gap-2 text-sm text-slate-400">
              <input type="checkbox" className="mt-0.5 accent-accent-500" disabled
                checked={Boolean(form.out_of_office_detection_settings?.autoCategorizeOOO)}
                onChange={(e) => setOoo({ autoCategorizeOOO: e.target.checked })} />
              <span>Label those replies as “out of office” automatically</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-400">
              <input type="checkbox" className="mt-0.5 accent-accent-500" disabled
                checked={Boolean(form.out_of_office_detection_settings?.autoReactivateOOO)}
                onChange={(e) => setOoo({ autoReactivateOOO: e.target.checked })} />
              <span>Pick the sequence back up when they are expected back</span>
            </label>
            <label className="block text-sm text-slate-400">
              <span className="text-xs text-slate-400">Wait this many days before picking it back up</span>
              <input
                type="number"
                min="0"
                max="90"
                disabled
                className="input mt-1 w-28"
                value={form.out_of_office_detection_settings?.reactivateOOOwithDelay ?? 0}
                onChange={(e) => setOoo({ reactivateOOOwithDelay: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium text-slate-700">When nobody replies</legend>
            <p className="text-[11px] text-slate-500">
              After the wait below with no reply, switch the next touch to another channel — or stay put.
            </p>
            {errorFor(err, 'reply_handling') && (
              <p className="text-[11px] text-red-700" role="alert">{errorFor(err, 'reply_handling')}</p>
            )}
            {['email', 'sms'].map((side) => {
              const sideCfg = form.reply_handling?.[side] || {}
              const fallback = REPLY_DEFAULTS[side]
              // Display falls back to defaults, but the first edit materialises
              // both sides so Save persists what the operator actually sees.
              const switchTo = sideCfg.noReplySwitchTo ?? fallback.noReplySwitchTo
              const timeoutMs = sideCfg.timeoutMs ?? fallback.timeoutMs
              const parts = timeoutParts(timeoutMs)
              const writeSide = (patch) => setForm((f) => {
                const current = f.reply_handling || {}
                const materialize = (key) => {
                  const cfg = current[key] || {}
                  const def = REPLY_DEFAULTS[key]
                  return {
                    noReplySwitchTo: cfg.noReplySwitchTo ?? def.noReplySwitchTo,
                    timeoutMs: cfg.timeoutMs ?? def.timeoutMs,
                  }
                }
                return {
                  ...f,
                  reply_handling: {
                    email: materialize('email'),
                    sms: materialize('sms'),
                    [side]: { ...materialize(side), ...patch },
                  },
                }
              })
              return (
                <div key={side} className="space-y-2">
                  <p className="text-xs text-slate-600">
                    After {side === 'email' ? 'an email' : 'an SMS'}
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block text-sm text-slate-700" htmlFor={`cs-reply-${side}-switch`}>
                      <span className="text-xs text-slate-600">If no reply</span>
                      <select
                        id={`cs-reply-${side}-switch`}
                        className="input mt-1 w-auto"
                        value={switchTo}
                        onChange={(e) => writeSide({ noReplySwitchTo: e.target.value })}
                      >
                        {NO_REPLY_SWITCH.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm text-slate-700" htmlFor={`cs-reply-${side}-wait`}>
                      <span className="text-xs text-slate-600">Wait</span>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          id={`cs-reply-${side}-wait`}
                          type="number"
                          min="0"
                          className="input w-24"
                          value={parts.amount}
                          onChange={(e) => writeSide({
                            timeoutMs: timeoutMsOf(e.target.value === '' ? 0 : Number(e.target.value), parts.unit),
                          })}
                        />
                        <select
                          id={`cs-reply-${side}-unit`}
                          className="input w-auto"
                          value={parts.unit}
                          aria-label={`${side} no-reply wait unit`}
                          onChange={(e) => writeSide({
                            timeoutMs: timeoutMsOf(parts.amount, e.target.value),
                          })}
                        >
                          <option value="days">days</option>
                          <option value="hours">hours</option>
                        </select>
                      </div>
                    </label>
                  </div>
                </div>
              )
            })}
          </fieldset>

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[11px] text-slate-500">
            <span className="text-slate-600">What the engine enforces right now:</span>{' '}
            opens {(saved.track_settings || []).includes(DONT_OPEN) ? 'off' : 'on'} ·
            clicks {(saved.track_settings || []).includes(DONT_CLICK) ? 'off' : 'on'} ·
            stops when {STOP_WHEN.find((s) => s.value === saved.stop_lead_settings)?.label || 'they reply'} ·
            {saved.send_as_plain_text ? ' plain text' : ' HTML'} ·
            opt-out wording {(saved.unsubscribe_text || '').trim() ? 'custom' : 'default'}
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
