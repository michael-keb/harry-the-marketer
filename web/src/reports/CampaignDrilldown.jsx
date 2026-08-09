// Per-campaign drill-down — the six campaign-statistics endpoints behind one
// campaign picker.
//
// Routes: GET /api/campaigns/:id/analytics                 (all time)
//         GET /api/campaigns/:id/top-level-analytics-by-date
//         GET /api/campaigns/:id/analytics-by-date
//         GET /api/campaigns/:id/statistics                (per playbook step)
//         GET /api/campaigns/:id/leads-statistics
//         GET /api/campaigns/:id/mailbox-statistics
//
// These routes spell the window `start_date` / `end_date` / `time_zone`; the
// page's one date control feeds all of them, so there is never a second set of
// date inputs here.

import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../ui.jsx'
import { EmptyState, ErrorState, LiveRegion, LoadMore, Stat } from '../parity-ui.jsx'
import {
  DaySeriesChart, FieldMessage, GradedRate, Panel, RangeCaption, SkeletonRows, SortHeader,
  StaleMarker, TableScroll, SERIES_COLORS, fieldError, n, ofText, pctText,
  useApi, usePagedApi, useSort,
} from './shared.jsx'

export default function CampaignDrilldown({ campaigns, campaignId, onCampaign, range, timezone }) {
  const selectId = useId()
  const id = campaignId || ''
  const dateParams = { start_date: range.from, end_date: range.to, time_zone: timezone }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <label htmlFor={selectId} className="block text-xs text-slate-600 mb-1">Campaign to drill into</label>
        <div className="w-full sm:w-80">
          <select
            id={selectId}
            className="input cursor-pointer"
            value={id}
            onChange={(e) => onCampaign(e.target.value)}
          >
            <option value="">Pick a campaign…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          The date range at the top of the page applies to every panel below except the all-time header.
        </p>
      </div>

      {!id ? (
        <EmptyState
          icon="campaigns"
          title="Pick a campaign"
          hint={campaigns.length === 0
            ? 'There are no campaigns in this workspace yet.'
            : 'Choose a campaign above to see its headline numbers, its per-day chart, how each playbook step is performing, its leads and its mailboxes.'}
        />
      ) : (
        <>
          <Headline id={id} dateParams={dateParams} />
          <PerDay id={id} dateParams={dateParams} />
          <StepStats id={id} range={range} timezone={timezone} />
          <MailboxStats id={id} dateParams={dateParams} />
          <LeadStats id={id} />
        </>
      )}
    </div>
  )
}

// --- headline tiles: all time, plus a secondary ranged row -------------------

function Headline({ id, dateParams }) {
  const [copied, setCopied] = useState(false)
  const allTime = useApi(`/api/campaigns/${id}/analytics`)
  const ranged = useApi(`/api/campaigns/${id}/top-level-analytics-by-date`, dateParams)
  const d = allTime.data?.data
  const r = ranged.data?.data
  const rangeMeta = ranged.data?.range
  const dateErr = fieldError(ranged.error, ['start_date', 'end_date', 'time_zone'])

  const copy = async () => {
    if (!r || !rangeMeta) return
    const line = `${rangeMeta.from} – ${rangeMeta.to}: ${n(r.sent)} sent, ${n(r.replied)} replies, ${n(r.positive_replied)} interested, ${n(r.won)} won`
    try {
      await navigator.clipboard.writeText(line)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch { setCopied(false) }
  }

  return (
    <Panel
      id="campaign-headline"
      title={d ? `${d.name} — headline` : 'Campaign headline'}
      note="The large tiles are all time and never move with the date range. The smaller row beneath them is the range you picked, so the two can never be confused."
      actions={d ? <>
        <Badge value={d.status} />
        <Link to={`/app/campaigns/${id}`} className="text-xs text-slate-600 hover:text-accent-700">Open campaign</Link>
      </> : null}
    >
      {allTime.error && !d ? (
        <ErrorState error={allTime.error} onRetry={allTime.reload} />
      ) : !d ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => <div key={i} className="card h-[74px] animate-pulse" />)}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Emails sent (all time)" value={n(d.sent)} hint={`${n(d.leads_total)} leads attached`} />
            <Stat label="Replies (all time)" value={n(d.replied)} hint={`${n(d.replied_leads)} distinct leads replied`} />
            <Stat label="Interested (all time)" value={n(d.positive_replied)} hint="leads with a positive reply" />
            <Stat label="Won (all time)" value={n(d.won)} hint={d.revenue_amount > 0 ? `${n(d.revenue_amount)} recorded revenue` : 'no revenue recorded'} />
          </dl>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-100/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-slate-600">
                This range <RangeCaption range={rangeMeta} />
              </h4>
              <div className="flex items-center gap-2">
                <StaleMarker stale={ranged.stale} error={ranged.error} />
                {r && (
                  <button type="button" className="cursor-pointer text-xs text-slate-600 hover:text-accent-700" onClick={copy}>
                    {copied ? 'Copied' : 'Copy summary'}
                  </button>
                )}
                {/* The label swaps in place, so the result is announced here. */}
                <LiveRegion message={copied ? 'Summary copied to the clipboard' : ''} />
              </div>
            </div>
            <FieldMessage error={dateErr} />
            {ranged.error && !dateErr && !r ? (
              <p className="mt-1 text-xs text-red-700" role="alert">{ranged.error.message}</p>
            ) : !r ? (
              <div className="mt-2 h-4 w-64 rounded bg-slate-100 animate-pulse" aria-hidden />
            ) : r.sent === 0 && r.replied === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Nothing happened in this range.</p>
            ) : (
              <dl className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                {[
                  ['Sent', n(r.sent)],
                  ['Leads contacted', n(r.unique_lead_count)],
                  ['Replies', n(r.replied)],
                  ['Interested', n(r.positive_replied)],
                  ['Won', n(r.won)],
                  ['Reply rate', pctText(r.reply_rate, r.unique_lead_count)],
                  ['Bounce rate', pctText(r.bounce_rate, r.unique_lead_count)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline gap-1.5">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="tabular-nums text-ink-900">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <StageBreakdown byStage={d.by_stage} byState={d.by_state} total={d.leads_total} />
        </>
      )}
    </Panel>
  )
}

function StageBreakdown({ byStage, byState, total }) {
  const stages = Object.entries(byStage || {}).sort((a, b) => b[1] - a[1])
  const states = Object.entries(byState || {}).sort((a, b) => b[1] - a[1])
  if (!stages.length && !states.length) return null
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      {[['Lead stage (derived)', stages], ['Playbook state', states]].map(([title, rows]) => (
        <div key={title}>
          <h4 className="text-xs font-semibold text-slate-600 mb-1.5">{title}</h4>
          <ul className="flex flex-wrap gap-2">
            {rows.map(([key, count]) => (
              <li key={key} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-700">
                <Badge value={key} />
                <span className="tabular-nums">{n(count)}</span>
                <span className="text-slate-500">{pctText(total > 0 ? (count / total) * 100 : 0, total)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// --- per-day chart -----------------------------------------------------------

function PerDay({ id, dateParams }) {
  const { data, error, loading, reload, stale } = useApi(`/api/campaigns/${id}/analytics-by-date`, dateParams)
  const days = data?.data || []
  const hasAny = days.some((d) => d.sent || d.replied || d.opened)
  const dateErr = fieldError(error, ['start_date', 'end_date', 'time_zone'])

  return (
    <Panel
      id="campaign-per-day"
      title="This campaign, day by day"
      note="Every day in the range is a row, zero-filled when nothing happened, so the shape of the chart is the shape of the sending."
      actions={<><RangeCaption range={data?.range} /><StaleMarker stale={stale} error={error} /></>}
    >
      <FieldMessage error={dateErr} />
      {loading && !data ? (
        <div className="h-56 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      ) : error && !data && !dateErr ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : !hasAny ? (
        <p className="text-sm text-slate-500">Nothing was sent for this campaign between {data.range?.from} and {data.range?.to}.</p>
      ) : (
        <DaySeriesChart
          days={days}
          series={[
            { key: 'sent', label: 'Emails sent', color: SERIES_COLORS.sent, marker: 'circle' },
            { key: 'opened', label: 'Opens', color: SERIES_COLORS.opened, marker: 'square' },
            { key: 'clicked', label: 'Clicks', color: SERIES_COLORS.clicked, marker: 'triangle' },
            { key: 'replied', label: 'Replies', color: SERIES_COLORS.replied, marker: 'diamond' },
            { key: 'positive_replied', label: 'Positive replies', color: SERIES_COLORS.positive, marker: 'cross' },
          ]}
          unit="emails and replies"
          xLabel={`Date (${data.range?.timezone})`}
          yLabel="Count per day"
          caption={`Daily activity for this campaign, each event on the day it happened, in ${data.range?.timezone}. Days with nothing are drawn as zero.`}
        />
      )}
    </Panel>
  )
}

// --- per playbook step -------------------------------------------------------

const STATUSES = ['sent', 'queued', 'bounced', 'cancelled', 'test']

function StepStats({ id, range, timezone }) {
  const [seq, setSeq] = useState('')
  const [status, setStatus] = useState('')
  const seqId = useId()
  const statusId = useId()

  const list = usePagedApi(`/api/campaigns/${id}/statistics`, {
    sent_time_start_date: range.from,
    sent_time_end_date: range.to,
    time_zone: timezone,
    email_sequence_number: seq || undefined,
    email_status: status || undefined,
  }, { limit: 100 })

  const { sort, toggle, apply } = useSort('sequence_number', 'asc')
  const rows = apply(list.items)
  const filtered = Boolean(seq || status)
  const fieldErr = fieldError(list.error, ['sent_time_start_date', 'sent_time_end_date', 'time_zone', 'email_sequence_number'])

  return (
    <Panel
      id="campaign-steps"
      title="Playbook step performance"
      note="One row per Send: node, in the order the playbook reaches them. Rates here are per email sent by that step. A step deleted from the diagram still reports its history and is marked as no longer in the playbook rather than vanishing."
      actions={<>
        <div className="flex items-center gap-2">
          <label htmlFor={seqId} className="text-xs text-slate-600">Step</label>
          <div className="w-20">
            <input
              id={seqId}
              type="number"
              min="1"
              className="input py-1"
              value={seq}
              onChange={(e) => setSeq(e.target.value)}
              placeholder="all"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={statusId} className="text-xs text-slate-600">Status</label>
          <div className="w-32">
            <select id={statusId} className="input py-1 cursor-pointer" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <RangeCaption range={list.meta?.range} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      <FieldMessage error={fieldErr} />
      {list.error && !list.items.length && !fieldErr ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Playbook step performance">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">
                Per-step statistics from {list.meta?.range?.from} to {list.meta?.range?.to} ({list.meta?.range?.timezone})
              </caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Step" sortKey="sequence_number" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Node" sortKey="node_id" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} />
                  <SortHeader label="Leads" sortKey="unique_lead_count" sort={sort} onSort={toggle} title="Distinct leads this step emailed" />
                  <SortHeader label="Open rate" sortKey="open_rate" sort={sort} onSort={toggle} title="Opens per email sent by this step" />
                  <SortHeader label="Click rate" sortKey="click_rate" sort={sort} onSort={toggle} title="Clicks per email sent by this step" />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Replies attributed to this step, per email it sent" />
                  <SortHeader label="Bounce share" sortKey="bounce_share" sort={sort} onSort={toggle} title="Bounces per email sent by this step" />
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={4} cols={8} /> : (
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.node_id} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink-900">
                        {s.sequence_number || '—'}
                        {s.step_label && <span className="ml-2 text-slate-600">{s.step_label}</span>}
                        {!s.in_playbook && (
                          <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-700">no longer in the playbook</span>
                        )}
                      </th>
                      <td className="px-3 py-2.5 font-mono text-xs text-accent-700">{s.node_id}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(s.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(s.unique_lead_count)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(s.opened, s.sent, 'opens', 'emails sent')}>{pctText(s.open_rate, s.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(s.clicked, s.sent, 'clicks', 'emails sent')}>{pctText(s.click_rate, s.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(s.replied, s.sent, 'replies', 'emails sent')}>{pctText(s.reply_rate, s.sent)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(s.bounced, s.sent, 'bounces', 'emails sent')}>
                        <GradedRate metric="bounce_share" value={s.bounce_share} sample={s.sent} denom={s.sent} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              {filtered ? 'No step matches these filters. ' : 'No steps have sent in this range. '}
              {filtered && (
                <button type="button" className="cursor-pointer text-accent-700 hover:underline" onClick={() => { setSeq(''); setStatus('') }}>
                  Clear the filters
                </button>
              )}
            </p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- mailboxes for this campaign ---------------------------------------------

function MailboxStats({ id, dateParams }) {
  const list = usePagedApi(`/api/campaigns/${id}/mailbox-statistics`, dateParams, { limit: 20 })
  const { sort, toggle, apply } = useSort('sent', 'desc')
  const rows = apply(list.items)
  const applied = list.meta?.range?.applied

  return (
    <Panel
      id="campaign-mailboxes"
      title="Mailboxes sending for this campaign"
      note="Bounce and unsubscribe rates are graded against the same thresholds Monitoring uses, so the two screens never disagree. A mailbox that has since been disconnected still reports the history it sent."
      actions={<>
        <RangeCaption range={list.meta?.range} extra={applied === 'campaign' ? 'whole campaign — a half-filled range was ignored' : applied === 'default' ? 'campaign lifetime' : undefined} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Mailboxes sending for this campaign">
            <table className="w-full min-w-[700px] text-sm">
              <caption className="sr-only">Per-mailbox statistics for this campaign</caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Mailbox" sortKey="email" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="State" sortKey="status" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Leads that replied per lead contacted" />
                  <SortHeader label="Bounce rate" sortKey="bounce_rate" sort={sort} onSort={toggle} title="Bounced leads per lead contacted" />
                  <SortHeader label="Unsub rate" sortKey="unsubscribe_rate" sort={sort} onSort={toggle} title="Unsubscribes per lead contacted" />
                  <SortHeader label="Today left" sortKey="remaining_today" sort={sort} onSort={toggle} title="Sends remaining today against the daily limit" />
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={3} cols={7} /> : (
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.mailbox_id} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">
                        <Link to="/app/connections?area=email" className="text-ink-900 hover:text-accent-700">{m.email}</Link>
                        <span className="ml-2 text-xs text-slate-500">{m.provider}</span>
                      </th>
                      <td className="px-3 py-2.5"><Badge value={m.status} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(m.sent)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(m.replied_leads, m.unique_lead_count, 'leads replied', 'leads contacted')}>
                        <GradedRate metric="reply_rate" value={m.reply_rate} sample={m.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right" title={ofText(m.bounced_leads, m.unique_lead_count, 'bounced leads', 'leads contacted')}>
                        <GradedRate metric="bounce_rate" value={m.bounce_rate} sample={m.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <GradedRate metric="unsubscribe_rate" value={m.unsubscribe_rate} sample={m.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{n(m.remaining_today)}/{n(m.daily_limit)}</td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">No mailbox has sent for this campaign yet.</p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- leads in this campaign ---------------------------------------------------

function LeadStats({ id }) {
  const [since, setSince] = useState('')
  const sinceId = useId()
  const list = usePagedApi(`/api/campaigns/${id}/leads-statistics`, { event_time_gt: since || undefined }, { limit: 100 })
  const { sort, toggle, apply } = useSort('last_event_at', 'desc')
  const rows = apply(list.items)
  const fieldErr = fieldError(list.error, ['event_time_gt'])

  return (
    <Panel
      id="campaign-leads"
      title="Leads in this campaign"
      note="Every lead attached to the campaign with its own activity. Stage is derived on read, never stored, so it always matches the Leads page. This panel is not date-ranged — use “Active since” to narrow it."
      actions={<>
        <div className="flex items-center gap-2">
          <label htmlFor={sinceId} className="text-xs text-slate-600">Active since</label>
          <div className="w-40">
            <input
              id={sinceId}
              type="date"
              className="input py-1"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
        </div>
        <span className="text-xs text-slate-500">{n(list.total)} leads</span>
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      <FieldMessage error={fieldErr} />
      {list.error && !list.items.length && !fieldErr ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Leads in this campaign">
            <table className="w-full min-w-[820px] text-sm">
              <caption className="sr-only">Leads attached to this campaign with their activity</caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Lead" sortKey="email" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Company" sortKey="company" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Stage" sortKey="stage" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} />
                  <SortHeader label="Opens" sortKey="opened" sort={sort} onSort={toggle} />
                  <SortHeader label="Replies" sortKey="replied" sort={sort} onSort={toggle} />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Replies per email sent to this lead" />
                  <SortHeader label="Last activity" sortKey="last_event_at" sort={sort} onSort={toggle} align="left" />
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={5} cols={8} /> : (
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.lead_id} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">
                        <Link to="/app/leads" className="text-ink-900 hover:text-accent-700">
                          {[l.first_name, l.last_name].filter(Boolean).join(' ') || l.email}
                        </Link>
                        <div className="text-xs text-slate-500">{l.email}</div>
                      </th>
                      <td className="px-3 py-2.5 text-slate-600">{l.company || '—'}</td>
                      <td className="px-3 py-2.5">
                        <Badge value={l.stage} />
                        {l.outcome && <span className="ml-1.5 align-middle"><Badge value={l.outcome} /></span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(l.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(l.opened)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(l.replied)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{pctText(l.reply_rate, l.sent)}</td>
                      <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{l.last_event_at || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              {since ? 'No lead has been active since that date. ' : 'No leads attached yet. '}
              {since && (
                <button type="button" className="cursor-pointer text-accent-700 hover:underline" onClick={() => setSince('')}>Clear the filter</button>
              )}
            </p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}
