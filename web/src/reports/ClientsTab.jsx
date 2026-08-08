// Clients — only meaningful for a workspace that actually has clients, which
// most will not. When there are none the tab says so plainly instead of drawing
// an empty table.
//
// Routes: GET /api/analytics/clients/performance,
//         GET /api/analytics/clients/monthly-active.

import { useState } from 'react'
import { EmptyState, ErrorState, LiveRegion, LoadMore } from '../parity-ui.jsx'
import {
  GradedRate, Panel, RangeCaption, SkeletonRows, SortHeader, StaleMarker, TableScroll,
  SERIES_COLORS, n, ofText, pctText, useApi, usePagedApi, useSort,
} from './shared.jsx'

export default function ClientsTab({ params, clients, clientId, timezone }) {
  if (!clients.length) {
    return (
      <EmptyState
        icon="leads"
        title="No clients in this workspace"
        hint="Clients group campaigns for agencies and consultants reporting to someone else. Add one from Settings and this tab fills in — until then there is nothing honest to show here."
      />
    )
  }
  return (
    <div className="space-y-4">
      <ClientPerformance params={params} clientId={clientId} />
      <MonthlyActive clientId={clientId} timezone={timezone} />
    </div>
  )
}

// --- per-client performance --------------------------------------------------

function ClientPerformance({ params, clientId }) {
  const [copied, setCopied] = useState('')
  const list = usePagedApi(
    '/api/analytics/clients/performance',
    { ...params, client_ids: clientId || undefined },
    { limit: 25 },
  )
  const { sort, toggle, apply } = useSort('sent', 'desc')
  const rows = apply(list.items)
  const unassigned = list.meta?.unassigned
  const range = list.meta?.range

  const copy = async (row) => {
    const line = [
      `${row.name} — ${range?.from} to ${range?.to} (${range?.timezone})`,
      `${n(row.sent)} emails sent to ${n(row.unique_lead_count)} leads`,
      `open ${pctText(row.open_rate, row.sent)} (per email sent)`,
      `reply ${pctText(row.reply_rate, row.unique_lead_count)} (per lead contacted)`,
      `positive ${pctText(row.positive_reply_rate, row.unique_lead_count)}`,
      `bounce ${pctText(row.bounce_rate, row.unique_lead_count)}`,
      `${n(row.won)} won`,
    ].join(' · ')
    try {
      await navigator.clipboard.writeText(line)
      setCopied(row.name)
      setTimeout(() => setCopied(''), 2500)
    } catch {
      setCopied('')
    }
  }

  return (
    <Panel
      id="client-performance"
      title="Client performance"
      note="One row per client, summed across that client's campaigns. Client health is the share of contacted leads who replied positively — the outcome the work exists for, not the absence of a failure. Campaigns with no client are reported separately below rather than folded in or hidden."
      actions={<><RangeCaption range={range} /><StaleMarker stale={list.stale} error={list.error} /></>}
    >
      {/* The button's label swaps to "Copied" in place, which focus never
          revisits — so the result is announced here instead. */}
      <LiveRegion message={copied ? `${copied} summary copied to the clipboard` : ''} />
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Client performance">
            <table className="w-full min-w-[820px] text-sm">
              <caption className="sr-only">
                Performance per client from {range?.from} to {range?.to} ({range?.timezone})
              </caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Client" sortKey="name" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} />
                  <SortHeader label="Leads" sortKey="unique_lead_count" sort={sort} onSort={toggle} title="Distinct leads contacted" />
                  <SortHeader label="Open rate" sortKey="open_rate" sort={sort} onSort={toggle} title="Opens per email sent" />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Leads that replied per lead contacted" />
                  <SortHeader label="Positive" sortKey="positive_reply_rate" sort={sort} onSort={toggle} title="Leads with a positive reply per lead contacted" />
                  <SortHeader label="Won" sortKey="won" sort={sort} onSort={toggle} />
                  <SortHeader label="Client health" sortKey="client_health" sort={sort} onSort={toggle} title="Share of contacted leads who replied positively" />
                  <th scope="col" className="px-3 py-2.5 font-medium text-right">Summary</th>
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={3} cols={9} /> : (
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.client_id} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink-900">{c.name}</th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(c.opened, c.sent, 'opens', 'emails sent')}>{pctText(c.open_rate, c.sent)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.replied_leads, c.unique_lead_count, 'leads replied', 'leads contacted')}>
                        <GradedRate metric="reply_rate" value={c.reply_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <GradedRate metric="positive_reply_rate" value={c.positive_reply_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.won)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(c.sent - c.bounced, c.sent, 'clean sends', 'emails sent')}>
                        {pctText(c.client_health, c.sent)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" className="cursor-pointer text-xs text-slate-600 hover:text-accent-700" onClick={() => copy(c)}>
                          {copied === c.name ? 'Copied' : 'Copy'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {unassigned && unassigned.sent > 0 && (
                    <tr className="border-t border-slate-300 bg-slate-100/40 text-slate-600">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">Campaigns with no client</th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(unassigned.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(unassigned.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(unassigned.open_rate, unassigned.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(unassigned.reply_rate, unassigned.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(unassigned.positive_reply_rate, unassigned.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(unassigned.won)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(unassigned.client_health, unassigned.sent)}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">No sends between {range?.from} and {range?.to}.</p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- active clients per month ------------------------------------------------

function MonthlyActive({ clientId, timezone }) {
  const { data, error, loading, reload, stale } = useApi('/api/analytics/clients/monthly-active', {
    months: 24, timezone, client_ids: clientId || undefined,
  })
  const items = data?.items || []

  if (error && !data) {
    return <Panel id="monthly-active" title="Active clients per month"><ErrorState error={error} onRetry={reload} /></Panel>
  }
  if (loading && !data) {
    return <Panel id="monthly-active" title="Active clients per month"><div className="h-32 rounded-lg bg-slate-100 animate-pulse" aria-hidden /></Panel>
  }
  // The server returns [] rather than two years of zeros for a workspace with
  // no clients; the panel disappears rather than drawing an empty axis.
  if (!data || items.length === 0) return null

  const max = Math.max(1, ...items.map((m) => m.count))
  const W = 760
  const H = 170
  const PAD = { l: 32, r: 10, t: 12, b: 34 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const bandW = plotW / items.length
  const barW = Math.max(3, Math.min(24, bandW - 4))
  const labelEvery = Math.max(1, Math.ceil(items.length / 8))

  return (
    <Panel
      id="monthly-active"
      title="Active clients per month"
      note="A client counts as active in a month when at least one of its campaigns sent an email that month — activity, not when the client record was created. Bounded to the last 24 months."
      actions={<StaleMarker stale={stale} error={error} />}
    >
      <figure className="m-0">
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[320px]" role="img"
            aria-label={`Active clients per month for the last ${items.length} months, peaking at ${max}`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH - f * plotH} y2={PAD.t + plotH - f * plotH} stroke="#e1e8ed" strokeWidth="1" />
                <text x={PAD.l - 6} y={PAD.t + plotH - f * plotH + 3.5} textAnchor="end" fontSize="9" fill="#5d7893">{Math.round(max * f)}</text>
              </g>
            ))}
            {items.map((m, i) => {
              const h = (m.count / max) * plotH
              const cx = PAD.l + i * bandW + bandW / 2
              return (
                <g key={m.month}>
                  {/* A zero month is a zero bar, not a gap in the axis. */}
                  <rect
                    x={cx - barW / 2} y={PAD.t + plotH - h} width={barW} height={Math.max(h, m.count > 0 ? 2 : 0)}
                    rx="2" fill={SERIES_COLORS.sent}
                  >
                    <title>{m.month}: {m.count} active client{m.count === 1 ? '' : 's'}</title>
                  </rect>
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 16} textAnchor="middle" fontSize="9" fill="#5d7893">{m.month.slice(2)}</text>
                  )}
                </g>
              )
            })}
            <text x={PAD.l + plotW / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#5d7893">Month ({data.timezone})</text>
          </svg>
        </div>
        <figcaption className="mt-2 text-xs text-slate-500">
          Active clients per month over the last {items.length} months, in {data.timezone}. Months with no sending are drawn as zero.
        </figcaption>
      </figure>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-600 hover:text-accent-700">Show the months as a table</summary>
        <TableScroll label="Active clients per month">
          <table className="w-full text-xs mt-2">
            <caption className="sr-only">Active clients per month</caption>
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th scope="col" className="py-1.5 pr-3">Month</th>
                <th scope="col" className="py-1.5 text-right">Active clients</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.month} className="border-b border-slate-200 last:border-0">
                  <th scope="row" className="py-1 pr-3 font-normal text-slate-600">{m.month}</th>
                  <td className="py-1 text-right tabular-nums text-slate-700">{n(m.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </Panel>
  )
}
