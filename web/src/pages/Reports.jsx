// Reports — the whole reporting surface, organised as one page with tabs so
// twenty-eight endpoints do not become twenty-eight screens.
//
// One date range, one campaign filter and (only for workspaces that have them)
// one client filter sit in the header and feed every panel; each tab owns its
// own requests and its own loading, empty and error states. Nothing here is a
// new navigation item — Reports already existed, and everything below fits it.
//
// The funnel, the Learning section and the 30-day series that were here before
// are still here: the funnel and Learning read the original GET /api/analytics
// aggregate (which is where playbook reply attribution is computed), and
// SeriesChart is still exported because the Dashboard draws with it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { EmptyState, PageHeader } from '../ui.jsx'
import { Tabs, LiveRegion } from '../parity-ui.jsx'
import { BROWSER_TZ, SERIES_COLORS, fieldError, isoDay, useApi } from '../reports/shared.jsx'
import { ReportsFilters, useCampaignList, useClientList } from '../reports/Filters.jsx'
import OverviewTab from '../reports/OverviewTab.jsx'
import CampaignsTab from '../reports/CampaignsTab.jsx'
import OverTimeTab from '../reports/OverTimeTab.jsx'
import MailboxesTab from '../reports/MailboxesTab.jsx'
import RepliesTab from '../reports/RepliesTab.jsx'
import ClientsTab from '../reports/ClientsTab.jsx'
import CampaignDrilldown from '../reports/CampaignDrilldown.jsx'

// The two-series bar chart reuses the shared palette rather than keeping its
// own copy — they had already drifted apart once.
const SENT_COLOR = SERIES_COLORS.sent
const REPLY_COLOR = SERIES_COLORS.replied

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'time', label: 'Over time' },
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'replies', label: 'Replies' },
  { id: 'clients', label: 'Clients' },
  { id: 'campaign', label: 'Campaign drill-down' },
]

const DEFAULT_FROM = () => isoDay(-29)
const DEFAULT_TO = () => isoDay(0)

export default function Reports() {
  // Every filter lives in the URL, so a filtered Reports view can be shared.
  const [search, setSearch] = useSearchParams()
  const tab = TABS.some((t) => t.id === search.get('tab')) ? search.get('tab') : 'overview'
  const from = search.get('from') || DEFAULT_FROM()
  const to = search.get('to') || DEFAULT_TO()
  const client = search.get('client') || ''
  const drillId = search.get('campaign') || ''
  const selectedCampaigns = useMemo(
    () => (search.get('campaigns') || '').split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0),
    [search],
  )

  const patch = useCallback((changes) => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === null || value === '') next.delete(key)
        else next.set(key, String(value))
      }
      return next
    }, { replace: true })
  }, [setSearch])

  const { campaigns, loading: campaignsLoading, error: campaignsError } = useCampaignList()
  const { clients } = useClientList()

  // Selecting a client narrows the campaign picker to that client's campaigns.
  // The campaign→client map only exists on the performance route, so it is only
  // fetched when a client is actually chosen.
  const clientMap = useApi(
    '/api/analytics/campaigns/performance',
    { from, to, timezone: BROWSER_TZ, limit: 200 },
    { enabled: Boolean(client) },
  )
  const clientCampaignIds = useMemo(() => {
    if (!client) return null
    return (clientMap.data?.items || [])
      .filter((c) => String(c.client_id ?? '') === String(client))
      .map((c) => c.campaign_id)
  }, [client, clientMap.data])

  const visibleCampaigns = useMemo(() => {
    if (!clientCampaignIds) return campaigns
    return campaigns.filter((c) => clientCampaignIds.includes(c.id))
  }, [campaigns, clientCampaignIds])

  // What every panel is actually asked for.
  const effectiveIds = selectedCampaigns.length
    ? selectedCampaigns
    : (clientCampaignIds && clientCampaignIds.length ? clientCampaignIds : undefined)

  const params = useMemo(() => ({
    from, to, timezone: BROWSER_TZ, campaign_ids: effectiveIds,
  }), [from, to, effectiveIds])

  // The legacy workspace aggregate: the funnel and the playbook-attributed
  // Learning table are computed there and nowhere else.
  const [legacyData, setLegacyData] = useState(null)
  const [legacyError, setLegacyError] = useState(null)
  const loadLegacy = useCallback(async () => {
    try { setLegacyData(await api.get('/api/analytics')); setLegacyError(null) } catch (err) { setLegacyError(err) }
  }, [])
  useEffect(() => {
    loadLegacy()
    const timer = setInterval(loadLegacy, 15000)
    return () => clearInterval(timer)
  }, [loadLegacy])
  const legacy = { data: legacyData, error: legacyError, reload: loadLegacy }

  // One canonical ranged call at page level: it is what the Overview tab shows
  // and it is also how an invalid range is caught, so the 422's message can be
  // put against the date control that caused it rather than in a toast.
  const overview = useApi('/api/analytics/overview', params)
  const dateError = fieldError(overview.error, ['from', 'to', 'timezone', 'start_date', 'end_date', 'time_zone'])

  const announcement = dateError
    ? dateError.message
    : `Showing ${from} to ${to}${effectiveIds ? ` for ${effectiveIds.length} campaign${effectiveIds.length === 1 ? '' : 's'}` : ' for all campaigns'}.`

  return (
    <div className="space-y-4">
      <PageHeader title="Reports" lead="How the whole operation is performing." />

      <ReportsFilters
        range={{ from, to }}
        onRange={(r) => patch({ from: r.from, to: r.to })}
        campaigns={visibleCampaigns}
        campaignsLoading={campaignsLoading}
        campaignsError={campaignsError}
        selectedCampaigns={selectedCampaigns}
        onCampaigns={(ids) => patch({ campaigns: ids.join(',') })}
        clients={clients}
        client={client}
        onClient={(value) => patch({ client: value, campaigns: '' })}
        dateError={dateError}
        busy={overview.loading}
      />

      {client && clientCampaignIds && clientCampaignIds.length === 0 && !clientMap.loading && (
        <p role="status" className="card border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          That client has no campaigns that sent in this range, so the panels below cover the whole workspace rather than
          silently showing zeros.
        </p>
      )}

      <LiveRegion message={announcement} />

      <Tabs tabs={TABS} active={tab} onChange={(id) => patch({ tab: id })} ariaLabel="Report sections" />

      {tab === 'overview' && <OverviewTab params={params} legacy={legacy} overview={overview} />}
      {tab === 'campaigns' && <CampaignsTab params={params} />}
      {tab === 'time' && <OverTimeTab params={params} />}
      {tab === 'mailboxes' && <MailboxesTab params={params} />}
      {tab === 'replies' && <RepliesTab params={params} />}
      {tab === 'clients' && (
        <ClientsTab params={params} clients={clients} clientId={client} timezone={BROWSER_TZ} />
      )}
      {tab === 'campaign' && (
        <CampaignDrilldown
          campaigns={visibleCampaigns}
          campaignId={drillId}
          onCampaign={(id) => patch({ campaign: id })}
          range={{ from, to }}
          timezone={BROWSER_TZ}
        />
      )}
    </div>
  )
}

// The Dashboard draws its 14-day strip with this, so it stays exported and
// unchanged: a dense day-by-day chart where a silent day is a zero, not a gap.
export function SeriesChart({ series, days = 30 }) {
  const [hover, setHover] = useState(null)
  const byDay = Object.fromEntries((series || []).map((d) => [d.day, d]))
  const filled = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10)
    filled.push({ day: d, sent: byDay[d]?.sent || 0, replies: byDay[d]?.replies || 0 })
  }
  const max = Math.max(1, ...filled.map((d) => Math.max(d.sent, d.replies)))
  const W = 720, H = 180, PAD = { l: 28, r: 4, t: 8, b: 22 }
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b
  const groupW = plotW / filled.length
  const barW = Math.max(2, Math.min(10, (groupW - 4) / 2))
  const y = (v) => PAD.t + plotH - (v / max) * plotH
  const labelEvery = Math.ceil(filled.length / 7)

  if (!filled.some((d) => d.sent || d.replies)) {
    return <EmptyState icon="reports" title="No sends in this window" hint="Sent emails and replies chart here day by day." />
  }

  return (
    <div>
      <div className="flex items-center gap-4 text-xs text-slate-600 mb-2" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: SENT_COLOR }} /> Sent</span>
        <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: REPLY_COLOR }} /> Replies</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Emails sent and replies per day, last ${days} days`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="#e1e8ed" strokeWidth="1" />
              <text x={PAD.l - 6} y={y(max * f) + 3.5} textAnchor="end" fontSize="9" fill="#5d7893">{Math.round(max * f)}</text>
            </g>
          ))}
          {filled.map((d, i) => {
            const cx = PAD.l + i * groupW + groupW / 2
            return (
              <g key={d.day} onMouseEnter={() => setHover({ ...d, i })} onMouseLeave={() => setHover(null)}>
                <rect x={PAD.l + i * groupW} y={PAD.t} width={groupW} height={plotH} fill="transparent" />
                {d.sent > 0 && <rect x={cx - barW - 1} y={y(d.sent)} width={barW} height={PAD.t + plotH - y(d.sent)} rx="2" fill={SENT_COLOR} />}
                {d.replies > 0 && <rect x={cx + 1} y={y(d.replies)} width={barW} height={PAD.t + plotH - y(d.replies)} rx="2" fill={REPLY_COLOR} />}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - 6} textAnchor="middle" fontSize="9" fill="#5d7893">{d.day.slice(5)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {hover && (
          <div className="absolute pointer-events-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs shadow-xl"
            style={{ left: `${((PAD.l + hover.i * groupW + groupW / 2) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}>
            <div className="text-slate-700 font-medium mb-0.5">{hover.day}</div>
            <div style={{ color: SENT_COLOR }}>Sent: {hover.sent}</div>
            <div style={{ color: REPLY_COLOR }}>Replies: {hover.replies}</div>
          </div>
        )}
      </div>
      {/* The chart's data as a table, for anyone who cannot see the chart.
          `sr-only` belongs on the wrapper, not on the table: it works by
          shrinking to 1px and hiding the overflow, and a table refuses to size
          below its min-content width. On the table itself this stayed 503px
          wide, sat outside the viewport, and gave Reports a sideways scrollbar.
          A block-level div shrinks as intended and clips the table inside it. */}
      <div className="sr-only">
        <table>
          <caption>Emails sent and replies per day</caption>
          <thead><tr><th>Day</th><th>Sent</th><th>Replies</th></tr></thead>
          <tbody>{filled.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.sent}</td><td>{d.replies}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  )
}
