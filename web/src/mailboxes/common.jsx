// Small pieces shared by the Mailboxes surfaces.
//
// Nothing here is a new idea: the page kit lives in ../parity-ui.jsx and is
// never edited from this folder. What is here is the handful of things only
// the mailbox fleet and the sending-infrastructure panel need — reading a
// field-level 422 back onto the input that caused it, drawing a dense daily
// series where a zero day is a zero and not a gap, and stating a health verdict
// in words so nothing depends on a colour.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { Icon } from '../ui.jsx'

export const PAGE_SIZE = 100

// The documented per-request bound on mailbox label assignment. The UI chunks
// above it so the cap is never something a user has to know about.
export const TAG_BATCH = 25

export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// ------------------------------------------------------------ field errors ---
//
// Every parity module answers a 422 with `{ error, field, message }`, and the
// senders module reports nested paths like
// `domains[0].mailbox_details[1].first_name`. Marking the offending row is the
// whole point of it naming the field, so these two read it back precisely.

export function fieldError(err, path) {
  const field = err?.payload?.field
  if (!field) return ''
  return String(field) === path ? String(err.payload.message || err.message || '') : ''
}

// True when the 422 names anything at or beneath `prefix` — used to mark the
// row that contains the offending input.
export function errorUnder(err, prefix) {
  const field = err?.payload?.field
  if (!field) return ''
  const value = String(field)
  if (value !== prefix && !value.startsWith(`${prefix}.`) && !value.startsWith(`${prefix}[`)) return ''
  return String(err.payload.message || err.message || '')
}

export function isFieldError(err) {
  return Boolean(err?.payload?.field)
}

// A 429 from the senders module carries the wait in seconds.
export function retryAfter(err) {
  const n = Number(err?.payload?.retry_after_seconds || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ------------------------------------------------------------- announcing ---

// A polite announcement that clears itself, so the same sentence announced
// twice is announced twice rather than swallowed.
export function useAnnounce() {
  const [message, setMessage] = useState('')
  const timer = useRef(null)
  const say = useCallback((text) => {
    setMessage('')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(text), 60)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [message, say]
}

// ------------------------------------------------------------------ fleet ---

// The whole fleet, for the questions that cannot be answered from one page:
// "if I suspend this, which campaigns have nothing else to send from?" needs
// every other mailbox, not the twenty currently on screen. Bounded to five
// pages so it can never become an unbounded fetch.
export async function fetchFleetAll() {
  const out = []
  let offset = 0
  for (let i = 0; i < 5; i += 1) {
    const res = await api.get(`/api/mailboxes/fleet${qs({ withCampaigns: 1, limit: PAGE_SIZE, offset })}`)
    const rows = res.data || []
    out.push(...rows)
    if (!res.hasMore || !rows.length) break
    offset += rows.length
  }
  return out
}

// The same rule the server applies in campaignsHeldBy(): a campaign is held
// when the mailbox in question stops working and no *other* attached mailbox
// can send. Computed here so the confirm dialog can say it BEFORE the user
// commits — the server can only report it afterwards, because a mailbox that
// is still sendable holds nothing back yet.
export function campaignsLeftWithNothing(fleet, target) {
  const mine = (target.campaigns || []).filter((c) => c.status === 'running' || c.status === 'paused')
  return mine.filter((c) => !fleet.some(
    (other) => other.id !== target.id && other.sendable && (other.campaignIds || []).includes(c.id)
  ))
}

// ----------------------------------------------------------------- layout ---

export function Section({ title, hint, action, children, id }) {
  return (
    <section className="card p-4" aria-labelledby={id}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold text-ink-950">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500 max-w-prose">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

// A labelled control with its help text and any field error tied to it, which
// is what `aria-describedby` is for.
export function Field({ id, label, help, error, children, className = '' }) {
  const helpId = help ? `${id}-help` : undefined
  const errId = error ? `${id}-err` : undefined
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700 mb-1">{label}</label>
      {typeof children === 'function' ? children({ id, describedBy: [helpId, errId].filter(Boolean).join(' ') || undefined }) : children}
      {help && <p id={helpId} className="mt-1 text-[11px] text-slate-500">{help}</p>}
      {error && <p id={errId} role="alert" className="mt-1 text-[11px] text-red-700">{error}</p>}
    </div>
  )
}

// ----------------------------------------------------------------- status ---

// Health in words with an icon beside it. The word is the state; the colour and
// the glyph only repeat it.
export function StatusWord({ ok, children, unknown }) {
  const cls = unknown ? 'text-slate-600' : ok ? 'text-emerald-700' : 'text-red-700'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${cls}`}>
      <Icon name={unknown ? 'pulse' : ok ? 'check' : 'alert'} className="size-3.5" />
      <span>{children}</span>
    </span>
  )
}

// Today's sends against the cap that actually binds. The number is the truth;
// the bar repeats it.
export function UsageBar({ used, cap, warmingUp }) {
  const safeCap = Math.max(1, Number(cap) || 0)
  const width = Math.min(100, Math.round((Number(used) || 0) / safeCap * 100))
  return (
    <div className="min-w-32">
      <div className="text-xs text-slate-700">
        {used} of {cap} today
        {warmingUp && <span className="text-amber-700"> · warming up</span>}
      </div>
      <div className="mt-1 h-1.5 w-full max-w-40 rounded-full bg-slate-200 overflow-hidden" aria-hidden>
        <div className={`h-full ${warmingUp ? 'bg-amber-400' : 'bg-accent-500'}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

// A dense daily series. Every day in the range gets a column, and a day with
// nothing in it draws a visible baseline stub rather than nothing at all — a
// gap in a chart reads as "something broke", which is a different claim from
// "nothing happened". The table beneath it is the accessible source of truth.
export function Sparkline({ values, label, tone = 'accent' }) {
  const max = Math.max(1, ...values.map((v) => Number(v) || 0))
  const stroke = tone === 'danger' ? 'bg-red-400' : 'bg-accent-500'
  return (
    <div>
      <div className="flex h-14 items-end gap-0.5" role="img" aria-label={label}>
        {values.map((raw, i) => {
          const v = Number(raw) || 0
          const h = v === 0 ? 2 : Math.max(3, Math.round((v / max) * 52))
          return (
            <div
              key={i}
              className={`flex-1 rounded-sm ${v === 0 ? 'bg-slate-300' : stroke}`}
              style={{ height: `${h}px` }}
            />
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{label}</p>
    </div>
  )
}

export function Skeleton({ rows = 3, className = 'h-10' }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`${className} rounded-lg bg-slate-100 animate-pulse`} />
      ))}
    </div>
  )
}

export function money(amount, currency) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `— ${currency || ''}`.trim()
  return `${n.toFixed(2)} ${String(currency || 'USD').toUpperCase()}`
}

// "45 dollars" reads better than "45.00 USD" inside an accessible name, which
// is what place-order.md asks the confirm action to carry.
export function spokenMoney(amount, currency) {
  const n = Number(amount)
  const code = String(currency || 'USD').toUpperCase()
  const word = { USD: 'dollars', EUR: 'euros', GBP: 'pounds' }[code] || code
  if (!Number.isFinite(n)) return `price shown at the supplier's checkout`
  return `${n.toFixed(2)} ${word}`
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`
}
