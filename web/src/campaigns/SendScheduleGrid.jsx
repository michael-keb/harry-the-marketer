// Send plan — GitHub contribution grid made of chunky Minecraft-style blocks.
// Lives on the Playbook tab as part of the plan, not a separate settings panel.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'

const VIEWS = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function localParts(at, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(at))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  const weekday = WEEKDAY.indexOf(get('weekday'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekday >= 0 ? weekday : 0,
    hour: Number(get('hour')) % 24,
  }
}

function addDays(dateStr, days, tz) {
  return localParts(Date.parse(`${dateStr}T12:00:00Z`) + days * 86_400_000, tz).date
}

function isHourOpen(windows, weekday, hour) {
  const startMin = hour * 60
  const endMin = hour * 60 + 59
  for (const w of windows || []) {
    if (!(w.days || []).includes(weekday)) continue
    const from = toMinutes(w.from)
    const to = toMinutes(w.to)
    if (from === null || to === null || to <= from) continue
    if (startMin < to && endMin >= from) return true
  }
  return false
}

function intensity(count) {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count === 2) return 2
  if (count <= 4) return 3
  return 4
}

function dominantKind(items) {
  if (items.some((m) => m.kind === 'pending')) return 'pending'
  if (items.some((m) => m.kind === 'queued')) return 'queued'
  if (items.some((m) => m.kind === 'projected')) return 'projected'
  if (items.some((m) => m.kind === 'sent')) return 'sent'
  return null
}

function blockVariant(items, open) {
  if (!items.length) return open ? 'open' : 'void'
  const kind = dominantKind(items)
  if (kind === 'pending') return 'pending'
  if (kind === 'queued') return 'queued'
  if (kind === 'sent') return 'sent'
  return `send-${intensity(items.filter((m) => m.kind === 'projected' || m.kind === 'queued').length || items.length)}`
}

function formatWhen(at, tz) {
  return new Date(at).toLocaleString(undefined, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function bucketMarkers(markers, tz, keyFn) {
  const map = new Map()
  for (const m of markers) {
    if (!m.at) continue
    const key = keyFn(m.at, tz)
    if (key === null || key === undefined) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(m)
  }
  return map
}

function PlanBlock({ variant, title, large = false }) {
  return (
    <div
      className={`send-plan-block send-plan-block--${variant}${large ? ' send-plan-block--lg' : ''}`}
      title={title}
      role="gridcell"
      aria-label={title}
    />
  )
}

function firstOpenHour(windows, weekday) {
  for (let hour = 0; hour < 24; hour++) {
    if (isHourOpen(windows, weekday, hour)) return hour
  }
  return 0
}

function DayGrid({ data, tz, now, buckets }) {
  const todayParts = localParts(now, tz)
  const pending = data.markers.filter((m) => m.kind === 'pending')
  const pendingHour = pending.length ? firstOpenHour(data.windows, todayParts.weekday) : null

  return (
    <div role="grid" aria-label="Today's send plan by hour">
      <div className="send-plan-grid" style={{ flexWrap: 'wrap' }}>
        {Array.from({ length: 24 }, (_, hour) => {
          const open = isHourOpen(data.windows, todayParts.weekday, hour)
          let items = buckets.get(`h${hour}`) || []
          if (pendingHour === hour) items = [...items, ...pending]
          const variant = blockVariant(items, open)
          const label = hour % 12 || 12
          const ampm = hour < 12 ? 'am' : 'pm'
          const tip = items.length
            ? items.map((m) => m.label || m.kind).join(', ')
            : open ? `${label}${ampm} — open, empty` : `${label}${ampm} — closed`
          return (
            <div key={hour} className="flex flex-col items-center gap-0.5">
              <PlanBlock variant={variant} title={tip} large />
              <span className="text-[9px] tabular-nums text-slate-400">{label}{ampm[0]}</span>
            </div>
          )
        })}
      </div>
      {pending.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-800">
          {pending.length} block{pending.length === 1 ? '' : 's'} waiting for your OK — approve to place them on the grid.{' '}
          <Link className="underline" to="/app/inbox?folder=approve">Inbox</Link>
        </p>
      )}
    </div>
  )
}

function WeekGrid({ data, tz, now, buckets }) {
  const today = localParts(now, tz).date
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i, tz))

  return (
    <div className="overflow-x-auto" role="grid" aria-label="Week send plan — days by hour">
      <div className="flex gap-2">
        <div className="send-plan-col pt-5">
          {days.map((date) => (
            <span key={date} className="flex h-[11px] items-center text-[9px] text-slate-500" style={{ marginBottom: 3 }}>
              {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { timeZone: tz, weekday: 'short' })}
            </span>
          ))}
        </div>
        <div>
          <div className="send-plan-grid mb-1">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="w-[11px] text-center text-[8px] tabular-nums text-slate-400">
                {hour % 6 === 0 ? (hour % 12 || 12) : ''}
              </span>
            ))}
          </div>
          {days.map((date) => {
            const p = localParts(Date.parse(`${date}T12:00:00Z`), tz)
            return (
              <div key={date} className="send-plan-grid mb-[3px]">
                {Array.from({ length: 24 }, (_, hour) => {
                  const open = isHourOpen(data.windows, p.weekday, hour)
                  const items = buckets.get(`${date}:h${hour}`) || []
                  const variant = blockVariant(items, open)
                  const tip = items.length
                    ? `${date} ${hour}:00 — ${items.map((m) => m.label || m.kind).join(', ')}`
                    : `${date} ${hour}:00 — ${open ? 'empty slot' : 'closed'}`
                  return <PlanBlock key={hour} variant={variant} title={tip} />
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MonthGrid({ data, tz, now, buckets }) {
  const end = localParts(now, tz)
  const endDate = Date.parse(`${end.date}T12:00:00Z`)
  const cells = []
  for (let i = 34; i >= 0; i--) {
    const at = endDate - i * 86_400_000
    const p = localParts(at, tz)
    cells.push({ at, ...p })
  }

  const weeks = []
  let col = []
  for (const cell of cells) {
    if (cell.weekday === 0 && col.length) {
      weeks.push(col)
      col = []
    }
    col.push(cell)
  }
  if (col.length) weeks.push(col)

  const monRow = (week) => [1, 2, 3, 4, 5, 6, 0].map((weekday) => week.find((c) => c.weekday === weekday) || null)

  return (
    <div className="overflow-x-auto" role="grid" aria-label="Month send plan">
      <div className="flex gap-2">
        <div className="send-plan-col pt-0.5">
          {WEEKDAY_MON.map((d) => (
            <span key={d} className="flex h-[11px] items-center text-[9px] text-slate-500" style={{ marginBottom: 3 }}>{d}</span>
          ))}
        </div>
        <div className="send-plan-grid">
          {weeks.map((week, wi) => (
            <div key={wi} className="send-plan-col">
              {monRow(week).map((cell, row) => {
                if (!cell) {
                  return <div key={row} style={{ width: 11, height: 11, marginBottom: 3 }} aria-hidden />
                }
                const items = buckets.get(cell.date) || []
                const open = isHourOpen(data.windows, cell.weekday, 12)
                const variant = blockVariant(items, open)
                const tip = items.length
                  ? items.slice(0, 3).map((m) => m.label || m.kind).join(', ')
                  : new Date(cell.at).toLocaleDateString(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
                return <PlanBlock key={row} variant={variant} title={tip} />
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Legend() {
  const items = [
    { variant: 'void', label: 'Closed' },
    { variant: 'open', label: 'Empty slot' },
    { variant: 'send-2', label: 'Scheduled' },
    { variant: 'pending', label: 'Needs OK' },
    { variant: 'sent', label: 'Sent' },
  ]
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
      {items.map(({ variant, label }) => (
        <span key={variant} className="inline-flex items-center gap-1">
          <span className={`send-plan-block send-plan-block--${variant}`} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  )
}

function ScheduledTimeline({ markers, tz, pending }) {
  const upcoming = markers
    .filter((m) => m.at && (m.kind === 'projected' || m.kind === 'queued'))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, 12)
  const sent = markers
    .filter((m) => m.kind === 'sent' && m.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 5)

  return (
    <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 lg:grid-cols-2">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scheduled to send</h3>
        {pending.length > 0 && (
          <ul className="mt-2 space-y-1">
            {pending.map((m) => (
              <li key={`p-${m.id}`} className="flex items-start gap-2 text-sm">
                <span className="send-plan-block send-plan-block--pending mt-0.5 shrink-0" aria-hidden />
                <span>
                  <span className="font-medium text-amber-900">Needs your OK</span>
                  {m.label ? ` — ${m.label}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {upcoming.length === 0 && !pending.length ? (
          <p className="mt-2 text-sm text-slate-500">Nothing scheduled yet.</p>
        ) : (
          <ol className="mt-2 space-y-1.5">
            {upcoming.map((m, i) => (
              <li key={`${m.kind}-${m.id || i}`} className="flex items-start gap-2 text-sm">
                <span className={`send-plan-block send-plan-block--${m.kind === 'queued' ? 'queued' : 'send-2'} mt-0.5 shrink-0`} aria-hidden />
                <span>
                  <span className="tabular-nums font-medium text-ink-900">{formatWhen(m.at, tz)}</span>
                  <span className="text-slate-500"> — {m.label || (m.kind === 'queued' ? 'Queued reply' : 'Campaign email')}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      {sent.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Already sent</h3>
          <ol className="mt-2 space-y-1.5">
            {sent.map((m, i) => (
              <li key={`s-${m.id || i}`} className="flex items-start gap-2 text-sm text-slate-600">
                <span className="send-plan-block send-plan-block--sent mt-0.5 shrink-0" aria-hidden />
                <span>
                  <span className="tabular-nums">{formatWhen(m.at, tz)}</span>
                  {m.label ? ` — ${m.label}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export default function SendScheduleGrid({ campaignId }) {
  const [view, setView] = useState('week')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const now = useMemo(() => Date.now(), [data])

  useEffect(() => {
    let live = true
    api.get(`/api/send-schedule?campaignId=${campaignId}&limit=150`)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e))
    return () => { live = false }
  }, [campaignId])

  const tz = data?.timezone || 'UTC'
  const buckets = useMemo(() => {
    if (!data) return new Map()
    if (view === 'day') {
      const today = localParts(now, tz).date
      return bucketMarkers(data.markers, tz, (at, zone) => {
        const p = localParts(at, zone)
        return p.date === today ? `h${p.hour}` : null
      })
    }
    if (view === 'week') {
      return bucketMarkers(data.markers, tz, (at, zone) => {
        const p = localParts(at, zone)
        return `${p.date}:h${p.hour}`
      })
    }
    return bucketMarkers(data.markers, tz, (at, zone) => localParts(at, zone).date)
  }, [data, view, now, tz])

  const pending = useMemo(() => (data?.markers || []).filter((m) => m.kind === 'pending'), [data])

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Send plan</h2>
          <p className="text-[11px] text-slate-500">
            {data?.hours ? data.hours : 'When emails leave'} — each block is a slot; filled = something scheduled.
          </p>
        </div>
        <div className="flex rounded border border-slate-200 p-0.5 text-[11px]" role="tablist" aria-label="Plan range">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`cursor-pointer px-2 py-0.5 ${view === v.id ? 'bg-slate-800 text-white font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {error && <p className="text-sm text-red-700">{error.message}</p>}
        {!data && !error && (
          <div className="send-plan-grid" aria-hidden>
            {Array.from({ length: 28 }, (_, i) => (
              <div key={i} className="send-plan-block send-plan-block--open opacity-40" />
            ))}
          </div>
        )}
        {data && !data.mailbox && <p className="text-sm text-amber-700">{data.note}</p>}
        {data?.mailbox && (
          <>
            {data.blocked && !data.markers.some((m) => m.kind === 'projected') && (
              <p className="mb-2 text-[11px] text-amber-800">{data.blocked.reason}</p>
            )}
            {view === 'day' && <DayGrid data={data} tz={tz} now={now} buckets={buckets} />}
            {view === 'week' && <WeekGrid data={data} tz={tz} now={now} buckets={buckets} />}
            {view === 'month' && <MonthGrid data={data} tz={tz} now={now} buckets={buckets} />}
            <Legend />
            <ScheduledTimeline markers={data.markers} tz={tz} pending={pending} />
            <p className="mt-3 text-[11px] text-slate-400">{data.note}</p>
          </>
        )}
      </div>
    </div>
  )
}
