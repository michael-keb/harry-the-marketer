// Warm-up: the settings a user may change, and the evidence that says whether
// it is working.
//
// The one relationship this panel exists to make visible is that a warm-up
// daily count can only ever *tighten* today's cap. `server/pacing.js` is the
// binding constraint and the warm-up count sits underneath it, so a user who
// types 40 on a mailbox whose ramp allows 15 today has changed nothing today —
// and being told that is the difference between a setting and a guess.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { ErrorState, Spinner, LiveRegion } from '../parity-ui.jsx'
import { Field, Section, Skeleton, Sparkline, StatusWord, fieldError, useAnnounce } from './common.jsx'

// The ranges the server enforces, stated here so the control can prevent an
// out-of-range value and the help text can say what the range is in words.
const COUNT = { min: 1, max: 50 }
const STEP = { min: 5, max: 20 }
const RATE = { min: 20, max: 100 }

const clamp = (n, { min, max }) => Math.min(max, Math.max(min, Number(n) || min))

// Three named paces so most people never open Advanced. They differ only in how
// fast the ramp climbs — the ceiling is always the mailbox's own daily limit.
const PACES = [
  { id: 'careful', label: 'Careful', step: 5, hint: 'Climbs 5 a day. Best for a brand-new domain.' },
  { id: 'standard', label: 'Standard', step: 10, hint: 'Climbs 10 a day. The usual choice.' },
  { id: 'fast', label: 'Fast', step: 20, hint: 'Climbs 20 a day. Only for a domain with history.' },
]

const paceOf = (step) => PACES.reduce((best, p) => (
  Math.abs(p.step - step) < Math.abs(best.step - step) ? p : best
), PACES[1])

export function WarmupSettings({ mailbox, onSaved }) {
  const wd = mailbox.warmupDetails || {}
  const dailyLimit = mailbox.messagePerDay
  const pacingCap = mailbox.sending?.pacingCap ?? dailyLimit

  // The detail response reports what *binds*, not the raw column, so "is the
  // override on" is read from whether it binds anywhere. The first save makes
  // it explicit and authoritative.
  const initialEnabled = wd.dailyCountToday < pacingCap || wd.warmupMaxCount < dailyLimit

  const initial = {
    enabled: Boolean(initialEnabled),
    dailyCount: clamp(Math.min(wd.warmupMaxCount || 20, COUNT.max), COUNT),
    rampEnabled: wd.rampEnabled !== false,
    // The stored default (2) sits below the range this route accepts, so the
    // control opens at the nearest value it is allowed to send.
    rampStep: clamp(wd.rampStep, STEP),
    targetReplyRate: clamp(wd.targetReplyRate, RATE),
    autoAdjust: Boolean(wd.autoAdjust),
  }
  const [form, setForm] = useState(initial)
  // What the server has actually confirmed, so a blur that changed nothing does
  // not become a write.
  const [committed, setCommitted] = useState(initial)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState('')
  const [announcement, say] = useAnnounce()

  if (wd.appliesTo === false) {
    return (
      <Section id="warmup-settings" title="Warm-up" hint={wd.note || 'Warm-up does not apply to sandbox mailboxes.'}>
        <p className="text-xs text-slate-600">
          A sandbox mailbox exists to be tested in seconds, so it skips the clock and the ramp. Its daily
          limit of {dailyLimit} still applies.
        </p>
      </Section>
    )
  }

  // The cap that will actually bind today, computed exactly as the server does:
  // the ramp first, the user's count only as a tighter ceiling on top of it.
  const countBelowLimit = Math.min(form.dailyCount, dailyLimit)
  const effectiveToday = form.enabled ? Math.max(1, Math.min(pacingCap, countBelowLimit)) : pacingCap
  const inert = form.enabled && form.dailyCount > pacingCap
  const ceiling = form.enabled ? Math.max(1, Math.min(dailyLimit, form.dailyCount)) : dailyLimit
  const daysToCeiling = form.rampEnabled && form.rampStep > 0
    ? Math.max(0, Math.ceil((ceiling - effectiveToday) / form.rampStep))
    : 0

  const plan = wd.isWarmupBlocked
    ? `Warm-up is not running — ${wd.blockedReason || 'the mailbox is not available'}.`
    : `Sending ${effectiveToday} a day` +
      (daysToCeiling > 0
        ? `, rising by ${form.rampStep} each day to ${ceiling} in about ${daysToCeiling} day${daysToCeiling === 1 ? '' : 's'}.`
        : ` — already at its ceiling of ${ceiling}.`)

  const save = async (patch) => {
    const next = { ...form, ...patch }
    setForm(next)
    setBusy(true)
    setError(null)
    setSaved('')
    try {
      const res = await api.put(`/api/mailboxes/${mailbox.id}/warmup`, {
        enabled: next.enabled,
        dailyCount: clamp(next.dailyCount, COUNT),
        rampEnabled: next.rampEnabled,
        rampStep: clamp(next.rampStep, STEP),
        targetReplyRate: clamp(next.targetReplyRate, RATE),
        autoAdjust: next.autoAdjust,
      })
      const data = res.data || {}
      const fresh = {
        enabled: Boolean(data.enabled),
        dailyCount: clamp(data.dailyCount, COUNT),
        rampEnabled: Boolean(data.rampEnabled),
        rampStep: clamp(data.rampStep, STEP),
        targetReplyRate: clamp(data.targetReplyRate, RATE),
        autoAdjust: Boolean(data.autoAdjust),
      }
      setForm(fresh)
      setCommitted(fresh)
      setSaved(`Saved — today's cap is ${data.effectiveDailyCap} of a possible ${data.dailyLimit}.`)
      say(`Warm-up saved. ${data.note || ''} Today's cap is ${data.effectiveDailyCap}.`)
      onSaved?.()
    } catch (err) {
      setError(err)
      say(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      id="warmup-settings"
      title="Warm-up"
      hint="Harry ramps every new Gmail mailbox on its own. These settings can slow that ramp down; nothing here can speed it past the mailbox's limit."
    >
      <LiveRegion message={announcement} />

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-emerald-500 cursor-pointer"
          checked={form.enabled}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>
          <span className="block text-sm text-ink-900">Use my own warm-up ceiling</span>
          <span className="block text-[11px] text-slate-500">
            Off means Harry's built-in ramp governs on its own: 10 a day to start, climbing to the limit
            over a fortnight.
          </span>
        </span>
      </label>

      {/* The relationship, in numbers, always visible — not a tooltip. */}
      <div className="mt-3 rounded-lg border border-slate-200 bg-white/40 px-3 py-2.5 text-xs text-slate-700">
        <p aria-live="polite" className="text-ink-900">{plan}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          <div><dt className="text-slate-500">Mailbox daily limit</dt><dd className="text-ink-900">{dailyLimit}</dd></div>
          <div><dt className="text-slate-500">Harry's ramp allows today</dt><dd className="text-ink-900">{pacingCap}</dd></div>
          <div><dt className="text-slate-500">Cap that binds today</dt><dd className="text-ink-900">{effectiveToday}</dd></div>
        </dl>
        {inert && (
          <p className="mt-2 text-amber-700">
            {form.dailyCount} is above today's ramp allowance of {pacingCap}, so it changes nothing today.
            Warm-up can only lower the cap, never raise it — the ramp still governs.
          </p>
        )}
        {form.dailyCount > dailyLimit && (
          <p className="mt-2 text-amber-700">
            A warm-up count cannot exceed the mailbox's daily limit of {dailyLimit}. Raise the limit first.
          </p>
        )}
      </div>

      <fieldset className="mt-4" disabled={busy || !form.enabled}>
        <legend className="text-xs font-medium text-slate-700 mb-1.5">Pace</legend>
        <div className="flex flex-wrap gap-2">
          {PACES.map((p) => (
            <label
              key={p.id}
              className={`flex-1 min-w-36 cursor-pointer rounded-lg border px-3 py-2 text-xs ${
                paceOf(form.rampStep).id === p.id ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-700'
              } ${!form.enabled ? 'opacity-50' : ''}`}
            >
              <input
                type="radio"
                name={`pace-${mailbox.id}`}
                className="sr-only"
                checked={paceOf(form.rampStep).id === p.id}
                onChange={() => save({ rampStep: p.step, rampEnabled: true })}
              />
              <span className="block font-medium text-sm">{p.label}</span>
              <span className="block text-[11px] opacity-80">{p.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className="mt-3 text-xs text-slate-600 hover:text-ink-900 cursor-pointer"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
      >
        {advanced ? 'Hide' : 'Show'} advanced figures
      </button>

      {advanced && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            id={`warmup-count-${mailbox.id}`}
            label="Warm-up emails a day"
            help={`Between ${COUNT.min} and ${COUNT.max}, and never above the mailbox's daily limit of ${dailyLimit}.`}
            error={fieldError(error, 'dailyCount')}
          >
            {({ id, describedBy }) => (
              <input
                id={id} type="number" className="input" inputMode="numeric"
                min={COUNT.min} max={Math.min(COUNT.max, dailyLimit)} value={form.dailyCount}
                aria-describedby={describedBy} disabled={busy || !form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, dailyCount: Number(e.target.value) }))}
                onBlur={(e) => {
                  const v = clamp(e.target.value, COUNT)
                  if (v !== committed.dailyCount) save({ dailyCount: v })
                  else setForm((f) => ({ ...f, dailyCount: v }))
                }}
              />
            )}
          </Field>

          <Field
            id={`warmup-step-${mailbox.id}`}
            label="Ramp step"
            help={`How many more each day. Between ${STEP.min} and ${STEP.max}.`}
            error={fieldError(error, 'rampStep')}
          >
            {({ id, describedBy }) => (
              <input
                id={id} type="number" className="input" inputMode="numeric"
                min={STEP.min} max={STEP.max} value={form.rampStep}
                aria-describedby={describedBy} disabled={busy || !form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, rampStep: Number(e.target.value) }))}
                onBlur={(e) => {
                  const v = clamp(e.target.value, STEP)
                  if (v !== committed.rampStep) save({ rampStep: v })
                  else setForm((f) => ({ ...f, rampStep: v }))
                }}
              />
            )}
          </Field>

          <Field
            id={`warmup-rate-${mailbox.id}`}
            label="Target reply rate (%)"
            help={`What the reputation score is measured against. Between ${RATE.min} and ${RATE.max}.`}
            error={fieldError(error, 'targetReplyRate')}
          >
            {({ id, describedBy }) => (
              <input
                id={id} type="number" className="input" inputMode="numeric"
                min={RATE.min} max={RATE.max} value={form.targetReplyRate}
                aria-describedby={describedBy} disabled={busy || !form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, targetReplyRate: Number(e.target.value) }))}
                onBlur={(e) => {
                  const v = clamp(e.target.value, RATE)
                  if (v !== committed.targetReplyRate) save({ targetReplyRate: v })
                  else setForm((f) => ({ ...f, targetReplyRate: v }))
                }}
              />
            )}
          </Field>

          <div className="space-y-2 self-end">
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox" className="size-4 accent-emerald-500 cursor-pointer"
                checked={form.rampEnabled} disabled={busy || !form.enabled}
                onChange={(e) => save({ rampEnabled: e.target.checked })}
              />
              Climb day by day
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox" className="size-4 accent-emerald-500 cursor-pointer"
                checked={form.autoAdjust} disabled={busy || !form.enabled}
                onChange={(e) => save({ autoAdjust: e.target.checked })}
              />
              Let Harry lower it if replies drop
            </label>
          </div>
        </div>
      )}

      {busy && <p className="mt-3 text-xs text-slate-600">Saving…</p>}
      {saved && !busy && <p className="mt-3 text-xs text-emerald-700">{saved}</p>}
      {error && !fieldError(error, 'dailyCount') && !fieldError(error, 'rampStep') && !fieldError(error, 'targetReplyRate') && (
        <p role="alert" className="mt-3 text-xs text-red-700">{error.message}</p>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- the chart --

export function WarmupStats({ mailbox }) {
  const [days, setDays] = useState(7)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.get(`/api/mailboxes/${mailbox.id}/warmup-stats?days=${days}`))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [mailbox.id, days])

  useEffect(() => { load() }, [load])

  const rangeControl = (
    <label className="text-xs text-slate-600">
      <span className="sr-only">Days of history</span>
      <select
        className="input w-auto py-1 text-xs cursor-pointer"
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
      >
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
      </select>
    </label>
  )

  if (loading && !data) {
    return (
      <Section id="warmup-stats" title="Warm-up performance" action={rangeControl}>
        <Skeleton rows={2} className="h-16" />
      </Section>
    )
  }
  if (error) {
    return (
      <Section id="warmup-stats" title="Warm-up performance" action={rangeControl}>
        <ErrorState error={error} onRetry={load} />
      </Section>
    )
  }

  const rows = data?.dailyStats || []

  if (!data?.warmupRunning) {
    return (
      <Section id="warmup-stats" title="Warm-up performance" action={rangeControl}>
        <p className="text-xs text-slate-600">
          {data?.message || 'Warm-up is not running for this mailbox, so there is nothing to measure yet.'}
        </p>
      </Section>
    )
  }
  if (!data.daysOfHistory) {
    return (
      <Section id="warmup-stats" title="Warm-up performance" action={rangeControl}>
        <p className="text-xs text-slate-600">
          Not enough history yet — this mailbox has no recorded warm-up days. Check back tomorrow.
        </p>
      </Section>
    )
  }

  const guidance = data.guidance || {}
  const verdict = guidance.healthy ? 'Building well' : 'Needs attention'

  return (
    <Section
      id="warmup-stats"
      title="Warm-up performance"
      hint={`Day buckets follow ${data.timezone}. A day with no activity is a zero, not a gap.`}
      action={rangeControl}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        <StatusWord ok={Boolean(guidance.healthy)}>{verdict}</StatusWord>
        <span className="text-slate-600">
          Reputation{' '}
          <span className="text-ink-950 font-medium">
            {data.reputationScore === null ? 'not scored yet' : `${data.reputationScore} / 100`}
          </span>
          {data.reputationScore !== null && <span className="text-slate-500"> (target {guidance.reputationTarget})</span>}
        </span>
        <span className="text-slate-600">Reply rate <span className="text-ink-950">{data.replyRate}%</span></span>
        <span className="text-slate-600">Spam <span className="text-ink-950">{guidance.spamRatePct}%</span></span>
      </div>
      <p className="mt-2 text-xs text-slate-600">{guidance.summary}</p>
      {Array.isArray(guidance.actions) && guidance.actions.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-xs text-amber-800 space-y-0.5">
          {guidance.actions.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Sparkline values={rows.map((r) => r.sent)} label={`Sent per day — ${data.totalSent} over ${rows.length} days`} />
        <Sparkline values={rows.map((r) => r.spam)} tone="danger" label={`Marked spam per day — ${data.spamCount} over ${rows.length} days`} />
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[26rem] text-left text-xs">
          <caption className="sr-only">
            Daily warm-up figures — the source of truth for the two charts above
          </caption>
          <thead>
            <tr className="text-slate-500">
              <th scope="col" className="py-1 pr-3 font-medium">Day</th>
              <th scope="col" className="py-1 pr-3 font-medium">Sent</th>
              <th scope="col" className="py-1 pr-3 font-medium">Inbox</th>
              <th scope="col" className="py-1 pr-3 font-medium">Spam</th>
              <th scope="col" className="py-1 pr-3 font-medium">Opened</th>
              <th scope="col" className="py-1 pr-3 font-medium">Replied</th>
              <th scope="col" className="py-1 font-medium">Reply rate</th>
            </tr>
          </thead>
          <tbody className="text-slate-700">
            {rows.map((r) => (
              <tr key={r.date} className="border-t border-slate-200">
                <th scope="row" className="py-1 pr-3 font-normal text-slate-600 whitespace-nowrap">{r.date}</th>
                <td className="py-1 pr-3">{r.sent}</td>
                <td className="py-1 pr-3">{r.delivered}</td>
                <td className="py-1 pr-3">{r.spam}</td>
                <td className="py-1 pr-3">{r.opened}</td>
                <td className="py-1 pr-3">{r.replied}</td>
                <td className="py-1">{r.replyRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <Spinner label="Refreshing…" />}
    </Section>
  )
}
