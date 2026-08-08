// Team — who did what in the range.
//
// Route: GET /api/analytics/team.
//
// Deliberately not a leaderboard: everyone sees the same numbers, inactive
// members are listed with zeros rather than dropped, and each column states how
// it is attributed so nobody has to guess what they are being measured on.

import { EmptyState, ErrorState, LoadMore } from '../parity-ui.jsx'
import {
  Panel, RangeCaption, SkeletonRows, SortHeader, StaleMarker, TableScroll,
  n, usePagedApi, useSort,
} from './shared.jsx'

const COLUMNS = [
  { key: 'campaigns_created', label: 'Campaigns', title: 'Campaigns created in the range, attributed to the campaign owner' },
  { key: 'leads_assigned', label: 'Leads assigned', title: 'Leads assigned to this person inside the range' },
  { key: 'approvals', label: 'Approvals', title: 'Queued emails approved or sent after review' },
  { key: 'declines', label: 'Declines', title: 'Queued emails declined at review' },
  { key: 'replies_handled', label: 'Replies handled', title: 'Replies on leads assigned to this person, counted on the reply date' },
  { key: 'notes_written', label: 'Notes', title: 'Lead notes written in the range' },
  { key: 'tasks_created', label: 'Tasks', title: 'Lead tasks created in the range' },
  { key: 'average_reply_seconds', label: 'Avg reply time', title: 'Average gap between an inbound reply and the next manual outbound on that thread' },
]

export default function TeamTab({ params }) {
  const list = usePagedApi('/api/analytics/team', params, { limit: 100 })
  const { sort, toggle, apply } = useSort('replies_handled', 'desc')
  const rows = apply(list.items)

  if (list.error && !list.items.length) {
    return <Panel id="team" title="Team activity"><ErrorState error={list.error} onRetry={list.reload} /></Panel>
  }
  // A solo workspace has one member and nothing to compare, so the panel is
  // absent rather than a table of one row.
  if (!list.loading && list.items.length <= 1) {
    return (
      <EmptyState
        icon="leads"
        title="This is a solo workspace"
        hint="Team activity appears once you invite someone. Inviting a teammate is done from Settings."
      />
    )
  }

  return (
    <Panel
      id="team"
      title="Team activity"
      note="Everyone in the workspace sees the same figures — a hidden scoreboard is worse than an open one. Members with no activity in the range are listed with zeros rather than left out."
      actions={<>
        <RangeCaption range={list.meta?.range} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      <TableScroll label="Team activity">
        <table className="w-full min-w-[860px] text-sm">
          <caption className="sr-only">
            Team activity from {list.meta?.range?.from} to {list.meta?.range?.to} ({list.meta?.range?.timezone})
          </caption>
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <SortHeader label="Member" sortKey="email" sort={sort} onSort={toggle} align="left" />
              <SortHeader label="Role" sortKey="role" sort={sort} onSort={toggle} align="left" />
              {COLUMNS.map((c) => (
                <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={toggle} title={c.title} />
              ))}
            </tr>
          </thead>
          {list.loading && !rows.length ? <SkeletonRows rows={3} cols={10} /> : (
            <tbody>
              {rows.map((m) => (
                <tr key={m.email} className="border-b border-slate-200 last:border-0">
                  <th scope="row" className="px-3 py-2.5 text-left font-normal">
                    <span className="inline-flex items-center gap-2">
                      <span className="flex size-6 items-center justify-center rounded-full bg-slate-200 text-[10px] uppercase text-slate-700" aria-hidden>
                        {String(m.email || '?').slice(0, 2)}
                      </span>
                      <span className="text-ink-900">{m.email}</span>
                    </span>
                  </th>
                  <td className="px-3 py-2.5 text-slate-600">
                    {m.role}{m.status && m.status !== 'active' ? ` (${m.status})` : ''}
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="px-3 py-2.5 text-right tabular-nums">
                      {c.key === 'average_reply_seconds'
                        ? (m.average_reply_seconds > 0 ? m.average_reply_time : '—')
                        : n(m[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </TableScroll>
      <p className="mt-3 text-xs text-slate-500 leading-relaxed">
        Average reply time is the gap between a lead's reply and the next email a person actually typed on that thread,
        attributed to whoever the lead is assigned to. Threads still waiting for an answer are not counted, so this figure
        describes the replies that were handled, not the ones that were not.
      </p>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
    </Panel>
  )
}
