// The metrics strip above the playbook.
//
// `GET /api/campaigns/:id/playbook-analytics` is the graph-aware variant of the
// campaign analytics route: same arithmetic all-time or windowed, and a rate is
// either a number with its denominator or an explicit null with a reason. A
// null is rendered as "not tracked" with that reason — never as 0%, because
// "we did not look" and "nobody opened" are different facts.
//
// No charts here. Charts live in Reports.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { qs } from '../api.js'
import { Panel, useResource, nfmt, messageOf } from './shared.jsx'

const RANGES = [
  { id: 'all', label: 'All time' },
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range' },
]

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400e3).toISOString()
}

export default function MetricsStrip({ campaignId, onOpenSetting }) {
  const [range, setRange] = useState('all')
  const [custom, setCustom] = useState({ from: '', to: '' })

  const window = useMemo(() => {
    if (range === '7') return { from: isoDaysAgo(7), to: new Date().toISOString() }
    if (range === '30') return { from: isoDaysAgo(30), to: new Date().toISOString() }
    if (range === 'custom' && custom.from && custom.to) {
      return { from: new Date(`${custom.from}T00:00:00Z`).toISOString(), to: new Date(`${custom.to}T23:59:59Z`).toISOString() }
    }
    return {}
  }, [range, custom])

  const { data, loading, error, reload } = useResource(
    `/api/campaigns/${campaignId}/playbook-analytics${qs(window)}`
  )

  const totals = data?.totals
  const rates = data?.rates || {}

  const tiles = [
    { key: 'sent', label: 'Sent', value: totals?.sent, caption: 'emails that left a mailbox' },
    { key: 'delivered', label: 'Delivered', value: totals?.delivered, caption: totals ? `${nfmt(totals.delivered)} of ${nfmt(totals.sent)} landed` : '' },
    { key: 'opened', label: 'Opened', value: totals?.opened, rate: rates.open, setting: 'Open tracking' },
    { key: 'clicked', label: 'Clicked', value: totals?.clicked, rate: rates.click, setting: 'Click tracking' },
    { key: 'replied', label: 'Replied', value: totals?.repliedLeads, rate: rates.reply, caption: 'leads that answered' },
    { key: 'bounced', label: 'Bounced', value: totals?.bounced, rate: rates.bounce },
    { key: 'unsubscribed', label: 'Unsubscribed', value: totals?.unsubscribed, rate: rates.unsubscribe },
    { key: 'won', label: 'Won', value: totals?.won, caption: 'leads with a won outcome' },
  ]

  return (
    <Panel
      id="metrics"
      title="Campaign performance"
      note="Test sends are excluded from every figure here. Charts and comparisons live in Reports."
      actions={
        <>
          <label className="text-xs text-slate-600">
            <span className="sr-only">Date range</span>
            <select className="input w-auto py-2" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          {range === 'custom' && (
            <>
              <label className="text-xs text-slate-600">
                From
                <input type="date" className="input mt-0.5 w-auto" value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600">
                To
                <input type="date" className="input mt-0.5 w-auto" value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </label>
            </>
          )}
          <button className="btn-ghost py-2" onClick={reload} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {messageOf(error)} — the figures below are the last ones that loaded.
        </p>
      )}

      {!data && loading ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-hidden>
          {tiles.map((t) => <div key={t.key} className="h-24 animate-pulse rounded-xl bg-slate-100" />)}
        </div>
      ) : !data ? (
        <p className="text-sm text-slate-500">No figures yet.</p>
      ) : data.noActivity ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-500">
          No emails sent {range === 'all' ? 'yet' : 'in this period'}
          {range === 'all' ? '.' : ' — widen the range to see earlier activity.'}
        </p>
      ) : (
        <>
          <dl className={`grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-4 ${error ? 'opacity-60' : ''}`}>
            {tiles.map((t) => (
              <div key={t.key} className="bg-white px-4 py-4">
                <dt className="text-xs font-medium text-slate-500">{t.label}</dt>
                <dd className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-900">{nfmt(t.value)}</dd>
                <dd className="mt-1 text-xs text-slate-400">
                  {t.rate
                    ? t.rate.value === null
                      ? (
                        <span className="text-amber-700">
                          not tracked — {t.rate.reason}
                          {onOpenSetting && (
                            <button type="button" className="ml-1 cursor-pointer underline" onClick={onOpenSetting}>
                              change {t.setting?.toLowerCase() || 'this setting'}
                            </button>
                          )}
                        </span>
                      )
                      : `${t.rate.value}% of ${nfmt(t.rate.denominator)}`
                    : t.caption}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-400">
            {data.window?.allTime ? 'All time' : `${String(data.window?.from).slice(0, 10)} to ${String(data.window?.to).slice(0, 10)}`}
            {' · computed '}{String(data.computedAt).slice(0, 19).replace('T', ' ')}
            {data.smallSample && ' · small sample — fewer than 30 emails, so these rates move a lot'}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Workspace-wide comparisons live in <Link className="text-accent-700 hover:underline" to="/app/reports">Reports</Link>.
          </p>
        </>
      )}
    </Panel>
  )
}
