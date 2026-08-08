// Lead tasks — Docs/lead-tasks/*.
//
// The same rows read two ways: a panel beside the notes on one lead, and the
// workspace-wide list of open human work. Both go through GET with the same
// filters and the same ordering, so the panel and the list can never disagree
// about what is at the top.
//
// Overdue is a word, never a colour: `overdue` comes back as a boolean from the
// server and is rendered as the text "Overdue" with an icon beside it.
//
// Known backend divergence, stated in server/parity/notes.js: `priority` is
// validated on write but the frozen `lead_tasks` schema has no column for it,
// so nothing is returned. The form therefore does not offer one rather than
// showing a control whose value vanishes on the next read.

import { useCallback, useEffect, useState } from 'react'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, Icon, useToast } from '../ui.jsx'
import { LiveRegion, Stat } from '../parity-ui.jsx'
import { FieldError, FormError, Field, Panel, Sheet, when, fromLocalInput } from './shared.jsx'

// ---- roster ------------------------------------------------------------------

// An assignee must be someone who can pick the work up; the server 422s on
// anyone outside the workspace, so the picker only offers members.
export function useRoster() {
  const [roster, setRoster] = useState({ owner: '', members: [] })
  useEffect(() => {
    let live = true
    api.get('/api/team')
      .then((res) => {
        if (!live) return
        const emails = [res.ownerEmail, ...(res.members || []).map((m) => m.email)].filter(Boolean)
        setRoster({ owner: res.ownerEmail || '', members: [...new Set(emails)] })
      })
      .catch(() => { /* the picker degrades to "unassigned" only */ })
    return () => { live = false }
  }, [])
  return roster
}

// ---- one task ----------------------------------------------------------------

function TaskRow({ task, roster, onChanged, onOpenLead }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const patch = async (body) => {
    setBusy(true)
    try {
      const res = await api.patch(`/api/tasks/${task.id}`, body)
      onChanged(res.task)
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const done = task.status !== 'open'

  return (
    <li className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 cursor-pointer accent-accent-500"
          checked={done}
          disabled={busy}
          onChange={(e) => patch({ status: e.target.checked ? 'done' : 'open' })}
          aria-label={done ? `Reopen task ${task.title}` : `Mark task ${task.title} complete`}
        />
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${done ? 'text-slate-500 line-through' : 'text-ink-900'}`}>{task.title}</p>
          {task.body && <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600">{task.body}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {task.overdue && (
              <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">
                <Icon name="alert" className="size-3" />
                Overdue
              </span>
            )}
            <span>{task.dueAt ? `Due ${when(task.dueAt)}` : 'No due date'}</span>
            {task.campaign && <span>· {task.campaign.name || `Campaign #${task.campaign.id}`}</span>}
            {task.unowned && <span className="text-amber-700">· nobody in the workspace is carrying this</span>}
            {done && task.completedAt && <span>· completed {when(task.completedAt)}</span>}
            {onOpenLead && (
              <button type="button" className="cursor-pointer text-accent-700 underline hover:text-accent-600" onClick={() => onOpenLead(task.leadId)}>
                Open lead
              </button>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <label className="sr-only" htmlFor={`task-assignee-${task.id}`}>Assigned to, for “{task.title}”</label>
          <select
            id={`task-assignee-${task.id}`}
            className="input w-40 py-1 text-xs"
            value={task.assignedEmail || ''}
            disabled={busy}
            onChange={(e) => patch({ assignedEmail: e.target.value })}
          >
            <option value="">Unassigned</option>
            {roster.members.map((email) => <option key={email} value={email}>{email}</option>)}
            {task.assignedEmail && !roster.members.includes(task.assignedEmail) && (
              <option value={task.assignedEmail}>{task.assignedEmail} (former member)</option>
            )}
          </select>
        </div>
      </div>
    </li>
  )
}

// ---- create ------------------------------------------------------------------

function TaskForm({ leadId, roster, enrolments = [], onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', body: '', dueAt: '', assignedEmail: '', campaignId: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setError(null) }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post(`/api/leads/${leadId}/tasks`, {
        title: form.title,
        body: form.body || undefined,
        dueAt: fromLocalInput(form.dueAt) || undefined,
        assignedEmail: form.assignedEmail || undefined,
        campaignId: form.campaignId || undefined,
      })
      onCreated(res.task)
      onClose()
    } catch (err) {
      // The typed values survive; the reason shows against the field it names.
      setError(err)
    } finally { setBusy(false) }
  }

  return (
    <Sheet title="Add a task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" id="task-form">
        <Field label="What needs doing *" htmlFor="task-title">
          <input id="task-title" className="input" required value={form.title} onChange={set('title')} placeholder="Send the 50-seat pricing" />
          <FieldError err={error} field="title" />
        </Field>
        <Field label="Detail" htmlFor="task-body">
          <textarea id="task-body" className="input min-h-16" value={form.body} onChange={set('body')} />
          <FieldError err={error} field="body" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due" htmlFor="task-due" hint="A date in the past is accepted and shown as overdue — the work is late, not invalid.">
            <input id="task-due" type="datetime-local" className="input" value={form.dueAt} onChange={set('dueAt')} />
            <FieldError err={error} field="dueAt" />
          </Field>
          <Field label="Assign to" htmlFor="task-assignee">
            <select id="task-assignee" className="input" value={form.assignedEmail} onChange={set('assignedEmail')}>
              <option value="">Unassigned</option>
              {roster.members.map((email) => <option key={email} value={email}>{email}</option>)}
            </select>
            <FieldError err={error} field="assignedEmail" />
          </Field>
        </div>
        {enrolments.length > 0 && (
          <Field label="Campaign" htmlFor="task-campaign" hint="Optional. Scoping a task to a campaign keeps a promise made in one out of another.">
            <select id="task-campaign" className="input" value={form.campaignId} onChange={set('campaignId')}>
              <option value="">General — not about one campaign</option>
              {enrolments.map((e) => <option key={e.campaignId} value={e.campaignId}>{e.campaignName}</option>)}
            </select>
            <FieldError err={error} field="campaignId" />
          </Field>
        )}
        <FormError err={error} fields={['title', 'body', 'dueAt', 'assignedEmail', 'campaignId']} />
      </form>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="task-form" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add task'}</button>
      </div>
    </Sheet>
  )
}

// ---- the panel on a lead -----------------------------------------------------

export function LeadTasks({ leadId, enrolments }) {
  const roster = useRoster()
  const [items, setItems] = useState(null)
  const [counts, setCounts] = useState(null)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [live, setLive] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/leads/${leadId}/tasks${qs({ status: showDone ? 'all' : 'open', limit: 50 })}`)
      setItems(res.items || [])
      setCounts(res.counts || null)
    } catch (err) { setError(err) }
  }, [leadId, showDone])

  useEffect(() => { load() }, [load])

  const replace = (task) => {
    setItems((list) => (list || []).map((t) => (t.id === task.id ? task : t)))
    setLive(`Task “${task.title}” updated`)
    if (!showDone && task.status !== 'open') {
      setItems((list) => (list || []).filter((t) => t.id !== task.id))
    }
  }

  return (
    <Panel
      title="Tasks"
      hint="Off-email follow-up. A task never blocks the engine and never gates a send."
      action={<button type="button" className="btn-ghost" onClick={() => setAdding(true)}>Add task</button>}
    >
      <LiveRegion message={live} />
      <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" className="size-3.5 cursor-pointer accent-accent-500" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
        Show completed and cancelled
      </label>
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : items === null ? (
        <Spinner label="Loading tasks…" />
      ) : items.length === 0 ? (
        <EmptyState title="No tasks" hint="Turn something you just read into a follow-up, so it survives the next fifty emails." action={<button type="button" className="btn-primary" onClick={() => setAdding(true)}>Add a task</button>} />
      ) : (
        <ul className="space-y-2">
          {items.map((task) => (
            <TaskRow key={task.id} task={task} roster={roster} onChanged={replace} />
          ))}
        </ul>
      )}
      {counts && (
        <p className="mt-2 text-[11px] text-slate-500">
          Workspace-wide: {counts.open} open, {counts.overdue} overdue.
        </p>
      )}
      {adding && (
        <TaskForm
          leadId={leadId}
          roster={roster}
          enrolments={enrolments}
          onClose={() => setAdding(false)}
          onCreated={(task) => { setItems((list) => [task, ...(list || [])]); setLive(`Task “${task.title}” added`) }}
        />
      )}
    </Panel>
  )
}

// ---- the workspace list ------------------------------------------------------

// Docs/lead-tasks/create.md puts open tasks in the Dashboard Action Center. The
// Dashboard is another agent's file, so the same list is rendered here as a tab
// on the page that owns leads — still no new navigation item.
export function OpenTasks({ onOpenLead }) {
  const roster = useRoster()
  const [filters, setFilters] = useState({ status: 'open', due: 'any', assignedTo: '' })
  const [items, setItems] = useState(null)
  const [counts, setCounts] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [live, setLive] = useState('')

  const load = useCallback(async () => {
    setError(null)
    setItems(null)
    try {
      const res = await api.get(`/api/tasks${qs({ ...filters, limit: 50 })}`)
      setItems(res.items || [])
      setCounts(res.counts || null)
      setHasMore(Boolean(res.hasMore))
      setOffset(res.nextOffset ?? 0)
      setLive(`${(res.items || []).length} task${(res.items || []).length === 1 ? '' : 's'} shown`)
    } catch (err) { setError(err) }
  }, [filters])

  useEffect(() => { load() }, [load])

  const more = async () => {
    setLoadingMore(true)
    try {
      const res = await api.get(`/api/tasks${qs({ ...filters, limit: 50, offset })}`)
      setItems((list) => [...(list || []), ...(res.items || [])])
      setHasMore(Boolean(res.hasMore))
      setOffset(res.nextOffset ?? offset)
    } catch (err) { setError(err) } finally { setLoadingMore(false) }
  }

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))

  return (
    <div className="space-y-4">
      <LiveRegion message={live} />
      {counts && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Open" value={counts.open.toLocaleString()} />
          <Stat label="Overdue" value={counts.overdue.toLocaleString()} tone={counts.overdue ? 'bad' : undefined} hint="Past their due date and still open" />
          <Stat label="Completed" value={counts.done.toLocaleString()} />
        </div>
      )}

      <div className="card flex flex-wrap items-end gap-3 px-4 py-3">
        <Field label="Status" htmlFor="task-filter-status">
          <select id="task-filter-status" className="input w-40" value={filters.status} onChange={set('status')}>
            <option value="open">Open</option>
            <option value="done">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </select>
        </Field>
        <Field label="Due" htmlFor="task-filter-due">
          <select id="task-filter-due" className="input w-40" value={filters.due} onChange={set('due')}>
            <option value="any">Any time</option>
            <option value="overdue">Overdue only</option>
            <option value="today">Due today</option>
            <option value="week">Due this week</option>
          </select>
        </Field>
        <Field label="Assigned to" htmlFor="task-filter-who">
          <select id="task-filter-who" className="input w-56" value={filters.assignedTo} onChange={set('assignedTo')}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            {roster.members.map((email) => <option key={email} value={email}>{email}</option>)}
          </select>
        </Field>
        <p className="ml-auto max-w-xs text-[11px] text-slate-500">
          Undated tasks are never overdue and are excluded from every date filter — they are simply undated.
        </p>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : items === null ? (
        <Spinner label="Loading tasks…" />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing waiting on a person" hint="Tasks created on a lead show up here, overdue first." />
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                roster={roster}
                onOpenLead={onOpenLead}
                onChanged={(updated) => setItems((list) => list.map((t) => (t.id === updated.id ? updated : t)))}
              />
            ))}
          </ul>
          {hasMore && (
            <div className="flex justify-center py-2">
              <button type="button" className="btn-ghost" onClick={more} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
