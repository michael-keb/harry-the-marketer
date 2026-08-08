// Shared plumbing for the campaign surfaces.
//
// The campaigns backlog pages everything server-side (Docs/README.md,
// "Unbounded requests are rejected"), and every one of its list routes answers
// `{ <rows>, total, limit, offset }` rather than the cursor shape
// parity-ui.jsx's `usePagedList` expects. So offset paging is written once here
// and shared, instead of each panel growing its own copy.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, qs } from '../api.js'

// ---------------------------------------------------------------- errors ----

// A 422 carries { error, field, message }; a 409 carries { error, message }.
// These read the payload the api.js wrapper already attached rather than
// re-parsing the sentence.
export const fieldOf = (err) => err?.payload?.field || ''
export const codeOf = (err) => err?.payload?.error || ''
export const blockersOf = (err) => err?.payload?.blockers || []
export const messageOf = (err) => String(err?.message || err || 'Something went wrong')

// The message belonging to one named field, or '' — so a form shows the
// validator's own sentence against the input it is about and nowhere else.
export function errorFor(err, field) {
  return err && fieldOf(err) === field ? messageOf(err) : ''
}

// ------------------------------------------------------------ offset list ---

// `pick` names the array in the response ('campaigns', 'leads', 'children'…).
// Pages append; a filter change starts again from offset 0.
export function useOffsetList(path, params = {}, { pick = 'items', limit = 25, enabled = true } = {}) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(null)
  const key = JSON.stringify(params)
  const seq = useRef(0)

  const fetchPage = useCallback(async (offset) => {
    if (!enabled) { setLoading(false); return }
    const id = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`${path}${qs({ ...JSON.parse(key), limit, offset })}`)
      if (id !== seq.current) return
      const rows = res?.[pick] ?? []
      setItems((prev) => (offset ? [...prev, ...rows] : rows))
      setTotal(res?.total ?? rows.length)
      setMeta(res)
    } catch (err) {
      if (id === seq.current) setError(err)
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [path, key, pick, limit, enabled])

  useEffect(() => { fetchPage(0) }, [fetchPage])

  return {
    items, total, meta, loading, error, setItems,
    hasMore: items.length < total,
    loadMore: () => fetchPage(items.length),
    reload: () => fetchPage(0),
  }
}

// A single GET with loading/error/reload, for the panels that are not lists.
export function useResource(path, { enabled = true } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!enabled) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try { setData(await api.get(path)) } catch (err) { setError(err) } finally { setLoading(false) }
  }, [path, enabled])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load, setData }
}

// ------------------------------------------------------------------ bits ----

export function Panel({ title, note, actions, children, id }) {
  return (
    <section className="card overflow-hidden" aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold text-ink-900">{title}</h2>
          {note && <p className="mt-1 max-w-2xl text-xs text-slate-500">{note}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

// Wide tables scroll inside their own container so the page never does.
export function TableScroll({ label, children }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

// A labelled control with the validator's message underneath it. `error` is the
// server's own sentence — never a paraphrase.
export function Field({ label, hint, error, htmlFor, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-600" htmlFor={htmlFor}>{label}</label>
      <div className="mt-1.5">{children}</div>
      {hint && !error && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-1.5 text-xs text-red-700" role="alert">{error}</p>}
    </div>
  )
}

export function SkeletonRows({ rows = 4, cols = 4 }) {
  return (
    <tbody aria-hidden>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-line last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-3"><div className="h-3 animate-pulse rounded-sm bg-slate-100" /></td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

// ---------------------------------------------------------------- labels ----

// The parity status vocabulary. START / PAUSED / STOPPED are what the backend
// accepts; DRAFT and ARCHIVED are states it reports but never takes.
export const STATE_TEXT = {
  START: 'Running',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
  ARCHIVED: 'Archived',
  DRAFT: 'Draft',
}

// Never colour alone: the word is always present, and the dot is decoration.
export function StateChip({ state }) {
  const { tone, dot } = {
    START: { tone: 'bg-accent-50 text-accent-700', dot: 'bg-accent-500' },
    PAUSED: { tone: 'bg-amber-50 text-amber-700', dot: 'bg-amber-400' },
    STOPPED: { tone: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
    ARCHIVED: { tone: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
    DRAFT: { tone: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  }[state] || { tone: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' }
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${tone}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {STATE_TEXT[state] || state}
    </span>
  )
}

export const nfmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '0')

export function pct(numerator, denominator) {
  if (!denominator) return '—'
  return `${Math.round((numerator / denominator) * 1000) / 10}%`
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The lead-engagement vocabulary the backend validates against.
export const ENGAGEMENTS = ['opened', 'clicked', 'replied', 'none', 'paused', 'completed', 'unsubscribed']

export const STAGES = ['not contacted', 'contacted', 'replied', 'agreed', 'won', 'lost', 'unsubscribed', 'bounced']
