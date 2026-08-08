import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Spinner, ErrorState, Icon, PageHeader, timeAgo } from '../ui.jsx'
import InboxPlacement from '../monitoring/InboxPlacement.jsx'

// Status colors as inline values (shared with the tick/goal bars below).
const DOT = { ok: '#34d399', warn: '#fbbf24', down: '#ef4444' }
// The dot beside a component is colour only, so the same judgement is carried
// as words for anyone who cannot see it.
const DOT_LABEL = { ok: 'Healthy', warn: 'Warning', down: 'Down' }
const ACCENT_BAR = 'rgba(23, 165, 131, 0.75)' // --color-accent-500 at 75%
const FAIL_BAR = 'rgba(239, 68, 68, 0.85)'
const KPI_TEXT = { good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-600', pending: 'text-slate-600' }
const KPI_LABEL = { good: 'On target', warn: 'Watch', bad: 'Off target', pending: 'Not enough data yet' }
const OVERALL = {
  operational: { label: 'All systems operational', cls: 'border-slate-300 bg-emerald-50 text-emerald-700', dot: DOT.ok },
  degraded: { label: 'Degraded — warnings present', cls: 'border-slate-300 bg-amber-50 text-amber-700', dot: DOT.warn },
  issues: { label: 'Issues detected', cls: 'border-slate-300 bg-red-50 text-red-700', dot: DOT.down },
}

export default function Monitoring() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setData(await api.get('/api/monitoring')); setError(null) } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!data) return <Spinner label="Loading monitoring…" />

  const { status, checks, successFactors, volume, goals, engine, ai, delivery, incidents } = data
  const overall = OVERALL[status] || OVERALL.operational

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring"
        lead="End-to-end health, refreshed every 5 seconds."
        actions={
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${overall.cls}`}>
            <span className="inline-block size-2 rounded-full" style={{ background: overall.dot }} aria-hidden />
            {overall.label}
          </span>
        }
      />

      {/* Component health: every hop of the pipeline */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {checks.map((c) => (
          <div key={c.id} className="card p-4">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 rounded-full" style={{ background: DOT[c.status] || '#5d7893' }} aria-hidden />
              <span className="text-sm font-semibold text-ink-900">{c.name}</span>
              <span className="sr-only">— {DOT_LABEL[c.status] || c.status}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{c.detail}</p>
          </div>
        ))}
      </div>

      {/* Success factors: outcome KPIs against cold-outreach thresholds */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Success factors <span className="text-slate-500 font-normal">— judged against cold-outreach benchmarks</span></h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {successFactors.map((f) => (
            <div key={f.key} className="rounded-lg bg-slate-100 p-3" title={f.hint}>
              <div className={`text-xl font-bold tabular-nums ${KPI_TEXT[f.status]}`}>{f.value}{f.unit}</div>
              <div className="text-xs text-slate-600 mt-0.5">{f.label}</div>
              <div className="text-[11px] text-slate-500 mt-1">Target {f.target}</div>
              <div className={`text-[11px] mt-0.5 ${KPI_TEXT[f.status]}`}>{KPI_LABEL[f.status]}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-slate-500">
          <Trend label="Sends" now={volume.sent7} prev={volume.sentPrev7} />
          <Trend label="Replies" now={volume.replies7} prev={volume.repliesPrev7} />
        </div>
      </section>

      {/* Goal progress */}
      {goals.length > 0 && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Goal progress</h2>
          <div className="space-y-2.5">
            {goals.map((g) => (
              <div key={g.id} className="flex items-center gap-3">
                <Link to="/app/goals" className="w-56 truncate text-sm text-slate-700 hover:text-accent-700" title={g.name}>{g.name}</Link>
                <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
                  <div className="h-full rounded" style={{ width: `${Math.max(2, g.pct)}%`, background: ACCENT_BAR }} />
                </div>
                <div className="w-24 text-right text-sm tabular-nums text-ink-900">{g.won}/{g.target} won</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Engine ticks */}
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-1">Engine <span className="text-slate-500 font-normal">— {engine.stats24.total} tick(s) in 24h, avg {engine.stats24.avgMs}ms</span></h2>
          <p className="text-xs text-slate-500 mb-3">
            {engine.lastTick ? `Last tick ${timeAgo(engine.lastTick)} — every ${engine.intervalMs / 1000}s` : 'No ticks recorded yet'}
          </p>
          {engine.ticks.length === 0 ? (
            <p className="text-sm text-slate-500">Tick durations chart here once the engine runs.</p>
          ) : (
            <TickBars ticks={engine.ticks} />
          )}
        </section>

        {/* AI calls */}
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-1">
            AI agent <span className="text-slate-500 font-normal">— {ai.stats24.total} call(s) in 24h, {ai.stats24.errors} failed, avg {ai.stats24.avgMs}ms</span>
          </h2>
          <p className="text-xs text-slate-500 mb-3">
            {ai.configuredKey ? `${ai.provider === 'openai' ? 'OpenAI' : 'Claude'} — ${ai.model}` : 'Template mode — no provider key configured'}
          </p>
          {ai.recent.length === 0 ? (
            <p className="text-sm text-slate-500">Provider calls (compose, classify, research, qualify) log here.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="py-1.5 font-medium">Operation</th>
                    <th className="py-1.5 font-medium text-right">Duration</th>
                    <th className="py-1.5 font-medium text-right">Result</th>
                    <th className="py-1.5 font-medium text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {ai.recent.map((c) => (
                    <tr key={c.id} className="border-b border-slate-200 last:border-0" title={c.detail || undefined}>
                      <td className="py-1.5 text-slate-700">{c.op || 'call'}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-600">{c.ms}ms</td>
                      <td className={`py-1.5 text-right text-xs ${c.ok ? 'text-emerald-700' : 'text-red-600'}`}>{c.ok ? 'ok' : 'failed'}</td>
                      <td className="py-1.5 text-right text-xs text-slate-400">{timeAgo(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Delivery: provider sends, inbound syncs, mailbox state */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Delivery <span className="text-slate-500 font-normal">
            — 24h: {delivery.sends24.total} send(s) ({delivery.sends24.errors} failed), {delivery.syncs24.total} inbound sync(s) ({delivery.syncs24.errors} failed)
          </span>
        </h2>
        {delivery.mailboxes.length === 0 ? (
          <p className="text-sm text-slate-500">No mailboxes connected — connect one from the Mailboxes page.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 font-medium">Mailbox</th>
                <th className="py-2 font-medium">Provider</th>
                <th className="py-2 font-medium text-right">Quota today</th>
                <th className="py-2 font-medium text-right">Last sync</th>
                <th className="py-2 font-medium text-right">Health</th>
              </tr>
            </thead>
            <tbody>
              {delivery.mailboxes.map((mb) => (
                <tr key={mb.id} className="border-b border-slate-200 last:border-0" title={mb.lastError || undefined}>
                  <td className="py-2 text-slate-700">{mb.email}</td>
                  <td className="py-2 text-slate-600">{mb.provider}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">{mb.remainingToday}/{mb.dailyLimit} left</td>
                  <td className="py-2 text-right text-xs text-slate-500">{mb.lastSyncAt ? timeAgo(mb.lastSyncAt) : '—'}</td>
                  <td className={`py-2 text-right text-xs ${mb.lastError ? 'text-red-600' : mb.status === 'connected' ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {mb.lastError ? `error — ${mb.lastError.slice(0, 60)}` : mb.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Inbox placement: the last hop before a prospect reads anything.
          The whole 28-endpoint smart-delivery category lives in this one
          section and the detail drawer it opens. */}
      <InboxPlacement />

      {/* Incident feed */}
      <section className="card">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <Icon name="alert" className={`size-4 ${incidents.length ? 'text-amber-700' : 'text-slate-400'}`} />
          <h2 className="text-sm font-semibold text-slate-700">Incidents <span className="text-slate-500 font-normal">({incidents.length})</span></h2>
        </div>
        {incidents.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-slate-500">No errors, stuck leads, or failed calls on record. Anything that goes wrong anywhere in the pipeline lands here.</p>
        ) : (
          <ul className="divide-y divide-slate-200 max-h-80 overflow-y-auto">
            {incidents.map((inc, i) => (
              <li key={i} className="px-4 py-2.5 text-sm flex items-start gap-3">
                <span className="mt-1 inline-block size-2 shrink-0 rounded-full" style={{ background: FAIL_BAR }} />
                <div className="min-w-0 flex-1">
                  <span className="text-slate-700" style={{ textTransform: 'capitalize' }}>{inc.label}</span>
                  <span className="text-slate-500 text-xs ml-2">{inc.source}</span>
                  {inc.detail && <div className="text-xs text-slate-500 truncate" title={inc.detail}>{inc.detail}</div>}
                </div>
                <span className="text-[11px] text-slate-400 shrink-0">{timeAgo(inc.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Trend({ label, now, prev }) {
  const diff = prev > 0 ? Math.round(((now - prev) / prev) * 100) : null
  return (
    <span>
      {label}: <span className="text-slate-700 tabular-nums">{now}</span> this week
      {diff !== null
        ? <span className={diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-amber-700' : 'text-slate-500'}> ({diff > 0 ? '+' : ''}{diff}% vs prior 7d)</span>
        : <span className="text-slate-400"> (no prior-week data)</span>}
    </span>
  )
}

// Tick durations, oldest to newest, one bar per tick. Red bars are failed ticks.
function TickBars({ ticks }) {
  const ordered = [...ticks].reverse()
  const max = Math.max(50, ...ordered.map((t) => t.ms))
  // A failed tick is otherwise only a red bar and a `title` — neither reaches a
  // screen reader, so the count goes into the label for the whole chart.
  const failed = ordered.filter((t) => !t.ok).length
  return (
    <div
      className="flex items-end" style={{ height: '5rem', gap: 3 }} role="img"
      aria-label={`Engine tick durations, oldest to newest — ${ordered.length} ticks, ${failed} failed`}
    >
      {ordered.map((t) => (
        <div
          key={t.id}
          className="flex-1 rounded"
          style={{
            height: `${Math.max(10, (t.ms / max) * 100)}%`,
            maxWidth: 12,
            background: t.ok ? ACCENT_BAR : FAIL_BAR,
          }}
          title={`${t.created_at} — ${t.ms}ms${t.detail ? ` — ${t.detail}` : ''}${t.ok ? '' : ' — FAILED'}`}
        />
      ))}
    </div>
  )
}
