// Shared components for the SmartLead-parity surfaces.
//
// The backlog's standing rule is that a new feature should not cost a new thing
// to think about: 203 of its 210 endpoints fit an existing surface and no file
// anywhere proposes a new navigation item. That only holds if the same idea
// looks the same everywhere — one label chip, one picker, one paged table, one
// honest "not connected" banner — so those live here rather than in each page.
//
// Everything follows the accessibility rules the specs repeat: a chip is never
// colour alone, a picker is a real listbox, changes are announced politely, and
// anything that is a bottom sheet under 640px says so.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from './api.js'
import { Icon, Modal, Spinner, EmptyState, ErrorState, useToast } from './ui.jsx'

// ------------------------------------------------------------- envelopes ----

// The API answers a list in one of two shapes: `{ items, nextCursor, hasMore }`
// or `{ ok, data, nextCursor, hasMore }`. Both are reasonable and both are in
// use, so every consumer here goes through one unwrapper rather than each page
// guessing — guessing is how a picker ends up calling .map on a response object.
export function rowsOf(res) {
  if (Array.isArray(res)) return res
  if (!res || typeof res !== 'object') return []
  for (const key of ['items', 'data', 'rows']) {
    if (Array.isArray(res[key])) return res[key]
  }
  // Some routes name the collection after the thing in it — `{ campaigns }`,
  // `{ tasks }`. Rather than grow the list above every time one turns up (and
  // silently return [] until someone notices), take the first array-valued
  // property. Meta fields on these envelopes are counts, cursors and flags,
  // never arrays, so there is nothing else it could pick up by mistake.
  for (const value of Object.values(res)) {
    if (Array.isArray(value)) return value
  }
  return []
}

// ---------------------------------------------------------------- labels ----

// A label is identifiable without seeing colour: the name is always text, and
// the colour is a dot beside it rather than the background.
export function TagChip({ tag, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11.5px] font-medium text-slate-700">
      <span className="size-1.5 rounded-full" style={{ background: tag.color || '#5d7893' }} aria-hidden />
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(tag)}
          className="ml-0.5 text-slate-500 hover:text-red-600 cursor-pointer"
          aria-label={`Remove label ${tag.name}`}
        >
          ×
        </button>
      )}
    </span>
  )
}

// Searchable multi-select over the workspace's labels. `selected` is a list of
// tag ids. Toggling disables only the item being toggled, never the whole
// picker, so tagging fifty rows does not feel like a page freeze.
export function TagPicker({ appliesTo = 'lead', selected = [], onToggle, onCreate, busyId = null }) {
  const [tags, setTags] = useState(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    api.get(`/api/tags${qs({ appliesTo })}`)
      .then((r) => setTags(rowsOf(r)))
      .catch(setError)
  }, [appliesTo])

  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const list = tags || []
    const q = query.trim().toLowerCase()
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list
  }, [tags, query])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!tags) return <Spinner label="Loading labels…" />

  const exact = shown.some((t) => t.name.toLowerCase() === query.trim().toLowerCase())

  return (
    <div>
      <input
        className="input mb-2"
        placeholder="Search labels…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search labels"
      />
      <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto space-y-1">
        {shown.map((tag) => {
          const on = selected.includes(tag.id)
          return (
            <li key={tag.id}>
              <button
                type="button"
                role="option"
                aria-selected={on}
                disabled={busyId === tag.id}
                onClick={() => onToggle(tag, !on)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                <span className={`flex size-4 items-center justify-center rounded-sm border ${on ? 'border-accent-600 bg-accent-600 text-white' : 'border-slate-300'}`}>
                  {on && <Icon name="check" className="size-3" />}
                </span>
                <span className="size-1.5 rounded-full" style={{ background: tag.color || '#5d7893' }} aria-hidden />
                {tag.name}
              </button>
            </li>
          )
        })}
        {shown.length === 0 && (
          <li className="px-2 py-3 text-sm text-slate-500">No labels match “{query}”.</li>
        )}
      </ul>
      {onCreate && query.trim() && !exact && (
        <button
          type="button"
          className="btn-ghost mt-2 w-full justify-center"
          onClick={() => onCreate(query.trim()).then(() => { setQuery(''); load() })}
        >
          Create label “{query.trim()}”
        </button>
      )}
    </div>
  )
}

// -------------------------------------------------------------- honesty -----

// Shown wherever a surface depends on an optional provider that is not wired
// up. It says what is missing and what to set, and the surface below it still
// renders whatever Harry stores itself.
export function NotConnected({ status, what }) {
  if (!status || status.configured) return null
  return (
    <div className="card mb-4 border-amber-200 bg-amber-50 px-4 py-3.5 text-sm text-amber-800" role="status">
      <div className="font-semibold">{what} is not connected.</div>
      <div className="mt-1 text-amber-700">
        Set {(status.envVars || []).join(' and ')} in your environment to pull live data.
        Everything already stored here still works.
      </div>
    </div>
  )
}

// A value the server could not refresh. Never silently shown as current.
export function StaleMark({ at }) {
  if (!at) return null
  return (
    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] text-amber-700" title={`Last refreshed ${at}`}>
      may be out of date
    </span>
  )
}

// ------------------------------------------------------------ paged table ---

// Keyset paging, because several E2E tickets assert the list stays stable when
// a row is inserted mid-scroll — which offset paging cannot promise.
export function usePagedList(path, params = {}, deps = []) {
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const key = JSON.stringify(params)

  const fetchPage = useCallback(async (nextCursor) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`${path}${qs({ ...params, cursor: nextCursor || undefined })}`)
      const rows = rowsOf(res)
      setItems((prev) => (nextCursor ? [...prev, ...rows] : rows))
      setCursor(res.nextCursor ?? null)
      setHasMore(Boolean(res.hasMore ?? res.nextCursor))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [path, key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchPage(null) }, [fetchPage, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    items, loading, error, hasMore,
    loadMore: () => cursor && fetchPage(cursor),
    reload: () => fetchPage(null),
    setItems,
  }
}

export function LoadMore({ hasMore, loading, onClick }) {
  if (!hasMore) return null
  return (
    <div className="flex justify-center py-4">
      <button className="btn-ghost" onClick={onClick} disabled={loading}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}

// ------------------------------------------------------------------ bits ----

// The one tab row in the product: labels sitting on a single rule, the active
// one carrying a 2px accent underline. `.tab-row` / `.tab` are in index.css so
// the handful of places that render tabs without this component still match.
export function Tabs({ tabs, active, onChange, ariaLabel = 'Sections', variant = 'underline' }) {
  // `variant="chips"` is for a tab strip nested under another one — see the
  // Replies views, which sit beneath the Inbox's own two tabs.
  const chips = variant === 'chips'
  return (
    <div className={`${chips ? 'chip-row' : 'tab-row'} mb-6`} role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={chips ? 'chip' : 'tab'}
        >
          <span>{t.label}</span>
          {typeof t.count === 'number' && (
            <>
              {/* The pill is decorative; the number belongs in the name, or a
                  screen reader reads the tab as "Leads0". */}
              <span aria-hidden className="tab-count">{t.count}</span>
              <span className="sr-only">{` (${t.count})`}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}

// A from/to pair. Nearly every analytics endpoint takes the same two, so the
// control that produces them is written once.
export function DateRange({ value, onChange }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="text-slate-600">
        From
        <input
          type="date" className="input mt-1" value={value.from || ''}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </label>
      <label className="text-slate-600">
        To
        <input
          type="date" className="input mt-1" value={value.to || ''}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </label>
    </div>
  )
}

// Irreversible actions confirm first. The confirm label repeats the verb so a
// dialog never reads "Are you sure? [OK]".
export function Confirm({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-slate-700">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className={danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await onConfirm() } finally { setBusy(false) }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

// A right-hand detail panel. Under 640px it becomes a full-height sheet, which
// is what the responsive notes in the frontend stories ask for.
const DRAWER_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Drawer({ title, onClose, children, footer }) {
  const panelRef = useRef(null)
  const returnToRef = useRef(null)

  // `onClose` is a fresh arrow at nearly every call site, so depending on it
  // re-ran this effect on every render — and its last act is to focus the first
  // control. The visible symptom was that you could type exactly one character
  // into a modal's textarea before focus jumped to Close. Held in a ref so the
  // effect is mount-only and the latest handler is still the one that fires.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    returnToRef.current = document.activeElement
    const panel = panelRef.current
    ;(panel?.querySelector(DRAWER_FOCUSABLE) || panel)?.focus()

    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab' || !panel) return
      // Without a trap the drawer is a panel that happens to float: Tab walks
      // out into the page it is covering and there is no way back.
      const items = [...panel.querySelectorAll(DRAWER_FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const back = returnToRef.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-40 flex justify-end" style={{ background: 'rgba(11,22,34,0.42)' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panelRef} tabIndex={-1} className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white" role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
          <button className="cursor-pointer text-xl leading-none text-slate-400 hover:text-ink-900" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="card-sub border-t border-line px-6 py-4">{footer}</footer>}
      </aside>
    </div>
  )
}

// The bulk action bar the Leads table and the Inbox both need. It only exists
// when rows are ticked, which is what keeps it off the screen the rest of the
// time — the mitigation every "Bloat risk: Medium" row in the specs relies on.
export function BulkBar({ count, onClear, children }) {
  if (!count) return null
  return (
    <div className="sticky bottom-4 z-20 mx-auto flex w-fit items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-xl">
      <span className="text-sm font-medium text-ink-900">{count} selected</span>
      <div className="flex items-center gap-2">{children}</div>
      <button className="cursor-pointer text-sm text-slate-500 hover:text-ink-900" onClick={onClear}>Clear</button>
    </div>
  )
}

// A small labelled number. Used across Reports, Monitoring and the campaign
// header so a KPI looks the same wherever it is read.
export function Stat({ label, value, hint, tone }) {
  const toneCls = tone === 'good' ? 'text-accent-700' : tone === 'bad' ? 'text-red-700' : 'text-ink-900'
  return (
    <div className="card px-5 py-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  )
}

// Announces a change to screen readers without stealing focus. The specs ask
// for aria-live="polite" on optimistic updates in several places.
export function LiveRegion({ message }) {
  return <div aria-live="polite" className="sr-only">{message || ''}</div>
}

export { Spinner, EmptyState, ErrorState, Modal, useToast, Icon }
