import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Spinner, ErrorState, EmptyState, Icon, timeAgo } from '../ui.jsx'
import NeedsYou from '../dashboard/NeedsYou.jsx'
import { SeriesChart } from './Reports.jsx'

const EVENT_LABELS = {
  sent: 'Email sent', reply: 'Reply received', classified: 'Reply classified',
  branched: 'Playbook branched', finished: 'Lead finished', needs_attention: 'Needs attention',
  error: 'Error', campaign_launched: 'Campaign launched', campaign_paused: 'Campaign paused',
  campaign_created: 'Campaign created', lead_added: 'Lead added', leads_imported: 'Leads imported',
  mailbox_connected: 'Mailbox connected', reclassified: 'Reclassified', signup: 'Welcome',
  campaign_archived: 'Campaign archived', mailbox_removed: 'Mailbox removed',
  member_invited: 'Team member invited', member_removed: 'Team member removed',
  awaiting_approval: 'Waiting for your OK', approved: 'Email approved', declined: 'Email declined',
  consent_signed: 'Agreement signed', consent_declined: 'Agreement declined',
  draft_stale: 'Queued email dropped',
  researched: 'Lead researched', opened: 'Email opened', clicked: 'Link clicked',
  unsubscribed_link: 'Unsubscribed',
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setData(await api.get('/api/dashboard')); setError(null) } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!data) return <Spinner label="Loading dashboard…" />

  const { stats, sentByDay, activity, attention, ai, engine } = data
  // Every one of these is an absolute path under /app. They used to be written
  // as /leads, /inbox and so on, which react-router matched against the public
  // marketing routes and answered with the 404 page — a KPI that reads right
  // and goes nowhere.
  const tiles = [
    { label: 'Leads', value: stats.leads, to: '/app/leads' },
    { label: 'Active campaigns', value: stats.activeCampaigns, to: '/app/campaigns' },
    { label: 'Emails sent', value: stats.sent, to: '/app/reports' },
    { label: 'Replies', value: stats.replies, to: '/app/inbox?tab=replies' },
    { label: 'Interested', value: stats.interested, to: '/app/inbox?tab=replies&intent=interested' },
    { label: 'Won', value: stats.won, to: '/app/reports' },
  ]

  const lastTickMs = engine.lastTick ? Date.parse(engine.lastTick) : null
  const engineHealthy = lastTickMs && Date.now() - lastTickMs < engine.intervalMs * 3

  return (
    <div className="space-y-5">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-7 gap-y-3">
        <h1 className="text-3xl font-semibold text-ink-900">Dashboard</h1>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5" title={engine.lastTick ? `Last engine tick ${timeAgo(engine.lastTick)}` : 'Engine has not ticked yet'}>
            <span className={`inline-block size-2 rounded-full ${engineHealthy ? 'bg-accent-400' : 'bg-amber-400'}`} />
            Engine {engineHealthy ? `live — tick ${timeAgo(engine.lastTick)}` : engine.lastTick ? `stale — last tick ${timeAgo(engine.lastTick)}` : 'waiting for first tick'}
          </span>
          <span>
            Agent: {ai.configuredKey
              ? <span className="text-accent-700">{ai.provider === 'openai' ? 'OpenAI' : 'Claude'} ({ai.model})</span>
              : <span className="text-amber-700">template mode — set OPENAI_API_KEY or ANTHROPIC_API_KEY</span>}
          </span>
        </div>
      </div>

      {/* The reason to open this page, so it goes above the numbers. Everything
          that can want a person — approvals, parked leads, tasks, reminders —
          is answered here once instead of on three pages. `attention` rides in
          on the payload this component already polls, so the parked leads cost
          no extra request; the other three sources fetch themselves. */}
      <NeedsYou decisions={attention} onDecisionsChanged={load} />

      {/* Unread replies are a different question — "what is new to read", not
          "what is waiting on my decision" — so this stays a chip beside the
          queue rather than a fifth filter inside it. The approvals chip that
          used to sit here is gone: it was the same answer twice. */}
      {stats.unread > 0 && (
        <div className="flex flex-wrap gap-2">
          <Link to="/app/inbox?tab=replies" className="inline-flex items-center gap-2 rounded-lg border border-accent-600/40 bg-accent-500/10 px-4 py-2.5 text-sm text-accent-700 hover:bg-accent-500/20">
            <Icon name="inbox" />
            {stats.unread} unread repl{stats.unread === 1 ? 'y' : 'ies'}
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="card px-5 py-4 transition-colors hover:border-accent-500">
            <div className="text-xs font-medium text-slate-500">{t.label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-900">{t.value}</div>
          </Link>
        ))}
      </div>

      {/* The Action Center that used to sit here is now the "Decisions" filter
          in "Needs you" above — same rows, same Resume, alongside the other
          three things that can be waiting on you. Keeping both would have left
          the duplication it was built to remove, on the same page. */}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-1">Last 14 days</h2>
          <SeriesChart series={sentByDay} days={14} />
        </section>

        <section className="card">
          <h2 className="text-sm font-semibold text-slate-700 px-4 pt-4 pb-2">Activity</h2>
          {activity.length === 0 ? (
            <div className="p-4"><EmptyState icon="pulse" title="Nothing yet" hint="Launch a campaign and the agent's every move shows up here." /></div>
          ) : (
            <ul className="divide-y divide-slate-200 max-h-105 overflow-y-auto">
              {activity.map((e) => (
                <li key={e.id} className="px-4 py-2.5 text-sm flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-slate-700">{EVENT_LABELS[e.type] || e.type}</span>
                    {e.lead_email && <span className="text-slate-500"> · {e.lead_email}</span>}
                    {e.campaign_name && <span className="text-slate-500"> · {e.campaign_name}</span>}
                    {e.detail && <div className="text-xs text-slate-500 truncate" title={e.detail}>{e.detail}</div>}
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
