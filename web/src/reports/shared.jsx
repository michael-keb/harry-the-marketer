// Shared plumbing for the Reports surfaces.
//
// Everything the eight Reports sections have in common lives here: one fetch
// hook, one offset pager, one number/rate formatter, one benchmark grader, and
// the three chart primitives the page is allowed to draw with (there is no
// charting library in this project and there must not be one).
//
// Two rules the specs repeat and this file enforces:
//   * a rate whose denominator is zero reads "—", never "0.0%";
//   * every chart carries a caption stating the takeaway plus a real data table,
//     so nothing is encoded in colour alone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'

// ------------------------------------------------------------------ colour ---

// Series colours, re-tuned for the white surface. The previous set was picked
// against ink and sat between 2.4:1 and 3.3:1 on white — under the 3:1 a chart
// mark needs, and `positive` was the weakest thing on the page. Same hues, each
// darkened until it clears 3:1 (most clear 4:1). Every series also carries a
// marker shape, because colour alone is not a key.
export const SERIES_COLORS = {
  sent: '#17876f',
  opened: '#3b6fb8',
  clicked: '#7c5cc4',
  replied: '#a06a1e',
  positive: '#1f8f62',
  bounced: '#c23b36',
  unsubscribed: '#6b7280',
  neutral: '#3b6fb8',
  negative: '#c23b36',
  uncategorised: '#6b7280',
}

// Chart furniture: gridlines and the area band behind a line series.
export const GRID_LINE = '#e1e8ed'
export const AXIS_TEXT = '#5d7893'
export const AREA_FILL = '#93a9be'

export const MARKERS = ['circle', 'square', 'triangle', 'diamond', 'cross']

// ------------------------------------------------------------------- time ----

export const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
})()

export function isoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400e3)
  return d.toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ numbers --

export const n = (v) => Number(v || 0).toLocaleString()

// A percentage the reader can trust. `denom` is the count the rate divides by:
// when it is zero the cell reads "—" rather than a confident 0.0%.
export function pctText(value, denom) {
  if (denom !== undefined && !(Number(denom) > 0)) return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  return `${num.toFixed(1)}%`
}

// "45 replies from 230 leads contacted" — the sentence behind a rate cell.
export const ofText = (num, den, whatNum, whatDen) =>
  `${n(num)} ${whatNum} from ${n(den)} ${whatDen}`

export function hoursText(hours) {
  const h = Number(hours || 0)
  if (!Number.isFinite(h) || h <= 0) return '—'
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 48) return `${Math.round(h * 10) / 10} h`
  return `${Math.round((h / 24) * 10) / 10} days`
}

// ---------------------------------------------------------------- grading ----

// The cold-outreach thresholds Monitoring already grades against
// (server/routes.js successFactors). Reports reuses them verbatim so the two
// screens can never disagree about what "good" is.
export const BENCHMARKS = {
  open_rate: { good: 40, warn: 25, target: '40% or more' },
  reply_rate: { good: 5, warn: 2, target: '5% or more' },
  positive_reply_rate: { good: 2, warn: 1, target: '2% or more' },
  win_rate: { good: 1, warn: 0.5, target: '1% or more' },
  unsubscribe_rate: { good: 2, warn: 5, target: '2% or less', invert: true },
  bounce_rate: { good: 2, warn: 5, target: '2% or less', invert: true },
  bounce_share: { good: 2, warn: 5, target: '2% or less', invert: true },
}

export const MIN_SAMPLE = 10

// 'good' | 'warn' | 'bad' | 'pending'. Below the minimum volume everything is
// 'pending', because grading eight sends as "off target" is noise, not signal.
export function gradeRate(metric, value, sample) {
  const bench = BENCHMARKS[metric]
  if (!bench) return 'pending'
  if (!(Number(sample) >= MIN_SAMPLE)) return 'pending'
  const v = Number(value || 0)
  if (bench.invert) return v <= bench.good ? 'good' : v <= bench.warn ? 'warn' : 'bad'
  return v >= bench.good ? 'good' : v >= bench.warn ? 'warn' : 'bad'
}

const GRADE_TEXT = { good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-600', pending: 'text-slate-600' }
const GRADE_WORD = { good: 'on target', warn: 'watch', bad: 'off target', pending: 'not enough data' }

// A graded rate. The verdict is a word, never only a colour.
export function GradedRate({ metric, value, sample, denom }) {
  const status = gradeRate(metric, value, sample)
  const text = pctText(value, denom === undefined ? sample : denom)
  const bench = BENCHMARKS[metric]
  return (
    <span
      className={`tabular-nums ${GRADE_TEXT[status]}`}
      title={bench ? `Target ${bench.target} — ${GRADE_WORD[status]}` : undefined}
    >
      {text}
      {text !== '—' && (
        <span className="sr-only"> ({GRADE_WORD[status]})</span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- fetching ---

// One GET, re-run whenever the querystring changes. On failure the previous
// payload is deliberately kept so a panel can stay readable and be marked stale
// rather than blanking to an error card.
export function useApi(path, params, { enabled = true } = {}) {
  const key = enabled && path ? `${path}${qs(params || {})}` : null
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(Boolean(key))
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    if (!key) {
      seq.current += 1
      setLoading(false)
      setError(null)
      return
    }
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    api.get(key).then(
      (res) => { if (seq.current === mine) { setData(res); setLoading(false) } },
      (err) => { if (seq.current === mine) { setError(err); setLoading(false) } },
    )
  }, [key, nonce])

  const reload = useCallback(() => setNonce((x) => x + 1), [])
  return { data, error, loading, reload, stale: Boolean(error && data) }
}

// Offset paging over a `{items, total, hasMore}` envelope. The analytics routes
// slice server-side and have no cursor, so "Load more" bumps the offset and
// appends.
export function usePagedApi(path, params, { limit = 50, enabled = true } = {}) {
  const key = enabled && path ? `${path}${qs(params || {})}` : null
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(Boolean(key))
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)

  const fetchAt = useCallback((offset, append) => {
    if (!key) return
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    api.get(`${key}${key.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`).then(
      (res) => {
        if (seq.current !== mine) return
        const rows = res.items ?? res.data ?? []
        setItems((prev) => (append ? [...prev, ...rows] : rows))
        setMeta(res)
        setLoading(false)
      },
      (err) => { if (seq.current === mine) { setError(err); setLoading(false) } },
    )
  }, [key, limit])

  useEffect(() => {
    if (!key) { seq.current += 1; setItems([]); setMeta(null); setLoading(false); return }
    fetchAt(0, false)
  }, [key, nonce, fetchAt])

  return {
    items,
    meta,
    error,
    loading,
    total: meta?.total ?? items.length,
    hasMore: Boolean(meta?.hasMore),
    loadMore: () => fetchAt(items.length, true),
    reload: () => setNonce((x) => x + 1),
    stale: Boolean(error && items.length),
  }
}

// ------------------------------------------------------------ 422 handling ---

// A 422 from the parity modules carries { field, message }. This finds the one
// that belongs to a given control so its message can be shown against it rather
// than as a page-level error.
export function fieldError(errors, fields) {
  const list = (Array.isArray(errors) ? errors : [errors]).filter(Boolean)
  for (const err of list) {
    if (err?.status !== 422) continue
    const field = err?.payload?.field
    if (field && fields.includes(field)) return { field, message: err.payload.message || err.message }
  }
  return null
}

export function FieldMessage({ error }) {
  if (!error) return null
  return (
    <p role="alert" className="mt-1 text-xs text-red-700">
      {error.message}
    </p>
  )
}

// ------------------------------------------------------------------ layout ---

// A panel with a heading, an optional one-line explanation, and honest states.
// Wide content scrolls inside this container; the page body never does.
export function Panel({ title, note, children, actions, id }) {
  return (
    <section className="card p-4" aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 id={id ? `${id}-h` : undefined} className="text-sm font-semibold text-slate-700">{title}</h3>
          {note && <p className="mt-1 text-xs text-slate-500 leading-relaxed max-w-3xl">{note}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function StaleMarker({ stale, error }) {
  if (!stale) return null
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-700" title={String(error?.message || '')}>
      may be out of date
    </span>
  )
}

// Wide tables live inside their own scroller so the page never scrolls sideways.
export function TableScroll({ children, label }) {
  return (
    <div className="overflow-x-auto -mx-4 px-4" tabIndex={0} role="group" aria-label={label}>
      {children}
    </div>
  )
}

export function SkeletonRows({ rows = 4, cols = 5 }) {
  return (
    <tbody aria-hidden>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-slate-200 last:border-0">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-3 py-2.5">
              <div className="h-3 rounded bg-slate-100 animate-pulse" style={{ width: c === 0 ? '70%' : '45%' }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

// ---------------------------------------------------------------- sorting ----

export function useSort(defaultKey, defaultDir = 'desc') {
  const [sort, setSort] = useState({ key: defaultKey, dir: defaultDir })
  const toggle = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))
  }, [])
  const apply = useCallback((rows) => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      let cmp
      if (typeof av === 'number' || typeof bv === 'number') cmp = Number(av || 0) - Number(bv || 0)
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [sort])
  return { sort, toggle, apply }
}

export function SortHeader({ label, sortKey, sort, onSort, align = 'right', title }) {
  const active = sort.key === sortKey
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      title={title}
      className={`px-3 py-2.5 font-medium whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`cursor-pointer inline-flex items-center gap-1 hover:text-ink-900 ${active ? 'text-accent-700' : ''}`}
      >
        {label}
        <span aria-hidden className="text-[9px]">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  )
}

// ----------------------------------------------------------------- charts ----

function Marker({ shape, cx, cy, color, size = 3.4 }) {
  const s = size
  if (shape === 'square') return <rect x={cx - s} y={cy - s} width={s * 2} height={s * 2} fill={color} />
  if (shape === 'triangle') return <polygon points={`${cx},${cy - s * 1.2} ${cx - s},${cy + s} ${cx + s},${cy + s}`} fill={color} />
  if (shape === 'diamond') return <polygon points={`${cx},${cy - s * 1.3} ${cx + s * 1.1},${cy} ${cx},${cy + s * 1.3} ${cx - s * 1.1},${cy}`} fill={color} />
  if (shape === 'cross') {
    return (
      <g stroke={color} strokeWidth="1.8">
        <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} />
        <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} />
      </g>
    )
  }
  return <circle cx={cx} cy={cy} r={s} fill={color} />
}

export function ChartLegend({ series }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 mb-2">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            <Marker shape={s.marker || MARKERS[i % MARKERS.length]} cx={6} cy={6} color={s.color} size={3.6} />
          </svg>
          {s.label}
        </li>
      ))}
    </ul>
  )
}

// A dense day-by-day line chart. A day with no activity is a point at zero, not
// a gap — the whole point of the server returning dense days.
export function DaySeriesChart({
  days, series, caption, unit = 'emails', xLabel = 'Date', yLabel,
  maturingDays = 0, maturingNote,
}) {
  const [hover, setHover] = useState(null)
  const rows = days || []
  const cols = series || []

  const max = useMemo(() => Math.max(
    1,
    ...rows.flatMap((d) => cols.map((s) => Number(d[s.key] || 0))),
  ), [rows, cols])

  if (!rows.length) return null

  const W = 760
  const H = 230
  const PAD = { l: 46, r: 14, t: 14, b: 40 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const x = (i) => PAD.l + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW)
  const y = (v) => PAD.t + plotH - (Number(v || 0) / max) * plotH
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7))
  const markerEvery = Math.max(1, Math.ceil(rows.length / 45))
  const maturingFrom = maturingDays > 0 ? Math.max(0, rows.length - maturingDays) : -1

  return (
    <figure className="m-0">
      <ChartLegend series={cols} />
      <div className="overflow-x-auto">
        <div className="relative min-w-[320px]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label={caption}
            onMouseLeave={() => setHover(null)}
          >
            {/* gridlines + y axis, in whole units */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke={GRID_LINE} strokeWidth="1" />
                <text x={PAD.l - 6} y={y(max * f) + 3.5} textAnchor="end" fontSize="9" fill="#5d7893">
                  {Math.round(max * f)}
                </text>
              </g>
            ))}
            {maturingFrom >= 0 && maturingFrom < rows.length && (
              <rect
                x={x(maturingFrom)} y={PAD.t} width={Math.max(2, x(rows.length - 1) - x(maturingFrom))} height={plotH}
                fill={AREA_FILL} opacity="0.18"
              />
            )}
            {cols.map((s, si) => (
              <g key={s.key}>
                <polyline
                  fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round"
                  points={rows.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')}
                />
                {rows.map((d, i) => (i % markerEvery === 0 ? (
                  <Marker
                    key={d.day || d.date || i}
                    shape={s.marker || MARKERS[si % MARKERS.length]}
                    cx={x(i)} cy={y(d[s.key])} color={s.color}
                  />
                ) : null))}
              </g>
            ))}
            {rows.map((d, i) => (
              <g key={`hit-${d.day || d.date || i}`}>
                <rect
                  x={x(i) - plotW / (rows.length * 2 || 1)} y={PAD.t}
                  width={Math.max(4, plotW / (rows.length || 1))} height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover({ i, row: d })}
                />
                {i % labelEvery === 0 && (
                  <text x={x(i)} y={H - 18} textAnchor="middle" fontSize="9" fill="#5d7893">
                    {String(d.day || d.date || '').slice(5)}
                  </text>
                )}
              </g>
            ))}
            <text x={PAD.l + plotW / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#5d7893">{xLabel}</text>
            <text
              x={12} y={PAD.t + plotH / 2} textAnchor="middle" fontSize="9" fill="#5d7893"
              transform={`rotate(-90 12 ${PAD.t + plotH / 2})`}
            >
              {yLabel || `Count (${unit})`}
            </text>
          </svg>
          {hover && (
            <div
              className="absolute pointer-events-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs shadow-xl z-10"
              style={{ left: `${(x(hover.i) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}
            >
              <div className="text-slate-700 font-medium mb-0.5">{hover.row.day || hover.row.date}</div>
              {cols.map((s) => (
                <div key={s.key} style={{ color: s.color }}>{s.label}: {n(hover.row[s.key])}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-slate-500 leading-relaxed">
        {caption}
        {maturingNote && maturingDays > 0 && <> {maturingNote}</>}
      </figcaption>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-600 hover:text-accent-700">
          Show the {rows.length} day{rows.length === 1 ? '' : 's'} as a table
        </summary>
        <TableScroll label="Day-by-day figures">
          <table className="w-full text-xs mt-2">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th scope="col" className="py-1.5 pr-3">Date</th>
                {cols.map((s) => <th key={s.key} scope="col" className="py-1.5 pr-3 text-right">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.day || d.date} className="border-b border-slate-200 last:border-0">
                  <th scope="row" className="py-1 pr-3 font-normal text-slate-600">{d.day || d.date}</th>
                  {cols.map((s) => (
                    <td key={s.key} className="py-1 pr-3 text-right tabular-nums text-slate-700">{n(d[s.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </figure>
  )
}

// Horizontal bars with the value always printed beside the bar. The bar itself
// is decorative; the numbers carry the meaning.
export function HBars({ rows, caption, unit = '', labelWidth = 'w-32' }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value || 0)))
  return (
    <figure className="m-0">
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <div className={`${labelWidth} shrink-0 text-xs text-slate-600 truncate`} title={r.label}>{r.label}</div>
            <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden" aria-hidden>
              <div
                className="h-full rounded"
                style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (Number(r.value || 0) / max) * 100)}%`, background: r.color || SERIES_COLORS.sent }}
              />
            </div>
            <div className="w-28 shrink-0 text-right text-sm tabular-nums text-ink-900">
              {n(r.value)}{unit}
              {r.hint && <span className="ml-1 text-xs text-slate-500">{r.hint}</span>}
            </div>
          </div>
        ))}
      </div>
      {caption && <figcaption className="mt-2 text-xs text-slate-500">{caption}</figcaption>}
    </figure>
  )
}

// A single 100%-wide bar split into labelled segments. Counts and shares are
// always visible in text beneath it, never only on hover.
export function SplitBar({ segments, total, caption }) {
  const sum = Number(total || segments.reduce((a, s) => a + Number(s.value || 0), 0))
  return (
    <figure className="m-0">
      <div className="flex h-5 w-full overflow-hidden rounded-md bg-slate-100" aria-hidden>
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${sum > 0 ? (Number(s.value || 0) / sum) * 100 : 0}%`, background: s.color }}
            title={`${s.label}: ${n(s.value)}`}
          />
        ))}
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {segments.map((s) => (
          <div key={s.key} className="flex items-baseline gap-1.5">
            <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden><rect width="12" height="12" fill={s.color} /></svg>
            <dt className="text-slate-600">{s.label}</dt>
            <dd className="tabular-nums text-ink-900">
              {n(s.value)} <span className="text-slate-500">({pctText(sum > 0 ? (Number(s.value || 0) / sum) * 100 : 0, sum)})</span>
            </dd>
          </div>
        ))}
      </dl>
      {caption && <figcaption className="mt-2 text-xs text-slate-500 leading-relaxed">{caption}</figcaption>}
    </figure>
  )
}

// A caption naming the window every ranged panel was computed over.
export function RangeCaption({ range, extra }) {
  if (!range) return null
  return (
    <span className="text-xs text-slate-500">
      {range.from} to {range.to} ({range.days} day{range.days === 1 ? '' : 's'}, {range.timezone})
      {extra ? ` — ${extra}` : ''}
    </span>
  )
}
