// Team — who did what in the range.
//
// Route: GET /api/analytics/team.
//
// Deliberately not a leaderboard: everyone sees the same numbers, inactive
// members are listed with zeros rather than dropped, and each column states how
// it is attributed so nobody has to guess what they are being measured on.
//
// This lives in Settings → Team, under the member list, and its spec is
// insistent that it must NOT appear on the Dashboard or Reports. That is a
// product judgement rather than a layout preference: on Reports it sits beside
// campaign performance and reads as a scoreboard ranking colleagues, which is
// what turns "who is handling replies" into something people manage upward for.
// Under the member list it reads as what it is — context for a conversation
// about workload. It was on Reports; this is the move.
//
// A solo workspace renders nothing at all. A table of one row comparing you to
// yourself is noise, and the spec asks for absence rather than an empty state.

import { ErrorState, LoadMore } from '../parity-ui.jsx'
import {
  Panel, RangeCaption, SkeletonRows, SortHeader, StaleMarker, TableScroll,
  n, usePagedApi, useSort,
} from '../reports/shared.jsx'

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

// Settings has no range picker, so the panel owns its own window: the last 30
// days, stated in the caption rather than assumed. The figures are for a
// conversation about the current stretch of work, and a range control here
// would invite exactly the retrospective slicing the placement is meant to
// avoid.
const LAST_30_DAYS = (() => {
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  return { from: day(-29), to: day(0) }
})()

export default function TeamActivity({ params = LAST_30_DAYS }) {
  const list = usePagedApi('/api/analytics/team', params, { limit: 100 })
  const { sort, toggle, apply } = useSort('replies_handled', 'desc')
  const rows = apply(list.items)

  // An error hides the table and leaves membership management working, which is
  // the more important half of this page.
  if (list.error && !list.items.length) {
    return <Panel id="team-activity" title="Team activity"><ErrorState error={list.error} onRetry={list.reload} /></Panel>
  }
  // Solo workspace: render nothing. Not an empty state — the spec asks for the
  // panel to be hidden entirely, and it is right that a workspace of one is
  // never shown a scoreboard of itself.
  if (!list.loading && list.items.length <= 1) return null

  return (
    <Panel
      id="team-activity"
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
