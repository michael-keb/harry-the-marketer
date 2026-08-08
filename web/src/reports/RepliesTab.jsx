// Replies — what kind of answers came back, and how long they took.
//
// Routes: GET /api/analytics/replies/by-category,
//         GET /api/analytics/reply-time-distribution,
//         GET /api/prospects/reply-analytics.
//
// The last of those is the odd one out and is kept visually separate on
// purpose: it is the prospect provider's own figure, not Harry's, and the two
// must never be read as the same measurement (see ProviderReplies below).

import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, LoadMore } from '../parity-ui.jsx'
import {
  HBars, Panel, RangeCaption, StaleMarker, TableScroll,
  SERIES_COLORS, hoursText, n, pctText, useApi, usePagedApi,
} from './shared.jsx'

const NEEDS_ATTENTION = 'needs_attention'

// The classifier's own buckets, mapped to the sentiment the server groups by.
const CATEGORY_COLOR = (category) => {
  const key = String(category).toLowerCase()
  if (key.startsWith(NEEDS_ATTENTION)) return SERIES_COLORS.uncategorised
  if (key === 'interested') return SERIES_COLORS.positive
  if (key === 'not interested' || key.startsWith('unsubscribe')) return SERIES_COLORS.negative
  return SERIES_COLORS.opened
}

const prettyCategory = (category) => String(category).replace(/_/g, ' ')

export default function RepliesTab({ params }) {
  return (
    <div className="space-y-4">
      <ByCategory params={params} />
      <ReplyTime params={params} />
      <ProviderReplies />
    </div>
  )
}

// --- the prospect provider's own reply figure --------------------------------

// Deliberately the smallest thing on the page, and deliberately not next to
// Harry's reply rate. This number comes from the prospect data provider, its
// documentation does not say which replies it counts, and it is computed over
// the provider's own month boundaries — so it answers a different question from
// every other figure in Reports. Averaging the two, or stacking them in one
// grid, would invite exactly the comparison that is not valid.
//
// It takes no parameters: the endpoint has none, so the card offers no date
// picker, no campaign filter and no comparison selector, and it ignores the
// page's range rather than pretending to honour it.

// The provider reports a direction as a bare word. Anything Harry does not
// recognise is shown verbatim rather than guessed into "up" — a wrong direction
// is worse than an unfamiliar one.
const TREND_WORD = {
  up: 'up on last month',
  increase: 'up on last month',
  increased: 'up on last month',
  positive: 'up on last month',
  down: 'down on last month',
  decrease: 'down on last month',
  decreased: 'down on last month',
  negative: 'down on last month',
  flat: 'unchanged from last month',
  same: 'unchanged from last month',
  neutral: 'unchanged from last month',
  stable: 'unchanged from last month',
}

function trendText(trend) {
  const raw = String(trend ?? '').trim()
  if (!raw) return null
  return TREND_WORD[raw.toLowerCase()] || raw
}

function ProviderReplies() {
  const { data, error, loading } = useApi('/api/prospects/reply-analytics')

  // No key, no card. An empty panel explaining an absent integration is chrome
  // for people who have not bought the integration.
  if (!loading && (error || data?.configured === false)) return null
  if (loading && !data) {
    return (
      <section className="card p-4" aria-hidden>
        <div className="h-3 w-56 rounded bg-slate-100 animate-pulse" />
        <div className="mt-3 h-8 w-40 rounded bg-slate-100 animate-pulse" />
      </section>
    )
  }
  if (!data) return null

  const change = data.percentageChange
  const trend = trendText(data.trend)
  const unavailable = data.available === false

  return (
    <Panel
      id="provider-replies"
      title="Prospect data provider — reply figures"
      note="Reported by the prospect data provider, over its own month boundaries. Its documentation does not say which replies it counts, so Harry shows the figure as given and does not combine it with the reply rate above — that one is measured from real threads in your mailbox."
    >
      {unavailable ? (
        <p className="text-sm text-slate-600">
          {data.message || 'Prospect reply figures are unavailable right now.'} Nothing else on this page is affected.
        </p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-600">This month</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">
                {data.currentMonth === null ? '—' : n(data.currentMonth)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">Last month</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">
                {data.previousMonth === null ? '—' : n(data.previousMonth)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">Change</dt>
              {/* Preformatted upstream, sign and percent symbol included, so it
                  is printed verbatim rather than reformatted into a number
                  Harry would then have to justify. */}
              <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink-950">
                {change === null || change === undefined || change === '' ? '—' : change}
                {trend && <span className="ml-2 align-middle text-xs font-normal text-slate-600">{trend}</span>}
              </dd>
            </div>
          </dl>
          {data.fetchedAt && (
            <p className="mt-3 text-[11px] text-slate-500">
              Refreshed at most hourly. Last read {new Date(data.fetchedAt).toLocaleString()}
              {data.cached ? ' (from cache)' : ''}.
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

// --- reply intent mix --------------------------------------------------------

function ByCategory({ params }) {
  const list = usePagedApi('/api/analytics/replies/by-category', params, { limit: 100 })
  const total = list.meta?.total_replies ?? 0

  // "Needs attention" is pinned to the top whatever its size: a single reply
  // nobody could classify still needs a human, and burying it at 1% hides it.
  const rows = [...list.items].sort((a, b) => {
    const an = String(a.category).startsWith(NEEDS_ATTENTION) ? 1 : 0
    const bn = String(b.category).startsWith(NEEDS_ATTENTION) ? 1 : 0
    if (an !== bn) return bn - an
    return b.total_response - a.total_response
  })

  return (
    <Panel
      id="replies-by-category"
      title="Replies by intent"
      note="Counts are reply emails, not distinct leads, on the day the reply arrived. “Needs attention” is a reply the classifier could not place — it is pinned to the top however small it is."
      actions={<>
        <RangeCaption range={list.meta?.range} extra={`${n(total)} replies`} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.items.length ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-4 rounded bg-slate-100 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No replies in this range"
          hint={`Nothing came back between ${list.meta?.range?.from} and ${list.meta?.range?.to}.`}
        />
      ) : (
        <>
          <HBars
            rows={rows.map((r) => ({
              key: r.category,
              label: prettyCategory(r.category),
              value: r.total_response,
              color: CATEGORY_COLOR(r.category),
              hint: `(${pctText(r.share, total)})`,
            }))}
            caption={`${n(total)} reply emails in this range, grouped by the intent the classifier assigned.`}
            labelWidth="w-36"
          />
          <TableScroll label="Replies by intent, as a table">
            <table className="w-full text-xs mt-4">
              <caption className="sr-only">
                Reply events by intent from {list.meta?.range?.from} to {list.meta?.range?.to}
              </caption>
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th scope="col" className="py-1.5 pr-3">Intent</th>
                  <th scope="col" className="py-1.5 pr-3 text-right">Replies</th>
                  <th scope="col" className="py-1.5 pr-3 text-right">Share of replies</th>
                  <th scope="col" className="py-1.5">Where to act</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.category} className="border-b border-slate-200 last:border-0">
                    <th scope="row" className="py-1.5 pr-3 font-normal text-slate-700">{prettyCategory(r.category)}</th>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{n(r.total_response)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{pctText(r.share, total)}</td>
                    <td className="py-1.5">
                      {String(r.category).startsWith(NEEDS_ATTENTION) ? (
                        <Link to="/app" className="text-accent-700 hover:underline">Action Center</Link>
                      ) : (
                        <Link to={`/app/inbox?intent=${encodeURIComponent(r.category)}`} className="text-accent-700 hover:underline">Inbox</Link>
                      )}
                    </td>
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

// --- how long a reply takes --------------------------------------------------

function ReplyTime({ params }) {
  const { data, error, loading, reload, stale } = useApi('/api/analytics/reply-time-distribution', params)
  const buckets = data?.buckets || []
  const total = data?.total ?? 0

  // The median bucket, walked in time order — never sorted alphabetically.
  let median = null
  if (total > 0) {
    let seen = 0
    for (const b of buckets) {
      seen += b.count
      if (seen >= total / 2) { median = b; break }
    }
  }

  return (
    <Panel
      id="reply-time"
      title="How long a first reply takes"
      note="The gap between an email going out and that lead's first answer. Only a lead's first reply counts — the second one is a conversation, not a response time. Use it to sanity-check the “no reply after X days” waits in your playbooks."
      actions={<><RangeCaption range={data?.range} /><StaleMarker stale={stale} error={error} /></>}
    >
      {loading && !data ? (
        <div className="h-32 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : total === 0 ? (
        <EmptyState
          icon="inbox"
          title="No first replies in this range"
          hint={`Nothing that could be timed came back between ${data.range?.from} and ${data.range?.to}.`}
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-700">
            Half of first replies arrive within <span className="font-medium text-accent-700">{median?.bucket}</span> of the send.
            The average is {hoursText(data.average_hours)} across {n(total)} timed repl{total === 1 ? 'y' : 'ies'}.
          </p>
          <HBars
            rows={buckets.map((b) => ({
              key: b.bucket,
              label: b.bucket,
              value: b.count,
              color: SERIES_COLORS.replied,
              hint: `(${pctText(total > 0 ? (b.count / total) * 100 : 0, total)})`,
            }))}
            caption="Buckets are in time order, from fastest to slowest. Empty buckets are shown rather than skipped."
            labelWidth="w-20"
          />
          {data.untraceable_replies > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {n(data.untraceable_replies)} repl{data.untraceable_replies === 1 ? 'y' : 'ies'} could not be traced back to a send
              and {data.untraceable_replies === 1 ? 'is' : 'are'} excluded from the timing rather than counted as instant.
            </p>
          )}
          <TableScroll label="Reply time distribution, as a table">
            <table className="w-full text-xs mt-4">
              <caption className="sr-only">
                Time from send to first reply, from {data.range?.from} to {data.range?.to}
              </caption>
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th scope="col" className="py-1.5 pr-3">Bucket</th>
                  <th scope="col" className="py-1.5 pr-3 text-right">From (hours)</th>
                  <th scope="col" className="py-1.5 pr-3 text-right">To (hours)</th>
                  <th scope="col" className="py-1.5 pr-3 text-right">First replies</th>
                  <th scope="col" className="py-1.5 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.bucket} className="border-b border-slate-200 last:border-0">
                    <th scope="row" className="py-1.5 pr-3 font-normal text-slate-700">{b.bucket}</th>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{b.from_hours}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{b.to_hours === null ? 'and over' : b.to_hours}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{n(b.count)}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">{pctText(total > 0 ? (b.count / total) * 100 : 0, total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
    </Panel>
  )
}
