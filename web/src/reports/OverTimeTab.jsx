// Over time — the two day-wise series, each with the axis toggle that is the
// whole point of these four endpoints.
//
// Routes: GET /api/analytics/daily?axis=event|sent
//         GET /api/analytics/positive-replies/daily?axis=reply|sent
//
// "By event date" answers *what happened on Tuesday*. "By send date" answers
// *what Tuesday's sending earned*, crediting every open and reply back to the
// email that caused it. They are different questions and the labels say so.

import { useId, useMemo, useState } from 'react'
import { EmptyState, ErrorState } from '../parity-ui.jsx'
import {
  DaySeriesChart, Panel, RangeCaption, StaleMarker, TableScroll,
  SERIES_COLORS, n, pctText, useApi,
} from './shared.jsx'

const MATURING_DAYS = 3

// A labelled radio group, because an axis is a choice between two meanings and
// a toggle switch cannot say which meaning is on.
function AxisChoice({ legend, name, value, onChange, options }) {
  const id = useId()
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <label
            key={o.value}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              value === o.value ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-600 hover:text-ink-900'
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              name={`${name}-${id}`}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export default function OverTimeTab({ params }) {
  return (
    <div className="space-y-4">
      <DailySeries params={params} />
      <PositiveSeries params={params} />
    </div>
  )
}

// --- sends, opens, clicks, replies -------------------------------------------

function DailySeries({ params }) {
  const [axis, setAxis] = useState('event')
  const [showLosses, setShowLosses] = useState(false)
  const { data, error, loading, reload, stale } = useApi('/api/analytics/daily', { ...params, axis })

  const items = data?.items || []
  const hasAny = items.some((d) => d.sent || d.replied || d.opened || d.clicked)

  const series = useMemo(() => {
    const base = [
      { key: 'sent', label: 'Emails sent', color: SERIES_COLORS.sent, marker: 'circle' },
      { key: 'opened', label: 'Opens', color: SERIES_COLORS.opened, marker: 'square' },
      { key: 'clicked', label: 'Clicks', color: SERIES_COLORS.clicked, marker: 'triangle' },
      { key: 'replied', label: 'Replies', color: SERIES_COLORS.replied, marker: 'diamond' },
      { key: 'positive_replied', label: 'Positive replies', color: SERIES_COLORS.positive, marker: 'cross' },
    ]
    // On the event axis a bounce has no honest event date of its own, so the
    // line is deliberately absent and a sentence says why.
    if (axis === 'sent' && showLosses) {
      base.push(
        { key: 'bounced', label: 'Bounces', color: SERIES_COLORS.bounced, marker: 'square' },
        { key: 'unsubscribed', label: 'Unsubscribes', color: SERIES_COLORS.unsubscribed, marker: 'triangle' },
      )
    }
    return base
  }, [axis, showLosses])

  const weekdays = useWeekdaySummary(items)

  return (
    <Panel
      id="daily"
      title="Day by day"
      note={axis === 'event'
        ? 'Each metric sits on the day it happened: a send on the day it went out, an open on the day it was opened, a reply on the day it arrived. This reads like a diary of the range.'
        : 'Everything is credited to the day its originating email was sent, so a Tuesday column is what Tuesday’s sending earned — whenever the answer actually came back.'}
      actions={<>
        <RangeCaption range={data?.range} />
        <StaleMarker stale={stale} error={error} />
      </>}
    >
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <AxisChoice
          legend="Which date each number sits on"
          name="daily-axis"
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'event', label: 'By the day it happened' },
            { value: 'sent', label: 'By the day the email was sent' },
          ]}
        />
        {axis === 'sent' && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              className="cursor-pointer accent-accent-500"
              checked={showLosses}
              onChange={(e) => setShowLosses(e.target.checked)}
            />
            Show bounces and unsubscribes
          </label>
        )}
      </div>

      {loading && !data ? (
        <div className="h-56 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : !hasAny ? (
        <EmptyState
          icon="reports"
          title="Nothing happened in this range"
          hint={`No sends, opens or replies between ${data.range?.from} and ${data.range?.to}. The chart would be a flat zero line, so it is not drawn.`}
        />
      ) : (
        <>
          <DaySeriesChart
            days={items}
            series={series}
            unit="emails and replies"
            xLabel={`Date (${data.range?.timezone})`}
            yLabel="Count per day"
            maturingDays={axis === 'sent' ? MATURING_DAYS : 0}
            maturingNote={`The shaded last ${MATURING_DAYS} days are still maturing: replies to those sends may not have arrived yet, so those columns will only go up.`}
            caption={`${data.metadata?.axis_note} Timezone ${data.range?.timezone}. Days with no activity are drawn as zero, never skipped.`}
          />
          <p className="mt-2 text-xs text-slate-500 leading-relaxed">
            {axis === 'event'
              ? 'Bounces are not drawn on this axis — a bounce belongs to the send that caused it, so it is shown on the send-date axis instead.'
              : `${n(data.untraceable_replies)} reply${data.untraceable_replies === 1 ? '' : ' events'} could not be traced back to a send and ${data.untraceable_replies === 1 ? 'is' : 'are'} excluded from this axis rather than guessed at.`}
            {' '}Unique leads reached is listed per day in the table and must never be added up: the same lead can be reached on two days.
          </p>
          <WeekdayStrip rows={weekdays} />
          <UniqueLeadTable items={items} range={data.range} />
        </>
      )}
    </Panel>
  )
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function useWeekdaySummary(items) {
  return useMemo(() => {
    const acc = WEEKDAY_NAMES.map((name) => ({ name, days: 0, sent: 0, replied: 0 }))
    for (const d of items) {
      const key = String(d.day || '')
      const t = Date.parse(`${key}T00:00:00Z`)
      if (Number.isNaN(t)) continue
      const idx = new Date(t).getUTCDay()
      acc[idx].days += 1
      acc[idx].sent += Number(d.sent || 0)
      acc[idx].replied += Number(d.replied || 0)
    }
    // Monday first — the working week is how sending rhythm is actually planned.
    return [...acc.slice(1), acc[0]].filter((r) => r.days > 0)
  }, [items])
}

function WeekdayStrip({ rows }) {
  if (!rows.length) return null
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold text-slate-600 mb-1.5">By day of the week</h4>
      <TableScroll label="Weekday averages">
        <table className="w-full min-w-[420px] text-xs">
          <caption className="sr-only">Average emails sent per weekday and the replies each weekday earned, computed from the same response as the chart above</caption>
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th scope="col" className="py-1.5 pr-3">Weekday</th>
              <th scope="col" className="py-1.5 pr-3 text-right">Avg emails sent</th>
              <th scope="col" className="py-1.5 pr-3 text-right">Replies</th>
              <th scope="col" className="py-1.5 text-right">Replies per email sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-slate-200 last:border-0">
                <th scope="row" className="py-1 pr-3 font-normal text-slate-600">{r.name}s <span className="text-slate-400">({r.days})</span></th>
                <td className="py-1 pr-3 text-right tabular-nums text-slate-700">{Math.round((r.sent / r.days) * 10) / 10}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-slate-700">{n(r.replied)}</td>
                <td className="py-1 text-right tabular-nums text-slate-700">{pctText(r.sent > 0 ? (r.replied / r.sent) * 100 : 0, r.sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}

function UniqueLeadTable({ items, range }) {
  const rows = items.filter((d) => d.unique_lead_reached > 0)
  if (!rows.length) return null
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-slate-600 hover:text-accent-700">
        Show unique leads reached per day ({rows.length} day{rows.length === 1 ? '' : 's'})
      </summary>
      <TableScroll label="Unique leads reached per day">
        <table className="w-full text-xs mt-2">
          <caption className="sr-only">
            Distinct leads reached each day from {range?.from} to {range?.to}. These figures cannot be added across days.
          </caption>
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th scope="col" className="py-1.5 pr-3">Date</th>
              <th scope="col" className="py-1.5 text-right">Unique leads reached</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.day} className="border-b border-slate-200 last:border-0">
                <th scope="row" className="py-1 pr-3 font-normal text-slate-600">{d.day}</th>
                <td className="py-1 text-right tabular-nums text-slate-700">{n(d.unique_lead_reached)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </details>
  )
}

// --- positive replies --------------------------------------------------------

function PositiveSeries({ params }) {
  const [axis, setAxis] = useState('reply')
  const { data, error, loading, reload, stale } = useApi('/api/analytics/positive-replies/daily', { ...params, axis })
  const items = data?.items || []
  const hasAny = items.some((d) => d.count || d.reply_events)

  return (
    <Panel
      id="positive-daily"
      title="Positive replies day by day"
      note={axis === 'reply'
        ? 'Plotted on the day the positive reply landed in the inbox.'
        : 'Plotted on the day the email that earned the positive reply went out — this is the view that tells you which sending days are worth repeating.'}
      actions={<>
        <RangeCaption range={data?.range} />
        <StaleMarker stale={stale} error={error} />
      </>}
    >
      <div className="mb-3">
        <AxisChoice
          legend="Which date a positive reply sits on"
          name="positive-axis"
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'reply', label: 'By the day the reply arrived' },
            { value: 'sent', label: 'By the day the email was sent' },
          ]}
        />
      </div>

      {loading && !data ? (
        <div className="h-56 rounded-lg bg-slate-100 animate-pulse" aria-hidden />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? null : !hasAny ? (
        <EmptyState
          icon="inbox"
          title="No positive replies in this range"
          hint={`Nobody answered positively between ${data.range?.from} and ${data.range?.to}.`}
        />
      ) : (
        <>
          <DaySeriesChart
            days={items}
            series={[
              { key: 'count', label: 'Leads answering positively', color: SERIES_COLORS.positive, marker: 'circle' },
              { key: 'reply_events', label: 'Positive reply emails', color: SERIES_COLORS.replied, marker: 'diamond' },
            ]}
            unit="leads"
            xLabel={`Date (${data.range?.timezone})`}
            yLabel="Count per day"
            maturingDays={axis === 'sent' ? MATURING_DAYS : 0}
            maturingNote={`The shaded last ${MATURING_DAYS} days are still maturing: a positive reply to a recent send may not have arrived yet.`}
            caption={`Positive replies ${axis === 'reply' ? 'by the day the reply arrived' : 'by the day the email that earned them was sent'}, timezone ${data.range?.timezone}. Days with none are drawn as zero.`}
          />
          <p className="mt-2 text-xs text-slate-500 leading-relaxed">
            {n(data.range_total)} distinct lead{data.range_total === 1 ? '' : 's'} answered positively across the whole range.
            That is not the sum of the daily figures — a lead answering twice on two days is one lead here and two rows above.
            {data.untraceable_replies > 0 && ` ${n(data.untraceable_replies)} positive repl${data.untraceable_replies === 1 ? 'y' : 'ies'} could not be traced back to a send and ${data.untraceable_replies === 1 ? 'is' : 'are'} excluded from the send-date view.`}
          </p>
        </>
      )}
    </Panel>
  )
}
