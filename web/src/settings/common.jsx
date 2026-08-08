// Shared plumbing for the Settings sections the SmartLead-parity backlog adds.
//
// Nothing here is a new idea: it is the small amount of glue the five new
// sections would otherwise each invent. Anything that a second page would also
// want lives in ../parity-ui.jsx instead — this file is deliberately private to
// Settings.
//
// The one rule worth stating: the parity modules answer a 422 (and a 409
// conflict) with `{ error, field, message }`, where `message` is the sentence
// written for a person. That sentence belongs against the input it names, never
// in a toast that disappears while the user is still reading the form.

import { useCallback, useEffect, useState } from 'react'
import { api, qs } from '../api.js'

// ---- field-level errors -----------------------------------------------------

export function fieldError(err) {
  const field = err?.payload?.field
  if (!field) return null
  return {
    field: String(field),
    message: err?.payload?.message || err?.message || 'That value was not accepted',
  }
}

// `capture` returns true when the error landed on a field, so the caller knows
// not to also shout it as a toast. Server field names are kept verbatim and
// read back through `errFor`, which accepts every spelling a route might use
// (`permission` / `permissions`, `logo` / `logo_url`) rather than maintaining a
// map that would silently rot.
export function useFieldErrors() {
  const [errors, setErrors] = useState({})
  const clear = useCallback(() => setErrors({}), [])
  const capture = useCallback((err) => {
    const fe = fieldError(err)
    if (!fe) { setErrors({}); return false }
    setErrors({ [fe.field]: fe.message })
    return true
  }, [])
  return { errors, setErrors, clear, capture }
}

export function errFor(errors, ...names) {
  for (const name of names) if (errors?.[name]) return errors[name]
  return null
}

// A labelled control with its hint and its error tied to it by id, which is
// what every §4 in the specs asks for by name.
export function Field({ id, label, hint, error, children }) {
  return (
    <div>
      <label className="block text-sm text-slate-700" htmlFor={id}>{label}</label>
      {hint && <p className="mt-0.5 text-xs text-slate-500" id={`${id}-hint`}>{hint}</p>}
      <div className="mt-1.5">{children}</div>
      {error && (
        // role="alert" so a validation failure that lands while focus is still
        // on the submit button is spoken, not just described on next focus.
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-700">{error}</p>
      )}
    </div>
  )
}

// The props an input needs so its hint and error are announced with it.
export function describedBy(id, { hint, error }) {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ')
  return { 'aria-describedby': ids || undefined, 'aria-invalid': error ? true : undefined }
}

// ---- keyset paging ----------------------------------------------------------

// parity-ui's usePagedList reads `items`/`rows`; the clients and webhooks
// modules answer with `data` inside an envelope. Same idea, one more key —
// this stays here rather than changing the shared kit under other pages.
export function usePaged(path, params = {}, { enabled = true } = {}) {
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
      const res = await api.get(`${path}${qs({ ...JSON.parse(key), cursor: nextCursor || undefined })}`)
      const rows = res?.data ?? res?.items ?? res?.rows ?? (Array.isArray(res) ? res : [])
      setItems((prev) => (nextCursor ? [...prev, ...rows] : rows))
      setCursor(res?.nextCursor ?? null)
      setHasMore(Boolean(res?.hasMore ?? res?.nextCursor))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [path, key])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    fetchPage(null)
  }, [fetchPage, enabled])

  return {
    items, setItems, loading, error, hasMore,
    loadMore: () => cursor != null && fetchPage(cursor),
    reload: () => fetchPage(null),
  }
}

// ---- clipboard --------------------------------------------------------------

// A value shown once. The field is read-only rather than disabled so it stays
// selectable and reachable by keyboard, and a clipboard the browser refuses is
// reported rather than silently doing nothing.
export function CopyField({ id, value, label }) {
  const [state, setState] = useState('idle')

  useEffect(() => {
    if (state === 'idle') return undefined
    const t = setTimeout(() => setState('idle'), 4000)
    return () => clearTimeout(t)
  }, [state])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          className="input font-mono text-[12px] sm:flex-1"
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="btn-ghost shrink-0 justify-center" onClick={copy}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p aria-live="polite" className="mt-1 text-xs text-slate-500">
        {state === 'copied' && 'Copied to the clipboard.'}
        {state === 'failed' && 'This browser would not let Harry use the clipboard — select the value and copy it by hand.'}
      </p>
    </div>
  )
}

// ---- small bits -------------------------------------------------------------

// Status as words plus a shape, never colour alone.
export function StatusPill({ tone = 'neutral', children }) {
  const cls = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-700',
    bad: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-slate-300 bg-slate-100 text-slate-700',
  }[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${cls}`}>
      {children}
    </span>
  )
}

// A settings block you can always read, and can only change on purpose.
//
// The rule this encodes, and the reason it is one component rather than a habit:
// a setting you cannot see is a setting you cannot check, so nothing is ever
// hidden behind a button. What the button controls is whether the values can be
// *typed into* — the body is always on screen, disabled until Edit, which is
// also how a `<fieldset disabled>` behaves for a keyboard and a screen reader
// without any of it having to be re-described.
//
// `instant` is for a block whose controls save the moment they are touched (a
// switch, a select). There is no Save to press, so the button reads Done.
export function EditableSection({
  id, title, description, note, children, onSave, onCancel, busy = false,
  saveLabel = 'Save', instant = false, variant = 'card', aside,
}) {
  const [editing, setEditing] = useState(false)
  const card = variant === 'card'
  // Inline groups live inside a card that is already a section; only the
  // outermost one is a landmark.
  const Wrapper = card ? 'section' : 'div'
  const Title = card ? 'h2' : 'div'

  const leave = () => { setEditing(false); onCancel?.() }
  const commit = async () => {
    // A save that reports failure by returning false keeps the form open, with
    // what the user typed still in it.
    const ok = await onSave?.()
    if (ok !== false) setEditing(false)
  }

  // A block whose read state is genuinely different from its edit state passes a
  // function instead of nodes: a stored answer reads better as prose than as a
  // greyed-out textarea, which is hard to tell from an empty one.
  const body = typeof children === 'function' ? children({ editing }) : children

  return (
    <Wrapper className={card ? 'card p-6' : 'border-t border-line pt-5'}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <Title className={card ? 'text-base font-semibold text-ink-900' : 'text-md font-medium text-ink-900'}>{title}</Title>
          {(note || description) && (
            <p className={`max-w-[64ch] ${card ? 'mt-1.5 text-sm text-slate-500' : 'mt-1 text-xs text-slate-500'}`}>{note || description}</p>
          )}
        </div>
        {aside}
        <button
          type="button"
          className="btn-ghost shrink-0"
          aria-expanded={editing}
          aria-controls={id}
          disabled={busy}
          onClick={() => (editing ? leave() : setEditing(true))}
        >
          {editing ? (instant ? 'Done' : 'Cancel') : 'Edit'}
        </button>
      </div>

      <fieldset id={id} disabled={!editing} className="mt-5 min-w-0 space-y-5">
        {body}
        {editing && !instant && onSave && (
          <button type="button" className="btn-primary" disabled={busy} onClick={commit}>
            {busy ? 'Saving…' : saveLabel}
          </button>
        )}
      </fieldset>
    </Wrapper>
  )
}

// One answered question, read. Label and why-it-matters on the left, the value
// itself on the right — the layout the redesign uses for every settings block
// that is read far more often than it is changed.
export function Readout({ label, hint, value, placeholder = 'Not answered yet' }) {
  const filled = String(value ?? '').trim()
  return (
    <div className="grid gap-2 border-b border-line pb-5 last:border-0 last:pb-0 sm:grid-cols-[238px_1fr] sm:gap-7">
      <div>
        <div className="text-md font-semibold text-ink-900">{label}</div>
        {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </div>
      <div className={filled ? 'readout' : 'readout text-slate-400 italic'}>{filled || placeholder}</div>
    </div>
  )
}

// A section that stays out of the way until it is opened. The specs ask for
// exactly this in three places ("collapsed to a count until opened") — it is
// the mitigation that keeps a settings page from becoming a control panel.
export function Collapsible({ id, title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="card p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{summary}</p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Open'}
        </button>
      </div>
      <div id={id} hidden={!open} className={open ? 'mt-5 space-y-4' : undefined}>
        {open && children}
      </div>
    </section>
  )
}

// Both a date input and the ISO 8601 timestamp the summary and retry routes
// insist on. A bare "YYYY-MM-DD" parses as UTC midnight, which is what those
// routes compare against.
export function isoFromDate(value, endOfDay = false) {
  if (!value) return ''
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export function daysAgoDate(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

export function todayDate() {
  return new Date().toISOString().slice(0, 10)
}
