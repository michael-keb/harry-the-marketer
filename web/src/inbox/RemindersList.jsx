// Every reminder in the workspace, in one place.
//
// Overdue is derived at read time by the API and never stored, so it cannot
// drift — and it is rendered as the word "Overdue", never as a red row that a
// colour-blind reader would miss. Each row links back to the conversation the
// reminder was set from rather than trying to be a second inbox.

import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { LoadMore, usePagedList } from '../parity-ui.jsx'
import { EmptyState } from '../ui.jsx'
import { Banner, Marker, REMIND_PRESETS, SkeletonRows, absolute, relative } from './common.jsx'

const STATUSES = [['pending', 'Still open'], ['cleared', 'Done'], ['fired', 'Fired'], ['all', 'All']]
const DUES = [['all', 'Any time'], ['overdue', 'Overdue'], ['today', 'Due today']]

export default function RemindersList({ refs, onOpenThread, announce }) {
  const [status, setStatus] = useState('pending')
  const [due, setDue] = useState('all')
  const [leads, setLeads] = useState({})
  const [actionError, setActionError] = useState(null)
  const list = usePagedList('/api/reminders', { status, due, limit: 50 })

  // Reminder rows carry ids, not names. One lookup builds the map the rows read
  // from — the same list the Leads page already loads.
  useEffect(() => {
    let live = true
    api.get('/api/leads')
      .then((rows) => {
        if (!live) return
        setLeads(Object.fromEntries(rows.map((l) => [l.id, [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email])))
      })
      .catch(() => { /* rows fall back to the lead id */ })
    return () => { live = false }
  }, [])

  const act = async (reminder, patch, said) => {
    setActionError(null)
    try {
      await api.patch(`/api/reminders/${reminder.id}`, patch)
      announce?.(said)
      list.reload()
    } catch (err) { setActionError(err) }
  }

  const cancel = async (reminder) => {
    setActionError(null)
    try {
      await api.del(`/api/reminders/${reminder.id}`)
      announce?.('Reminder cancelled')
      list.reload()
    } catch (err) { setActionError(err) }
  }

  const campaignName = (id) => refs.campaigns.find((c) => c.id === id)?.name || ''

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Status
          <select className="input mt-1 !w-auto !py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          Due
          <select className="input mt-1 !w-auto !py-1.5" value={due} onChange={(e) => setDue(e.target.value)}>
            {DUES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {actionError && <Banner error={actionError} />}
      {list.error && <Banner error={list.error} onRetry={list.reload} />}
      {list.loading && list.items.length === 0 && <SkeletonRows rows={4} label="Loading reminders…" />}

      {!list.loading && !list.error && list.items.length === 0 && (
        <EmptyState
          icon="alert"
          title="No reminders — set one from any thread"
          hint="Open a conversation and use Reminders in the panel below the messages. Reminders are yours to chase; they never send anything."
        />
      )}

      {list.items.length > 0 && (
        <ul className="card divide-y divide-slate-200">
          {list.items.map((r) => (
            <li key={r.id} className="px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-900">{r.note || '(no note)'}</span>
                {r.is_overdue && <Marker tone="bad">Overdue</Marker>}
                {r.status !== 'pending' && <Marker>{r.status === 'cleared' ? 'Done' : 'Fired'}</Marker>}
                <span className="ml-auto shrink-0 text-xs text-slate-500" title={absolute(r.reminder_at)}>
                  Due {relative(r.reminder_at)}
                  <span className="sr-only"> — {absolute(r.reminder_at)}</span>
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {leads[r.lead_id] || `Lead #${r.lead_id}`}
                {campaignName(r.campaign_id) ? ` · ${campaignName(r.campaign_id)}` : ''}
                {r.created_by ? ` · set by ${r.created_by}` : ''}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {r.message_id && (
                  <button type="button" className="btn-ghost !px-2 !py-1 text-[11px]" onClick={() => onOpenThread(r.message_id)}>
                    Open the conversation
                  </button>
                )}
                {r.status === 'pending' && (
                  <>
                    <button type="button" className="btn-ghost !px-2 !py-1 text-[11px]" onClick={() => act(r, { status: 'cleared' }, 'Reminder marked done')}>
                      Mark done
                    </button>
                    {REMIND_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="btn-ghost !px-2 !py-1 text-[11px]"
                        title={absolute(preset.at().toISOString())}
                        onClick={() => act(r, { remindAt: preset.at().toISOString() }, `Reminder moved to ${absolute(preset.at().toISOString())}`)}
                      >
                        Snooze to {preset.label.toLowerCase()}
                      </button>
                    ))}
                  </>
                )}
                <button type="button" className="text-[11px] text-slate-500 underline cursor-pointer hover:text-red-700" onClick={() => cancel(r)}>
                  Cancel reminder
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
    </div>
  )
}
