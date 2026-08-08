// Small pieces the Leads surfaces share.
//
// Nothing here is a new idea — it is the plumbing the parity specs repeat in
// every §4: a 422 shown against the field it names rather than as a toast, a
// picker that is a bottom sheet under 640px, and a bounded fan-out so reading
// the labels on fifty ticked rows does not open fifty connections at once.

import { useEffect, useRef } from 'react'

// ---- 422 handling ------------------------------------------------------------

// The parity modules answer a 422 with { error, field, message }. The message
// is the sentence meant for a person; the field says where to put it.
export function fieldOf(err) {
  const payload = err?.payload
  if (payload && payload.field) {
    return { field: String(payload.field), message: payload.message || err.message }
  }
  return null
}

// Rendered directly beneath the input the server named.
export function FieldError({ err, field }) {
  const named = fieldOf(err)
  if (!named || named.field !== field) return null
  return <p className="mt-1 text-xs text-red-700" role="alert">{named.message}</p>
}

// Everything the form could not attribute to one of its inputs. `fields` lists
// the names already rendered by FieldError so a message never appears twice.
export function FormError({ err, fields = [] }) {
  if (!err) return null
  const named = fieldOf(err)
  if (named && fields.includes(named.field)) return null
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {err.message || String(err)}
    </p>
  )
}

// ---- layout ------------------------------------------------------------------

// A dialog that is a centred card on a desktop and a bottom sheet under 640px,
// which is what every "Responsive" line in the frontend stories asks for.
export function Sheet({ title, onClose, children, footer, wide, describedBy }) {
  const panel = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    // Focus the panel rather than the first control: the first control in a
    // destructive sheet must not be focused by default.
    panel.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        className={`card flex max-h-[88vh] w-full flex-col rounded-b-none outline-none sm:rounded-xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-base font-semibold text-ink-950">{title}</h2>
          <button
            type="button"
            className="cursor-pointer text-xl leading-none text-slate-600 hover:text-ink-900"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

// A titled block inside the lead detail. `tone="human"` is the notes panel: the
// accent rail is what keeps a person's note from reading like the agent's
// research profile sitting a few hundred pixels above it.
export function Panel({ title, hint, tone, action, children }) {
  const rail = tone === 'human'
    ? 'border-l-4 border-l-accent-500'
    : tone === 'agent'
      ? 'border-l-4 border-l-indigo-500'
      : ''
  return (
    <section className={`card ${rail} px-4 py-3.5`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-950">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function Field({ label, htmlFor, children, hint }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-slate-600" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  )
}

// ---- values ------------------------------------------------------------------

export const fmt = (n) => Number(n || 0).toLocaleString()

// SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC; the parity modules write ISO.
// Both have to read as the same instant.
export function parseWhen(value) {
  if (!value) return null
  const raw = String(value)
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}${raw.endsWith('Z') ? '' : 'Z'}`
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

export function when(value) {
  const at = parseWhen(value)
  if (!at) return ''
  return at.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function shortWhen(value) {
  const at = parseWhen(value)
  if (!at) return ''
  return at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

// For <input type="datetime-local">, which wants local wall-clock with no zone.
export function toLocalInput(value) {
  const at = parseWhen(value)
  if (!at) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function fromLocalInput(value) {
  if (!value) return ''
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString()
}

export const initials = (name, email) => {
  const source = String(name || email || '?').trim()
  const parts = source.split(/[\s@.]+/).filter(Boolean)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || source[0].toUpperCase()
}

// ---- concurrency -------------------------------------------------------------

// Bounded fan-out. The three-state label picker has to know what every ticked
// row already carries and there is no bulk read for that, so the reads are
// pooled rather than fired all at once.
export async function pool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return out
}
