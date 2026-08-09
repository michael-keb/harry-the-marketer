// Overview — the workspace headline numbers for the chosen range, the new
// versus follow-up split, the pipeline funnel and the Learning section.
//
// Routes: GET /api/analytics/overview, GET /api/analytics/leads/contact-mix.
// The funnel and Learning panels keep reading the original GET /api/analytics
// aggregate, which is what the playbook attribution is computed from.

import { Link } from 'react-router-dom'
import { Stat, EmptyState, ErrorState, Spinner } from '../parity-ui.jsx'
import {
  Panel, RangeCaption, SplitBar, StaleMarker, TableScroll,
  SERIES_COLORS, gradeRate, n, pctText, useApi,
} from './shared.jsx'

const TONE = { good: 'good', bad: 'bad' }

// `overview` is fetched by the page rather than here: it is the call whose 422
// tells the date control that the range is inverted, so the page owns it.
export default function OverviewTab({ params, legacy, overview }) {
  const mix = useApi('/api/analytics/leads/contact-mix', params)

  const s = overview.data?.overall_stats
  const range = overview.data?.range

  return (
    <div className="space-y-4">
      <Panel
        id="headline"
        title="Headline numbers"
        note="One workspace-level aggregate. Sends, opens, clicks and bounces sit on send time; replies on reply time; won, lost and unsubscribed on the moment the outcome was reached. Unique lead counts are not additive — two days cannot be added to make a week."
        actions={<><RangeCaption range={range} /><StaleMarker stale={overview.stale} error={overview.error} /></>}
      >
        {overview.loading && !s ? (
          <SkeletonTiles />
        ) : overview.error && !s ? (
          <ErrorState error={overview.error} onRetry={overview.reload} />
        ) : !s ? null : s.sent === 0 && s.replied === 0 ? (
          <EmptyState
            icon="reports"
            title="No activity in this range"
            hint={`Nothing was sent or received between ${range?.from} and ${range?.to}. Widen the range or launch a campaign.`}
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <Stat label="Emails sent" value={n(s.sent)} hint={`${n(s.unique_lead_count)} leads contacted`} />
              <Stat
                label="Open rate"
                value={pctText(s.open_rate, s.sent)}
                hint={`${n(s.opened)} opens of ${n(s.sent)} emails sent`}
                tone={TONE[gradeRate('open_rate', s.open_rate, s.unique_lead_count)]}
              />
              <Stat
                label="Click rate"
                value={pctText(s.click_rate, s.sent)}
                hint={`${n(s.clicked)} clicks of ${n(s.sent)} emails sent`}
              />
              <Stat
                label="Reply rate"
                value={pctText(s.reply_rate, s.unique_lead_count)}
                hint={`${n(s.replied_leads)} leads replied of ${n(s.unique_lead_count)} contacted`}
                tone={TONE[gradeRate('reply_rate', s.reply_rate, s.unique_lead_count)]}
              />
              <Stat
                label="Positive reply rate"
                value={pctText(s.positive_reply_rate, s.unique_lead_count)}
                hint={`${n(s.positive_replied)} leads answered positively`}
                tone={TONE[gradeRate('positive_reply_rate', s.positive_reply_rate, s.unique_lead_count)]}
              />
              <Stat label="Replies received" value={n(s.replied)} hint="reply emails, not distinct leads" />
              <Stat
                label="Bounce rate"
                value={pctText(s.bounce_rate, s.unique_lead_count)}
                hint={`${n(s.bounced_leads)} bounced leads per lead contacted — ${pctText(s.bounce_share, s.sent)} of emails sent`}
                tone={TONE[gradeRate('bounce_rate', s.bounce_rate, s.unique_lead_count)]}
              />
              <Stat
                label="Unsubscribe rate"
                value={pctText(s.unsubscribe_rate, s.unique_lead_count)}
                hint={`${n(s.unsubscribed)} unsubscribed per lead contacted`}
                tone={TONE[gradeRate('unsubscribe_rate', s.unsubscribe_rate, s.unique_lead_count)]}
              />
              <Stat
                label="Win rate"
                value={pctText(s.win_rate, s.unique_lead_count)}
                hint={`${n(s.won)} won, ${n(s.lost)} lost`}
                tone={TONE[gradeRate('win_rate', s.win_rate, s.unique_lead_count)]}
              />
              <Stat
                label="Leads per reply"
                value={s.replied_leads > 0 ? n(s.leads_per_reply) : '—'}
                hint={s.replied_leads > 0
                  ? `leads to contact for one reply${s.unique_lead_count < 100 ? ' — small sample, treat as a hint' : ''}`
                  : 'no replies in this range yet'}
              />
            </dl>
            {!s.opens_tracked && s.replied > 0 && (
              <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-amber-800">
                No opens were recorded in this range, so the open rate reads 0.0% rather than being unknown.
                Open tracking needs Gmail sends with the tracking pixel enabled; the reply rate below is measured
                per lead contacted and is unaffected.
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel
        id="contact-mix"
        title="New leads versus follow-ups"
        note="A lead counts as new when its first email in that campaign falls inside this range, even if it was chased again later in the same range."
        actions={<><RangeCaption range={mix.data?.range} /><StaleMarker stale={mix.stale} error={mix.error} /></>}
      >
        {mix.loading && !mix.data ? (
          <div className="h-5 rounded-md bg-slate-100 animate-pulse" aria-hidden />
        ) : mix.error && !mix.data ? (
          <p className="text-sm text-slate-500">The contact mix could not be loaded. <button type="button" className="cursor-pointer text-accent-700 hover:underline" onClick={mix.reload}>Try again</button></p>
        ) : !mix.data ? null : mix.data.total === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing was sent between {mix.data.range?.from} and {mix.data.range?.to}.
          </p>
        ) : (
          <SplitBar
            total={mix.data.total}
            segments={[
              { key: 'new', label: 'New leads', value: mix.data.new, color: SERIES_COLORS.sent },
              { key: 'follow_up', label: 'Follow-ups', value: mix.data.follow_up, color: SERIES_COLORS.replied },
            ]}
            caption={`${n(mix.data.total)} lead-campaign pairs were emailed in this range. Counts are leads, not emails.`}
          />
        )}
      </Panel>

      <Funnel legacy={legacy} />
      <Learning legacy={legacy} />
    </div>
  )
}

function SkeletonTiles() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" aria-hidden>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="card px-4 py-3">
          <div className="h-2.5 w-16 rounded bg-slate-100 animate-pulse" />
          <div className="mt-2 h-5 w-12 rounded bg-slate-100 animate-pulse" />
        </div>
      ))}
    </div>
  )
}

// --- funnel (all-time, from GET /api/analytics) ------------------------------

function Funnel({ legacy }) {
  if (legacy.error && !legacy.data) {
    return (
      <Panel id="funnel" title="Pipeline funnel">
        <ErrorState error={legacy.error} onRetry={legacy.reload} />
      </Panel>
    )
  }
  if (!legacy.data) {
    return <Panel id="funnel" title="Pipeline funnel"><Spinner label="Loading the funnel…" /></Panel>
  }
  const funnel = legacy.data.funnel
  const stages = [
    ['Leads', funnel.leads],
    ['Contacted', funnel.contacted],
    ['Replied', funnel.replied],
    ['Interested', funnel.interested],
    ['Won', funnel.won],
  ]
  const max = Math.max(1, funnel.leads)

  return (
    <Panel
      id="funnel"
      title="Pipeline funnel"
      note="All time, across every campaign — the stage each lead has reached, not a range. Conversion is measured against the stage above it."
    >
      {funnel.leads === 0 ? (
        <EmptyState icon="reports" title="No leads yet" hint="Import or add leads and the funnel fills in from the top." />
      ) : (
        <>
          <div className="space-y-2">
            {stages.map(([label, value], i) => {
              const prev = i === 0 ? null : stages[i - 1][1]
              const conv = prev === null ? null : prev > 0 ? Math.round((value / prev) * 1000) / 10 : null
              return (
                <div key={label} className="flex items-center gap-3">
                  <div className="w-24 shrink-0 text-xs text-slate-600">{label}</div>
                  <div className="flex-1 h-6 rounded-md bg-slate-100 overflow-hidden" aria-hidden>
                    <div className="h-full rounded-md" style={{ width: `${Math.max(value > 0 ? 2 : 0, (value / max) * 100)}%`, background: SERIES_COLORS.sent }} />
                  </div>
                  <div className="w-36 shrink-0 text-right text-sm tabular-nums text-ink-900">
                    {n(value)}
                    <span className="ml-1.5 text-xs text-slate-500">
                      {conv === null ? 'leads' : `${conv.toFixed(1)}% of ${stages[i - 1][0].toLowerCase()}`}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          {/* `sr-only` on the wrapper, not the table — a table will not shrink
              below its min-content width, so on the table itself it stayed
              full-size and pushed the page sideways. See Reports.jsx. */}
          <div className="sr-only">
            <table>
              <caption>Pipeline stages, all time, with conversion from the previous stage</caption>
              <thead><tr><th>Stage</th><th>Leads</th><th>Conversion from previous stage</th></tr></thead>
              <tbody>
                {stages.map(([label, value], i) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{value}</td>
                    <td>{i === 0 ? 'n/a' : pctText(stages[i - 1][1] > 0 ? (value / stages[i - 1][1]) * 100 : 0, stages[i - 1][1])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}

// --- learning ----------------------------------------------------------------

function Learning({ legacy }) {
  const learning = legacy.data?.learning || []
  const insights = legacy.data?.insights || []

  return (
    <Panel
      id="learning"
      title="Learning"
      note="What the results say about the playbooks, computed from reply attribution per step: each reply is credited to the send that earned it. All time, across every campaign."
    >
      {!legacy.data ? (
        <Spinner label="Loading the learning section…" />
      ) : insights.length === 0 && learning.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing to learn from yet — replies are attributed to playbook steps once a campaign has both sends and answers.
        </p>
      ) : (
        <>
          {insights.length > 0 && (
            <ul className="space-y-1.5 text-sm text-slate-700 mb-3">
              {insights.map((line, i) => <li key={i} className="rounded-lg bg-slate-100 px-3 py-2">{line}</li>)}
            </ul>
          )}
          {learning.length > 0 && (
            <TableScroll label="Reply attribution per playbook step">
              <table className="w-full text-sm">
                <caption className="sr-only">Replies attributed to each playbook step, all time</caption>
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th scope="col" className="py-2 pr-3 font-medium">Campaign</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Step</th>
                    <th scope="col" className="py-2 pr-3 font-medium text-right">Emails sent</th>
                    <th scope="col" className="py-2 pr-3 font-medium text-right">Replies attributed</th>
                    <th scope="col" className="py-2 font-medium text-right">Reply rate (per email)</th>
                  </tr>
                </thead>
                <tbody>
                  {learning.map((l) => (
                    <tr key={`${l.campaignId}-${l.nodeId}`} className="border-b border-slate-200 last:border-0">
                      <td className="py-2 pr-3 text-slate-700">
                        <Link to={`/app/campaigns/${l.campaignId}`} className="hover:text-accent-700">{l.campaignName}</Link>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-accent-700">{l.nodeId}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{n(l.sent)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{n(l.replies)}</td>
                      <td className="py-2 text-right tabular-nums">{pctText(l.replyRate, l.sent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </>
      )}
    </Panel>
  )
}
