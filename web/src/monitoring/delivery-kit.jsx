// Small shared pieces for the Monitoring → Inbox placement section.
//
// Everything here exists because the same idea repeats across eighteen report
// sections and must look and read the same in all of them: "is this figure
// current?", "has this ever been checked?", "is this request shape actually
// published by the provider?".
//
// Nothing in this file edits or duplicates the shared kit — it composes
// parity-ui.jsx and ui.jsx.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Spinner, ErrorState, StaleMark } from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'

// ------------------------------------------------------- request contracts ---

// GET /api/deliverability/providers reports `contracts.entries` — the nine
// upstream request shapes the source docs do not attest. The section puts them
// in this context so any control built on one can say so in place, rather than
// the honesty living in a single banner nobody reads twice.
export const ContractsCtx = createContext({ byKey: new Map(), count: 0 })

export function useContracts() { return useContext(ContractsCtx) }

// An inline "this shape is not confirmed" note, tied to a named UPSTREAM entry.
// Renders nothing when the backend reports that entry as verified, so a later
// correction to the contract table silently removes the warning.
export function Unverified({ contract, className = '' }) {
  const { byKey } = useContracts()
  const entry = byKey.get(contract)
  if (!entry) return null
  return (
    <p className={`mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 ${className}`} role="note">
      <span className="font-medium">Request shape not confirmed</span>
      {' — '}
      {entry.note || `The ${contract} request is Harry's best reading of a page that does not publish it.`}
      {entry.altMethod && (
        <span className="text-amber-700"> Sent as {entry.method}; {entry.altMethod} is retried once on a 405.</span>
      )}
    </p>
  )
}

// A short badge for a tab header, so a report built on an unpublished contract
// is flagged before it is opened as well as inside it.
export function UnverifiedTag({ contract }) {
  const { byKey } = useContracts()
  if (!byKey.has(contract)) return null
  return (
    <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700" title="This section is built on an upstream request shape the source documentation does not confirm">
      unverified
    </span>
  )
}

// ------------------------------------------------------------- lazy loading --

// Tab payloads are fetched when the tab is opened and not before: each tab body
// is mounted only while it is the active tab, so mounting is the trigger.
export function useLoad(url) {
  const [state, setState] = useState({ data: null, loading: true, error: null })

  const load = useCallback(() => {
    if (!url) { setState({ data: null, loading: false, error: null }); return }
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api.get(url).then(
      (data) => { if (live) setState({ data, loading: false, error: null }) },
      (error) => { if (live) setState({ data: null, loading: false, error }) },
    )
    return () => { live = false }
  }, [url])

  useEffect(() => { const stop = load(); return stop }, [load])

  return { ...state, reload: load }
}

// ------------------------------------------------------------- 422 handling --

// The parity routes answer a 422 with { error, field, message }. The message is
// the sentence meant for a person, and it belongs against the field it names.
export function fieldError(err, field) {
  const p = err?.payload
  if (!p || !p.field || p.field !== field) return null
  return p.message || 'That value was rejected.'
}

// Whatever the error was not about a named field — shown once at the top of a
// form so nothing is swallowed.
export function formError(err) {
  if (!err) return null
  if (err.payload?.field) return null
  return err.message || 'Something went wrong.'
}

export function FieldNote({ error }) {
  if (!error) return null
  return <p className="mt-1 text-xs text-red-700" role="alert">{error}</p>
}

// ------------------------------------------------------------------ honesty --

// Every report envelope carries `available`, `stale` and `fetchedAt`. A report
// that has never been fetched says so in words; it is never drawn as zeroes.
export function Freshness({ res, noun = 'report' }) {
  if (!res) return null
  if (!res.available) {
    return (
      <p className="text-xs text-slate-500">
        No {noun} data has been recorded for this run yet — nothing here is a result.
      </p>
    )
  }
  if (res.stale) return <StaleMark at={res.fetchedAt} />
  return <span className="text-[11px] text-slate-400">Refreshed {timeAgo(res.fetchedAt)}</span>
}

// The backend deliberately answers { totalBlacklist: null, state: 'pending' }
// where nothing has been checked. Rendering that as 0 would read as a clean
// bill of health, so it reads as "not checked yet" instead.
export function Blocklist({ blacklist }) {
  const state = blacklist?.state
  if (!blacklist || state === 'pending' || blacklist.totalBlacklist === null || blacklist.totalBlacklist === undefined) {
    return <span className="text-slate-500" title="No blocklist check has been recorded — this is not a clean result">not checked yet</span>
  }
  if (state === 'clear' || blacklist.totalBlacklist === 0) {
    return <span className="text-emerald-700">clear <span className="text-slate-500">(0 listings)</span></span>
  }
  const n = blacklist.totalBlacklist
  return <span className="text-red-700">listed <span className="text-slate-600">({n} listing{n === 1 ? '' : 's'})</span></span>
}

// A verdict is never colour alone: the word is the status, the colour repeats it.
export function Verdict({ pass, passLabel = 'pass', failLabel = 'fail', unknownLabel = 'not reported' }) {
  if (pass === null || pass === undefined) {
    return <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600">{unknownLabel}</span>
  }
  return pass
    ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">{passLabel}</span>
    : <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">{failLabel}</span>
}

const STATUS_CLS = {
  draft: 'bg-slate-200/40 text-slate-700',
  scheduled: 'bg-sky-50 text-sky-700',
  active: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-slate-200/40 text-slate-700',
  stopped: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
}

export function StatusChip({ value }) {
  const cls = STATUS_CLS[value] || 'bg-slate-200/40 text-slate-700'
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{value || 'unknown'}</span>
}

// ------------------------------------------------------------- formatting ----

// Times are shown in the browser's timezone, matching how the sending rhythm
// already reports them everywhere else in Harry.
export function localTime(iso) {
  if (!iso) return null
  const at = new Date(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

// A rate is stored as 0..1. Null means "not measured" and is shown as an em dash
// rather than 0%.
export function pct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return `${(Number(value) * 100).toFixed(digits)}%`
}

export function num(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toLocaleString()
}

// The cadence, in words. `every_days` is null on a manual test and the word
// "null" must never reach the screen.
export function cadence(test) {
  if (!test || test.type !== 'automated' || !test.everyDays) return null
  const run = Number(test.currentRunNo) || 0
  const every = test.everyDays === 1 ? 'every day' : `every ${test.everyDays} days`
  return run > 0 ? `${every}, run ${run}` : every
}

// ------------------------------------------------------------- containers ----

// A wide table always scrolls inside its own box; the page itself never scrolls
// sideways, at 375px or anywhere else.
export function Scroller({ children, label }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1" tabIndex={0} role="group" aria-label={label}>
      <div className="min-w-full">{children}</div>
    </div>
  )
}

export function Panel({ title, hint, right, children }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-700">
          {title}
          {hint && <span className="ml-2 text-xs font-normal text-slate-500">{hint}</span>}
        </h4>
        {right}
      </div>
      {children}
    </section>
  )
}

// One place decides what a loading, failed or absent tab body looks like.
export function Async({ state, label, children, onRetry }) {
  if (state.loading && !state.data) return <Spinner label={label || 'Loading…'} />
  if (state.error) return <ErrorState error={state.error} onRetry={onRetry || state.reload} />
  if (!state.data) return <p className="text-sm text-slate-500">Nothing to show.</p>
  return children(state.data)
}

export function Nothing({ children }) {
  return <p className="text-sm text-slate-500">{children}</p>
}
