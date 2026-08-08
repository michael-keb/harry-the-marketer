// Campaigns — per-campaign performance, the reply-intent mix per campaign, the
// campaign state strip and the first-email versus follow-up comparison.
//
// Routes: GET /api/analytics/campaigns/performance,
//         GET /api/analytics/campaigns/response-stats,
//         GET /api/analytics/campaigns/status-counts,
//         GET /api/analytics/followup-reply-rate.

import { Link } from 'react-router-dom'
import { Badge } from '../ui.jsx'
import { EmptyState, ErrorState, LoadMore } from '../parity-ui.jsx'
import {
  GradedRate, Panel, RangeCaption, SkeletonRows, SortHeader, StaleMarker, TableScroll,
  SERIES_COLORS, n, ofText, pctText, useApi, usePagedApi, useSort,
} from './shared.jsx'

const INTENT_SEGMENTS = [
  { key: 'positive', label: 'Positive', color: SERIES_COLORS.positive },
  { key: 'neutral', label: 'Neutral', color: SERIES_COLORS.neutral },
  { key: 'negative', label: 'Negative', color: SERIES_COLORS.negative },
  { key: 'uncategorised', label: 'Uncategorised', color: SERIES_COLORS.uncategorised },
]

export default function CampaignsTab({ params }) {
  return (
    <div className="space-y-4">
      <StatusStrip />
      <FollowUpComparison params={params} />
      <PerformanceTable params={params} />
      <ResponseStats params={params} />
    </div>
  )
}

// --- campaign states ---------------------------------------------------------

function StatusStrip() {
  const { data, error, loading } = useApi('/api/analytics/campaigns/status-counts', { limit: 50 })
  // A wrong count is worse than no count: on error the strip disappears.
  if (error || (!loading && !data)) return null
  const rows = data?.items || []

  return (
    <Panel
      id="status-counts"
      title="Campaign states"
      note="“Holding” is a running campaign whose sending window is shut right now — it is derived from your schedule, not stored."
    >
      {loading && !data ? (
        <div className="flex gap-2" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="h-7 w-24 rounded-full bg-slate-100 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No campaigns yet. <Link to="/app/campaigns" className="text-accent-700 hover:underline">Create your first campaign</Link>.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((r) => (
            <li key={r.status}>
              <Link
                to={`/app/campaigns?status=${encodeURIComponent(r.status)}`}
                className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-accent-500 hover:text-accent-700"
              >
                <span className="tabular-nums font-medium">{n(r.count)}</span>
                {String(r.status).replace('_', ' ')}
              </Link>
            </li>
          ))}
          <li className="self-center text-xs text-slate-500">{n(data.campaigns_total)} campaigns in total</li>
        </ul>
      )}
    </Panel>
  )
}

// --- first email vs follow-up ------------------------------------------------

function FollowUpComparison({ params }) {
  const { data, error, loading, reload, stale } = useApi('/api/analytics/followup-reply-rate', params)

  return (
    <Panel
      id="followup"
      title="First emails versus follow-ups"
      note="A follow-up is a send reached by a “no reply” or “after” edge in the playbook; a first email is one reached straight from Start; a conversation reply is neither and is listed separately."
      actions={<><RangeCaption range={data?.range} /><StaleMarker stale={stale} error={error} /></>}
    >
      {loading && !data ? (
        <div className="h-16 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : (
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg bg-slate-100 px-3 py-2.5">
            <dt className="text-xs text-slate-600">First-email reply rate</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">
              {pctText(data.first_email_rate, data.first_sent)}
            </dd>
            <dd className="mt-0.5 text-[11px] text-slate-500">{ofText(data.first_replies, data.first_sent, 'replies', 'first emails')}</dd>
          </div>
          <div className="rounded-lg bg-slate-100 px-3 py-2.5">
            <dt className="text-xs text-slate-600">Follow-up reply rate</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">
              {pctText(data.rate, data.followups_sent)}
            </dd>
            <dd className="mt-0.5 text-[11px] text-slate-500">
              {data.followups_sent > 0
                ? ofText(data.followup_replies, data.followups_sent, 'replies', 'follow-ups')
                : `No follow-ups sent between ${data.range?.from} and ${data.range?.to}`}
            </dd>
          </div>
          <div className="rounded-lg bg-slate-100 px-3 py-2.5">
            <dt className="text-xs text-slate-600">Conversation replies</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">{n(data.conversation_sent)}</dd>
            <dd className="mt-0.5 text-[11px] text-slate-500">
              emails sent along a reply edge, earning {n(data.conversation_replies)} answers.
              {data.uncategorised_sent > 0 && ` ${n(data.uncategorised_sent)} send(s) could not be traced to a playbook edge.`}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  )
}

// --- per-campaign performance ------------------------------------------------

function PerformanceTable({ params }) {
  const list = usePagedApi('/api/analytics/campaigns/performance', params, { limit: 50 })
  const { sort, toggle, apply } = useSort('reply_rate', 'desc')
  const rows = apply(list.items)
  const ws = list.meta?.workspace

  return (
    <Panel
      id="campaign-performance"
      title="Campaign performance"
      note="Open and click rates are per email sent. Reply, positive-reply, win, unsubscribe and bounce rates are per lead contacted, so they match every other rate in the product. Positive replies are attributed to the day the reply arrived, which is a different axis from the send counts beside them."
      actions={<>
        <RangeCaption range={list.meta?.range} extra={`${n(list.total)} campaigns`} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Campaign performance">
            <table className="w-full min-w-[900px] text-sm">
              <caption className="sr-only">
                Per-campaign performance from {list.meta?.range?.from} to {list.meta?.range?.to} ({list.meta?.range?.timezone})
              </caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Campaign" sortKey="name" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} title="Emails sent in the range" />
                  <SortHeader label="Leads" sortKey="unique_lead_count" sort={sort} onSort={toggle} title="Distinct leads contacted — not additive across ranges" />
                  <SortHeader label="Open rate" sortKey="open_rate" sort={sort} onSort={toggle} title="Opens per email sent" />
                  <SortHeader label="Click rate" sortKey="click_rate" sort={sort} onSort={toggle} title="Clicks per email sent" />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Leads that replied per lead contacted" />
                  <SortHeader label="Positive" sortKey="positive_reply_rate" sort={sort} onSort={toggle} title="Leads with a positive reply per lead contacted" />
                  <SortHeader label="Bounce rate" sortKey="bounce_rate" sort={sort} onSort={toggle} title="Bounced leads per lead contacted" />
                  <SortHeader label="Unsub rate" sortKey="unsubscribe_rate" sort={sort} onSort={toggle} title="Unsubscribes per lead contacted" />
                  <SortHeader label="Won" sortKey="won" sort={sort} onSort={toggle} />
                  <SortHeader label="Leads per reply" sortKey="leads_per_reply" sort={sort} onSort={toggle} title="Leads to contact for one reply" />
                </tr>
              </thead>
              {list.loading && !rows.length ? (
                <SkeletonRows rows={5} cols={11} />
              ) : (
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.campaign_id} className="border-b border-slate-200 last:border-0 hover:bg-slate-100/40">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">
                        <Link to={`/app/campaigns/${c.campaign_id}`} className="text-ink-900 hover:text-accent-700">{c.name}</Link>
                        <span className="ml-2 align-middle"><Badge value={c.status} /></span>
                      </th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.opened, c.sent, 'opens', 'emails sent')}>
                        <GradedRate metric="open_rate" value={c.open_rate} sample={c.unique_lead_count} denom={c.sent} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(c.clicked, c.sent, 'clicks', 'emails sent')}>
                        {pctText(c.click_rate, c.sent)}
                      </td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.replied_leads, c.unique_lead_count, 'leads replied', 'leads contacted')}>
                        <GradedRate metric="reply_rate" value={c.reply_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.positive_replied, c.unique_lead_count, 'positive replies', 'leads contacted')}>
                        <GradedRate metric="positive_reply_rate" value={c.positive_reply_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.bounced_leads, c.unique_lead_count, 'bounced leads', 'leads contacted')}>
                        <GradedRate metric="bounce_rate" value={c.bounce_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right" title={ofText(c.unsubscribed, c.unique_lead_count, 'unsubscribes', 'leads contacted')}>
                        <GradedRate metric="unsubscribe_rate" value={c.unsubscribe_rate} sample={c.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(c.won)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{c.replied_leads > 0 ? n(c.leads_per_reply) : '—'}</td>
                    </tr>
                  ))}
                  {ws && rows.length > 0 && (
                    <tr className="border-t border-slate-300 bg-slate-100/40 text-slate-700">
                      <th scope="row" className="px-3 py-2.5 text-left font-medium">Whole workspace</th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(ws.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(ws.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.open_rate, ws.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.click_rate, ws.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.reply_rate, ws.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.positive_reply_rate, ws.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.bounce_rate, ws.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(ws.unsubscribe_rate, ws.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(ws.won)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{ws.replied_leads > 0 ? n(ws.leads_per_reply) : '—'}</td>
                    </tr>
                  )}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              No campaigns sent between {list.meta?.range?.from} and {list.meta?.range?.to}.
            </p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- reply intent per campaign -----------------------------------------------

function ResponseStats({ params }) {
  const list = usePagedApi('/api/analytics/campaigns/response-stats', params, { limit: 25 })
  const totals = list.meta?.totals
  const withReplies = list.items.filter((c) => c.total > 0)

  return (
    <Panel
      id="response-stats"
      title="Reply intent by campaign"
      note="Counts are reply emails, not distinct leads, and they sit on the day the reply arrived. “Uncategorised” is a reply whose intent the classifier could not place — it is not the same as a neutral answer."
      actions={<>
        <RangeCaption range={list.meta?.range} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.items.length ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="h-6 rounded bg-slate-100 animate-pulse" />)}
        </div>
      ) : withReplies.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No replies in this range"
          hint={`Nothing came back between ${list.meta?.range?.from} and ${list.meta?.range?.to}.`}
        />
      ) : (
        <>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 mb-3">
            {INTENT_SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                {s.label}
                {totals && <span className="text-slate-500">({n(totals[s.key])})</span>}
              </li>
            ))}
          </ul>
          <div className="space-y-2.5">
            {withReplies.map((c) => (
              <div key={c.campaign_id}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <Link to={`/app/campaigns/${c.campaign_id}`} className="truncate text-slate-700 hover:text-accent-700">{c.name}</Link>
                  <span className="shrink-0 tabular-nums text-slate-500">{n(c.total)} replies</span>
                </div>
                <div className="mt-1 flex h-4 w-full overflow-hidden rounded bg-slate-100" aria-hidden>
                  {INTENT_SEGMENTS.map((s) => (
                    c[s.key] > 0 ? (
                      <div key={s.key} style={{ width: `${(c[s.key] / c.total) * 100}%`, background: s.color }} title={`${s.label}: ${c[s.key]}`} />
                    ) : null
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {INTENT_SEGMENTS.filter((s) => c[s.key] > 0).map((s) => (
                    `${s.label} ${c[s.key]} (${pctText((c[s.key] / c.total) * 100, c.total)})`
                  )).join(' · ')}
                </p>
              </div>
            ))}
          </div>
          <TableScroll label="Reply intent by campaign, as a table">
            <table className="w-full text-xs mt-4">
              <caption className="sr-only">
                Reply events by intent and campaign from {list.meta?.range?.from} to {list.meta?.range?.to}
              </caption>
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th scope="col" className="py-1.5 pr-3">Campaign</th>
                  {INTENT_SEGMENTS.map((s) => <th key={s.key} scope="col" className="py-1.5 pr-3 text-right">{s.label}</th>)}
                  <th scope="col" className="py-1.5 text-right">Total replies</th>
                </tr>
              </thead>
              <tbody>
                {withReplies.map((c) => (
                  <tr key={c.campaign_id} className="border-b border-slate-200 last:border-0">
                    <th scope="row" className="py-1 pr-3 font-normal text-slate-600">{c.name}</th>
                    {INTENT_SEGMENTS.map((s) => <td key={s.key} className="py-1 pr-3 text-right tabular-nums text-slate-700">{n(c[s.key])}</td>)}
                    <td className="py-1 text-right tabular-nums text-slate-700">{n(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}
