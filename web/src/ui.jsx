// Shared UI primitives: toasts, spinners, empty/error states, modal, badges.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'

const ToastCtx = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, kind = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`card border-l-4 px-4 py-3 text-sm shadow-xl ${
              t.kind === 'error' ? 'border-l-red-500 text-red-700' : 'border-l-accent-500 text-ink-900'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

// Minimal inline icon set (stroke SVGs) — the product uses no emoji anywhere.
const ICON_PATHS = {
  dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  campaigns: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5 5h14l3 7v7H2v-7z',
  leads: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M17 8a3 3 0 1 0 3-3M22 21v-1a5 5 0 0 0-3-4.6',
  mailboxes: 'M3 5h18v14H3zM3 6l9 7 9-7',
  connections: 'M12 2a4 4 0 0 1 4 4v2h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4zM10 8h4V6a2 2 0 1 0-4 0z',
  reports: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  alert: 'M12 3 2 20h20zM12 10v4M12 17.5v.5',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  check: 'M4 12l5 5L20 6',
  pulse: 'M2 12h4l2-7 4 14 2-7h8',
  goal: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  monitor: 'M2 4h20v13H2zM8 21h8M12 17v4M6 10.5h3.5l1.5-3 2 5.5 1.5-3H18',
}

export function Icon({ name, className = 'size-4' }) {
  const d = ICON_PATHS[name]
  if (!d) return null
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  )
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 py-16 text-slate-500">
      <div className="size-5 animate-spin rounded-full border-2 border-slate-200 border-t-accent-500" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  )
}

// The page's own title block. Every product page opens with the same three
// things — what this is, one line of what it is for, and the actions that apply
// to the whole page — so they are laid out once rather than nine slightly
// different ways.
export function PageHeader({ title, lead, actions, breadcrumb, children }) {
  return (
    <header className="mb-6">
      {breadcrumb && <div className="mb-3 text-sm text-slate-500">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-7 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold text-ink-900">{title}</h1>
            {children}
          </div>
          {lead && <p className="mt-2 max-w-2xl text-md text-slate-500">{lead}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

// The one banner shape: a coloured dot, a headline, the explanation, and
// whatever links act on it. `onDismiss` makes it closable — used for standing
// advisories that are true for weeks, which are exactly the ones that stop
// being read if they can never be put away.
const NOTICE_TONES = {
  caution: { box: 'border-amber-200 bg-amber-50', dot: 'bg-amber-400', title: 'text-amber-800', body: 'text-amber-700', close: 'text-amber-600 hover:text-amber-800' },
  info: { box: 'border-sky-200 bg-sky-50', dot: 'bg-sky-700', title: 'text-sky-800', body: 'text-sky-700', close: 'text-sky-700 hover:text-sky-800' },
  danger: { box: 'border-red-200 bg-red-50', dot: 'bg-red-500', title: 'text-red-800', body: 'text-red-700', close: 'text-red-600 hover:text-red-800' },
  good: { box: 'border-accent-200 bg-accent-50', dot: 'bg-accent-500', title: 'text-accent-700', body: 'text-accent-700', close: 'text-accent-600 hover:text-accent-700' },
}

export function Notice({ tone = 'caution', title, children, actions, onDismiss, className = '' }) {
  const t = NOTICE_TONES[tone] || NOTICE_TONES.caution
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4.5 py-4 ${t.box} ${className}`} role="status">
      <span className={`mt-2 size-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <div className={`text-md font-semibold ${t.title}`}>{title}</div>}
        <div className={`${title ? 'mt-1.5' : ''} max-w-[76ch] text-sm ${t.body}`}>{children}</div>
        {actions && <div className="mt-2.5 flex flex-wrap gap-4 text-sm">{actions}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className={`shrink-0 cursor-pointer text-sm ${t.close}`}>
          Dismiss
        </button>
      )}
    </div>
  )
}

export function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-slate-300 text-slate-400">
        <Icon name={icon || 'inbox'} className="size-5" />
      </div>
      <h3 className="mt-2 text-lg font-semibold text-ink-900">{title}</h3>
      {hint && <p className="max-w-[46ch] text-md text-slate-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <div role="alert" className="card flex flex-col items-center gap-3 border-red-200 px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-red-200 text-red-600">
        <Icon name="alert" className="size-5" />
      </div>
      <p className="text-sm text-red-700">{String(error?.message || error)}</p>
      {onRetry && (
        <button className="btn-ghost" onClick={onRetry}>Try again</button>
      )}
    </div>
  )
}

// A dialog, and behaved like one.
//
// This component backs around forty call sites, so everything it fails to do it
// fails to do forty times: it had no dialog role, Escape did nothing, focus
// never entered it, and every control behind the overlay stayed in the tab
// order — so a keyboard user could tab out of a modal, act on the page it was
// covering, and never find their way back. Fixed here rather than at the call
// sites for the same reason.
export function Modal({ title, lead, onClose, children, wide }) {
  const panelRef = useRef(null)
  const returnToRef = useRef(null)
  const titleId = useId()

  // `onClose` is a fresh arrow at nearly every call site, so depending on it
  // re-ran this effect on every render — and its last act is to focus the first
  // control. The visible symptom was that you could type exactly one character
  // into a modal's textarea before focus jumped to Close. Held in a ref so the
  // effect is mount-only and the latest handler is still the one that fires.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    returnToRef.current = document.activeElement
    // Focus the first control inside, or the panel itself if there is none, so
    // a screen reader starts reading here rather than wherever it was.
    const panel = panelRef.current
    const first = panel?.querySelector(FOCUSABLE)
    ;(first || panel)?.focus()

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      // Keep Tab inside. Without this the background is still reachable, which
      // is the difference between a dialog and a decorative overlay.
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first2 = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first2) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first2.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const back = returnToRef.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-10"
      style={{ background: 'rgba(11,22,34,0.42)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-5 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-ink-900">{title}</h2>
            {lead && <p className="mt-1 text-sm text-slate-500">{lead}</p>}
          </div>
          <button
            className="shrink-0 cursor-pointer text-xl leading-none text-slate-400 hover:text-ink-900"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

const BADGE_COLORS = {
  queued: 'bg-slate-100 text-slate-600',
  active: 'bg-sky-50 text-sky-700',
  waiting: 'bg-amber-50 text-amber-700',
  needs_attention: 'bg-red-50 text-red-700',
  finished: 'bg-emerald-50 text-emerald-700',
  stopped: 'bg-slate-100 text-slate-500',
  error: 'bg-red-100 text-red-700',
  draft: 'bg-slate-100 text-slate-600',
  running: 'bg-emerald-50 text-emerald-700',
  paused: 'bg-amber-50 text-amber-700',
  connected: 'bg-emerald-50 text-emerald-700',
  disconnected: 'bg-slate-100 text-slate-500',
  won: 'bg-emerald-50 text-emerald-700',
  lost: 'bg-slate-100 text-slate-500',
  unsubscribed: 'bg-red-50 text-red-700',
  completed: 'bg-slate-100 text-slate-600',
  interested: 'bg-emerald-50 text-emerald-700',
  'not interested': 'bg-slate-100 text-slate-500',
  'not now': 'bg-amber-50 text-amber-700',
  question: 'bg-sky-50 text-sky-700',
  'out of office': 'bg-slate-100 text-slate-500',
  other: 'bg-purple-50 text-purple-700',
  unclassified: 'bg-slate-100 text-slate-500',
  // Prospect stages (derived — see server/stages.js)
  'not contacted': 'bg-slate-100 text-slate-500',
  contacted: 'bg-sky-50 text-sky-700',
  replied: 'bg-indigo-50 text-indigo-700',
  agreed: 'bg-emerald-50 text-emerald-700',
  bounced: 'bg-red-50 text-red-700',
  // Where a piece of copy came from
  ai: 'bg-indigo-50 text-indigo-700',
  template: 'bg-slate-100 text-slate-500',
  'your copy': 'bg-emerald-50 text-emerald-700',
}

export function Badge({ value }) {
  const cls = BADGE_COLORS[value] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ${cls}`}>
      {String(value).replace('_', ' ')}
    </span>
  )
}

// A wall-clock time the reader can act on ("around 2:40pm"), with the day
// attached when it is not today — "2:40pm" on a Friday evening must not read as
// "in ten minutes" when it means Monday.
export function clockTime(dateStr) {
  if (!dateStr) return ''
  const at = new Date(dateStr)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

export function timeAgo(dateStr) {
  if (!dateStr) return ''
  const then = Date.parse(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z')
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
