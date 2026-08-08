// Mailboxes — the deliverability half of Reports: how many accounts are usable
// right now, how each domain and each mailbox is performing over the range, and
// how the providers compare.
//
// Routes: GET /api/analytics/mailboxes/summary | domains | health | providers.
//
// Every rate is graded against the same cold-outreach thresholds Monitoring
// uses (shared/BENCHMARKS), so the two screens can never disagree about what
// counts as a bounce problem. Sandbox mailboxes are labelled and never graded.

import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../ui.jsx'
import { EmptyState, ErrorState, LoadMore, Stat } from '../parity-ui.jsx'
import {
  GradedRate, Panel, RangeCaption, SkeletonRows, SortHeader, StaleMarker, TableScroll,
  n, ofText, pctText, useApi, usePagedApi, useSort,
} from './shared.jsx'

export default function MailboxesTab({ params }) {
  return (
    <div className="space-y-4">
      <MailboxSummary />
      <DomainHealth params={params} />
      <MailboxHealth params={params} />
      <ProviderPerformance params={params} />
    </div>
  )
}

// --- the four derived counts -------------------------------------------------

function MailboxSummary() {
  const { data, error, loading, reload } = useApi('/api/analytics/mailboxes/summary')

  return (
    <Panel
      id="mailbox-summary"
      title="Mailbox states"
      note="Derived on every request, never stored, so these counts cannot drift from what the sending engine actually sees."
      actions={<Link to="/app/mailboxes" className="text-xs text-slate-600 hover:text-accent-700">Manage mailboxes</Link>}
    >
      {loading && !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card h-16 animate-pulse" />)}
        </div>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : data.total === 0 ? (
        <EmptyState
          icon="mailboxes"
          title="No mailboxes connected"
          hint="Connect a Gmail account or add a sandbox mailbox and its health shows up here."
          action={<Link to="/app/mailboxes" className="btn-primary">Connect a mailbox</Link>}
        />
      ) : (
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Mailboxes" value={n(data.total)} hint="in this workspace" />
          <Stat label="Connected" value={n(data.total_connected)} hint="usable for sending right now" />
          <Stat label="In use" value={n(data.in_use)} hint="attached to a running campaign" />
          <Stat
            label="Disconnected"
            value={n(data.disconnected)}
            hint={data.disconnected > 0 ? 'reconnect these before the queue stalls' : 'nothing to reconnect'}
            tone={data.disconnected > 0 ? 'bad' : 'good'}
          />
          <Stat label="Suspended" value={n(data.suspended)} hint="paused by you or by the provider" tone={data.suspended > 0 ? 'bad' : undefined} />
          <Stat
            label="Without warm-up"
            value={n(data.enabled_without_warmup)}
            hint={`real mailboxes sending without warm-up${data.sandbox > 0 ? ` — ${n(data.sandbox)} sandbox mailbox(es) excluded` : ''}`}
            tone={data.enabled_without_warmup > 0 ? 'bad' : undefined}
          />
        </dl>
      )}
    </Panel>
  )
}

// --- domains -----------------------------------------------------------------

function DomainHealth({ params }) {
  const list = usePagedApi('/api/analytics/mailboxes/domains', params, { limit: 50 })
  const { sort, toggle, apply } = useSort('sent', 'desc')
  const rows = apply(list.items)

  return (
    <Panel
      id="domain-health"
      title="Domain health"
      note="Grouped by the sending domain, because a reputation problem belongs to the domain rather than to one address. Domains that sent nothing in the range are left out rather than padded with zeros."
      actions={<><RangeCaption range={list.meta?.range} /><StaleMarker stale={list.stale} error={list.error} /></>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Domain health">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">
                Sending health per domain from {list.meta?.range?.from} to {list.meta?.range?.to} ({list.meta?.range?.timezone})
              </caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Domain" sortKey="domain" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Mailboxes" sortKey="mailboxes" sort={sort} onSort={toggle} />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} title="Emails sent in the range" />
                  <SortHeader label="Open rate" sortKey="open_rate" sort={sort} onSort={toggle} title="Opens per email sent" />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Leads that replied per lead contacted" />
                  <SortHeader label="Bounced" sortKey="bounced" sort={sort} onSort={toggle} title="Bounced emails in the range" />
                  <SortHeader label="Bounce share" sortKey="bounce_share" sort={sort} onSort={toggle} title="Bounced emails per email sent — the figure a mail provider grades you on" />
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={3} cols={7} /> : (
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.domain} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink-900">{d.domain}</th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(d.mailboxes)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(d.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(d.opened, d.sent, 'opens', 'emails sent')}>{pctText(d.open_rate, d.sent)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(d.replied_leads, d.unique_lead_count, 'leads replied', 'leads contacted')}>
                        <GradedRate metric="reply_rate" value={d.reply_rate} sample={d.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(d.bounced)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(d.bounced, d.sent, 'bounces', 'emails sent')}>
                        <GradedRate metric="bounce_share" value={d.bounce_share} sample={d.sent} denom={d.sent} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              No domain sent anything between {list.meta?.range?.from} and {list.meta?.range?.to}.
            </p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- per mailbox -------------------------------------------------------------

function MailboxHealth({ params }) {
  const [bouncingOnly, setBouncingOnly] = useState(false)
  const list = usePagedApi(
    '/api/analytics/mailboxes/health',
    { ...params, is_bounced: bouncingOnly ? 'true' : undefined },
    { limit: 50 },
  )
  const { sort, toggle, apply } = useSort('sent', 'desc')
  const rows = apply(list.items)

  return (
    <Panel
      id="mailbox-health"
      title="Mailbox health"
      note="Every connected mailbox appears, including ones that sent nothing in the range. Sandbox mailboxes are labelled and are never graded for deliverability — they do not touch a real inbox."
      actions={<>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            className="cursor-pointer accent-accent-500"
            checked={bouncingOnly}
            onChange={(e) => setBouncingOnly(e.target.checked)}
          />
          Bouncing only
        </label>
        <RangeCaption range={list.meta?.range} />
        <StaleMarker stale={list.stale} error={list.error} />
      </>}
    >
      {list.error && !list.items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <TableScroll label="Mailbox health">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">
                Sending health per mailbox from {list.meta?.range?.from} to {list.meta?.range?.to} ({list.meta?.range?.timezone})
              </caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <SortHeader label="Mailbox" sortKey="email" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="State" sortKey="status" sort={sort} onSort={toggle} align="left" />
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onSort={toggle} />
                  <SortHeader label="Today left" sortKey="remaining_today" sort={sort} onSort={toggle} title="Sends remaining today against the daily limit" />
                  <SortHeader label="Open rate" sortKey="open_rate" sort={sort} onSort={toggle} title="Opens per email sent" />
                  <SortHeader label="Reply rate" sortKey="reply_rate" sort={sort} onSort={toggle} title="Leads that replied per lead contacted" />
                  <SortHeader label="Bounced" sortKey="bounced" sort={sort} onSort={toggle} />
                  <SortHeader label="Bounce share" sortKey="bounce_share" sort={sort} onSort={toggle} title="Bounced emails per email sent" />
                </tr>
              </thead>
              {list.loading && !rows.length ? <SkeletonRows rows={4} cols={8} /> : (
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.mailbox_id} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">
                        <Link to="/app/mailboxes" className="text-ink-900 hover:text-accent-700">{m.email}</Link>
                        {m.is_sandbox && <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-slate-200 text-slate-600">sandbox</span>}
                        {!m.warmup_enabled && !m.is_sandbox && (
                          <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-700">no warm-up</span>
                        )}
                      </th>
                      <td className="px-3 py-2.5">
                        <Badge value={m.status} />
                        {m.is_suspended && <span className="ml-2 text-xs text-red-700">suspended</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(m.sent)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{n(m.remaining_today)}/{n(m.daily_limit)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(m.opened, m.sent, 'opens', 'emails sent')}>{pctText(m.open_rate, m.sent)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(m.replied_leads, m.unique_lead_count, 'leads replied', 'leads contacted')}>
                        <GradedRate metric="reply_rate" value={m.reply_rate} sample={m.unique_lead_count} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{n(m.bounced)}</td>
                      <td className="px-3 py-2.5 text-right" title={ofText(m.bounced, m.sent, 'bounces', 'emails sent')}>
                        {m.is_sandbox
                          ? <span className="tabular-nums text-slate-600">{pctText(m.bounce_share, m.sent)}</span>
                          : <GradedRate metric="bounce_share" value={m.bounce_share} sample={m.sent} denom={m.sent} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>
          {!list.loading && rows.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              {bouncingOnly
                ? 'No mailbox bounced in this range. '
                : 'No mailboxes connected. '}
              {bouncingOnly
                ? <button type="button" className="cursor-pointer text-accent-700 hover:underline" onClick={() => setBouncingOnly(false)}>Show all mailboxes</button>
                : <Link to="/app/mailboxes" className="text-accent-700 hover:underline">Connect one</Link>}
            </p>
          )}
          <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
        </>
      )}
    </Panel>
  )
}

// --- providers ---------------------------------------------------------------

function ProviderPerformance({ params }) {
  const [expanded, setExpanded] = useState(null)
  const { data, error, loading, reload, stale } = useApi('/api/analytics/mailboxes/providers', params)
  const overall = data?.overall || []
  const real = overall.filter((p) => !p.is_sandbox)

  if (error && !data) {
    return (
      <Panel id="providers" title="Provider comparison">
        <ErrorState error={error} onRetry={reload} />
      </Panel>
    )
  }
  if (loading && !data) {
    return (
      <Panel id="providers" title="Provider comparison">
        <div className="h-24 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      </Panel>
    )
  }
  if (!data || overall.length === 0) return null

  return (
    <Panel
      id="providers"
      title="Provider comparison"
      note={real.length < 2
        ? 'Only one real provider has sent in this range, so there is nothing to compare yet — the numbers are shown for reference.'
        : 'Shares here are per email sent, which is a different denominator from the per-lead rates elsewhere on this page. Sandbox rows are listed for completeness and are excluded from any verdict.'}
      actions={<><RangeCaption range={data.range} /><StaleMarker stale={stale} error={error} /></>}
    >
      <TableScroll label="Provider comparison">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">
            Sending performance by provider from {data.range?.from} to {data.range?.to}
          </caption>
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th scope="col" className="px-3 py-2.5 font-medium">Provider</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Sent</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Opens per email</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Replies per email</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Bounces per email</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Campaigns</th>
            </tr>
          </thead>
          <tbody>
            {overall.map((p) => {
              const byCampaign = (data.by_campaign || []).filter((r) => r.provider === p.provider)
              const open = expanded === p.provider
              return (
                <Fragment key={p.provider}>
                  <tr className="border-b border-slate-200">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink-900">
                      {p.provider}
                      {p.is_sandbox && <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-slate-200 text-slate-600">sandbox — not a real inbox</span>}
                    </th>
                    <td className="px-3 py-2.5 text-right tabular-nums">{n(p.sent)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(p.opened, p.sent, 'opens', 'emails sent')}>{pctText(p.open_rate, p.sent)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(p.replied, p.sent, 'replies', 'emails sent')}>{pctText(p.sent > 0 ? (p.replied / p.sent) * 100 : 0, p.sent)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" title={ofText(p.bounced, p.sent, 'bounces', 'emails sent')}>{pctText(p.bounce_share, p.sent)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {byCampaign.length === 0 ? <span className="text-slate-400">0</span> : (
                        <button
                          type="button"
                          className="cursor-pointer text-accent-700 hover:underline"
                          aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} the ${byCampaign.length} campaigns sending through ${p.provider}`}
                          onClick={() => setExpanded(open ? null : p.provider)}
                        >
                          {byCampaign.length} <span aria-hidden>{open ? '▲' : '▼'}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && byCampaign.map((r) => (
                    <tr key={`${p.provider}-${r.campaign_id}`} className="border-b border-slate-200 bg-slate-100/30 text-xs">
                      <th scope="row" className="px-3 py-1.5 pl-8 text-left font-normal text-slate-600">
                        <Link to={`/app/campaigns/${r.campaign_id}`} className="hover:text-accent-700">{r.campaign_name || `Campaign ${r.campaign_id}`}</Link>
                      </th>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{n(r.sent)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{pctText(r.open_rate, r.sent)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{pctText(r.sent > 0 ? (r.replied / r.sent) * 100 : 0, r.sent)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{pctText(r.bounce_share, r.sent)}</td>
                      <td />
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  )
}
