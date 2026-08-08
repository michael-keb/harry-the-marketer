// Shared bits for the Inbox surfaces.
//
// The backlog collapses SmartLead's ten inbox screens into one list with a
// `state`, so the pieces every state re-uses — the time wording, the menu, the
// reference data, the 422 plumbing — live here rather than in each panel.
//
// Two rules run through all of it. Status is never colour alone: a marker
// always carries its word. And a time is never only relative: "in 2 days" is
// useless if you cannot see it means Friday morning, so the absolute value
// travels in the accessible name.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// ---------------------------------------------------------------- time ------

// SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker; nowIso()
// writes a real ISO string. Both arrive here, so both are parsed here.
export function parseAt(value) {
  if (!value) return NaN
  const raw = String(value)
  return Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`)
}

// The absolute wording. Always rendered somewhere a screen reader will reach,
// even when the visible text is relative.
export function absolute(value) {
  const at = parseAt(value)
  if (Number.isNaN(at)) return ''
  return new Date(at).toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  })
}

// Past and future in one function — a snooze wakes in the future, a reply
// landed in the past, and the same row can show either.
export function relative(value) {
  const at = parseAt(value)
  if (Number.isNaN(at)) return ''
  const diff = at - Date.now()
  const mins = Math.round(Math.abs(diff) / 60000)
  const unit = mins < 1 ? 'less than a minute'
    : mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'}`
      : mins < 60 * 24 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}`
        : `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`
  return diff >= 0 ? `in ${unit}` : `${unit} ago`
}

export function bothTimes(value) {
  const abs = absolute(value)
  return abs ? `${relative(value)} (${abs})` : ''
}

const pad = (n) => String(n).padStart(2, '0')

// The value a <input type="datetime-local"> wants, in the browser's timezone —
// which is the only timezone this product has. There is no timezone setting.
export function toLocalInput(date) {
  const d = date instanceof Date ? date : new Date(parseAt(date))
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(value) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function inDays(days, hour) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hour, 0, 0, 0)
  return d
}

// Presets resolve to a real date the moment they are offered, so the menu can
// state the answer before it is chosen rather than after.
export const SNOOZE_PRESETS = [
  { id: 'tomorrow', label: 'Tomorrow morning', at: () => inDays(1, 9) },
  { id: 'week', label: 'Next week', at: () => inDays(7, 9) },
  { id: 'month', label: 'In a month', at: () => inDays(30, 9) },
]

export const REMIND_PRESETS = [
  { id: 'tomorrow', label: 'Tomorrow', at: () => inDays(1, 9) },
  { id: 'three', label: 'In 3 days', at: () => inDays(3, 9) },
  { id: 'week', label: 'Next week', at: () => inDays(7, 9) },
]

// ---------------------------------------------------------------- viewport --

// The mail client is a genuinely different layout above and below 1024px — three
// panes beside each other, or a list that the reading pane replaces — and the
// difference is behavioural, not only visual: on a narrow window the list must
// stop rendering so focus cannot land in it while the reading pane is showing.
// CSS alone cannot say that, so the breakpoint is read here as well.
//
// `matchMedia` is absent in some test environments; the fallback is the wide
// layout, because that is what the desktop product is.
export function useMediaQuery(query, fallback = true) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(query)
    const onChange = (e) => setMatches(e.matches)
    setMatches(mql.matches)
    // Safari below 14 only has the deprecated pair.
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [query])
  return matches
}

// ---------------------------------------------------------------- people ----

export function leadName(lead) {
  if (!lead) return 'this lead'
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  return name || lead.email || 'this lead'
}

// ---------------------------------------------------------------- markers ---

// A marker always reads as a word. The border colour is decoration; remove it
// and the row still says "Unread", "Overdue", "Archived".
export function Marker({ children, tone = 'plain', title }) {
  const ring = tone === 'warn' ? 'border-amber-300 text-amber-800'
    : tone === 'bad' ? 'border-red-300 text-red-700'
      : tone === 'good' ? 'border-emerald-200 text-emerald-700'
        : 'border-slate-300 text-slate-700'
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 ${ring}`}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------- errors ----

// The parity modules answer a 422 with { error, field, message }. The message
// belongs against the field it names, not in a banner at the top of the form.
export const fieldOf = (error) => error?.payload?.field || ''

export function FieldError({ error, field }) {
  if (!error || fieldOf(error) !== field) return null
  return <p role="alert" className="mt-1 text-xs text-red-700">{error.payload.message || error.message}</p>
}

// Everything the form did not place against a named field. `handled` lists the
// fields that are rendered with a <FieldError>, so a message is never shown
// twice and never swallowed.
export function Banner({ error, handled = [], onRetry, children }) {
  if (!error && !children) return null
  if (error && handled.includes(fieldOf(error))) return null
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <span>{children || error?.payload?.message || error?.message || String(error)}</span>
      {onRetry && (
        <button type="button" className="ml-3 underline cursor-pointer hover:text-red-700" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- skeleton --

export function SkeletonRows({ rows = 5, label = 'Loading…' }) {
  return (
    <div className="card divide-y divide-slate-200" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3.5">
          <div className="mt-1 size-4 shrink-0 rounded bg-slate-100" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-40 rounded bg-slate-100" />
            <div className="h-3 w-full max-w-md rounded bg-slate-100/70" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------- menu ------

// One menu for row overflow, snooze presets and resume options. Keyboard
// operable, closes on Escape and on a click outside, and under 640px it is a
// bottom sheet rather than a dropdown that runs off the screen.
export function Menu({ label, ariaLabel, items = [], buttonClass = 'btn-ghost', title, disabled }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const list = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (open) list.current?.querySelector('button:not([disabled])')?.focus()
  }, [open])

  const move = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const buttons = [...(list.current?.querySelectorAll('button:not([disabled])') || [])]
    const at = buttons.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    buttons[(next + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className={buttonClass}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40 sm:hidden" aria-hidden onClick={() => setOpen(false)} />
          <ul
            ref={list}
            role="menu"
            aria-label={ariaLabel || (typeof label === 'string' ? label : 'Menu')}
            onKeyDown={move}
            className="fixed inset-x-2 bottom-2 z-40 max-h-[70vh] overflow-y-auto rounded-xl border border-slate-300 bg-slate-100 p-1 shadow-2xl
              sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-1 sm:w-64"
          >
            {items.map((item) => (
              <li key={item.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => { setOpen(false); item.onSelect?.() }}
                  className={`block w-full rounded-lg px-3 py-2 text-left text-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                    item.danger ? 'text-red-700 hover:bg-red-50' : 'text-ink-900 hover:bg-slate-200'
                  }`}
                >
                  <span className="block">{item.label}</span>
                  {/* A disabled option states its reason in text — never by styling alone. */}
                  {(item.hint || item.reason) && (
                    <span className="mt-0.5 block text-[11px] text-slate-600">{item.hint || item.reason}</span>
                  )}
                </button>
              </li>
            ))}
            {items.length === 0 && <li role="none" className="px-3 py-2 text-sm text-slate-600">Nothing available here.</li>}
          </ul>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- refs ------

// Campaigns, mailboxes, team, categories and the reply vocabulary. Loaded once
// for the whole page: every filter and every picker reads the same lists, and a
// single failure does not take the others down with it.
export function useRefs() {
  const [refs, setRefs] = useState({
    campaigns: [], mailboxes: [], members: [], owner: '', solo: true,
    categories: [], intents: [], ready: false,
  })

  const load = useCallback(async () => {
    const [campaigns, mailboxes, team, categories, intents] = await Promise.allSettled([
      api.get('/api/campaigns'),
      api.get('/api/mailboxes'),
      api.get('/api/team'),
      api.get('/api/lead-categories?limit=200'),
      api.get('/api/inbox/intents'),
    ])
    const ok = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback)
    const teamValue = ok(team, { members: [], ownerEmail: '' })
    const roster = [teamValue.ownerEmail, ...(teamValue.members || []).map((m) => m.email)].filter(Boolean)
    setRefs({
      campaigns: ok(campaigns, []) || [],
      mailboxes: (ok(mailboxes, { mailboxes: [] }).mailboxes) || [],
      members: roster,
      owner: teamValue.ownerEmail || '',
      // Assignment is meaningless with nobody to assign to, so the control is
      // hidden rather than shown with one option.
      solo: (teamValue.members || []).length === 0,
      categories: (ok(categories, { data: [] }).data) || [],
      intents: ok(intents, []) || [],
      ready: true,
    })
  }, [])

  useEffect(() => { load() }, [load])
  return refs
}

// A count that never flashes zero: a failed poll keeps the last known value,
// because "0 unread" and "we could not ask" are different answers.
export function useUnreadCount(refreshKey) {
  const [count, setCount] = useState(null)
  useEffect(() => {
    let live = true
    api.get('/api/inbox/unread-count')
      .then((r) => { if (live) setCount(r.count ?? 0) })
      .catch(() => { /* keep the last known value */ })
    return () => { live = false }
  }, [refreshKey])
  return count
}
