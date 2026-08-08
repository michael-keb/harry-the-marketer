// The one side strip inside a thread: reminders, notes and tasks as three tabs
// rather than three columns. Under 768px it is a section below the messages,
// which is what the frontend stories ask for and what 375px can actually hold.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Tabs } from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'
import {
  Banner, FieldError, Marker, REMIND_PRESETS, absolute, fromLocalInput, relative, toLocalInput,
} from './common.jsx'

export function ThreadPanels({ thread, refs, onChanged, announce }) {
  const [tab, setTab] = useState('reminders')
  const leadId = thread.lead?.id
  const pending = (thread.reminders || []).filter((r) => r.status === 'pending')

  return (
    <section aria-label="Reminders, notes and tasks" className="rounded-xl border border-slate-200 p-3">
      <Tabs
        ariaLabel="Reminders, notes and tasks"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'reminders', label: 'Reminders', count: pending.length },
          { id: 'notes', label: 'Notes' },
          { id: 'tasks', label: 'Tasks' },
        ]}
      />
      {tab === 'reminders' && <RemindersPanel thread={thread} onChanged={onChanged} announce={announce} />}
      {tab === 'notes' && (leadId ? <NotesPanel leadId={leadId} threadId={thread.id} /> : <NoLead what="Notes" />)}
      {tab === 'tasks' && (leadId ? <TasksPanel leadId={leadId} threadId={thread.id} refs={refs} /> : <NoLead what="Tasks" />)}
    </section>
  )
}

const NoLead = ({ what }) => (
  <p className="text-sm text-slate-600">{what} need a lead. This conversation is not attached to one yet.</p>
)

// -------------------------------------------------------------- reminders ---

function RemindersPanel({ thread, onChanged, announce }) {
  const subject = thread.messages?.[thread.messages.length - 1]?.subject || ''
  const [note, setNote] = useState(subject ? `Follow up on “${subject}”` : '')
  const [when, setWhen] = useState(toLocalInput(REMIND_PRESETS[0].at()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const iso = fromLocalInput(when)
  const reminders = thread.reminders || []

  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/inbox/threads/${thread.id}/reminders`, { note, remindAt: iso })
      announce?.(`Reminder set for ${absolute(iso)}`)
      setNote(subject ? `Follow up on “${subject}”` : '')
      await onChanged()
    } catch (err) {
      // The typed note and the chosen time survive a failure.
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const update = async (reminder, patch) => {
    try {
      await api.patch(`/api/reminders/${reminder.id}`, patch)
      await onChanged()
    } catch (err) { setError(err) }
  }

  const remove = async (reminder) => {
    try {
      await api.del(`/api/reminders/${reminder.id}`)
      await onChanged()
    } catch (err) { setError(err) }
  }

  return (
    <div className="space-y-3">
      {reminders.length === 0 ? (
        <p className="text-sm text-slate-600">No reminders on this lead.</p>
      ) : (
        <ul className="space-y-2">
          {reminders.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-900">{r.note}</span>
                {r.is_overdue && <Marker tone="bad">Overdue</Marker>}
                {r.status !== 'pending' && <Marker>{r.status === 'cleared' ? 'Done' : r.status}</Marker>}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500" title={absolute(r.reminder_at)}>
                Due {relative(r.reminder_at)}
                <span className="sr-only"> — {absolute(r.reminder_at)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {r.status === 'pending' && (
                  <>
                    <button type="button" className="btn-ghost !px-2 !py-1 text-[11px]" onClick={() => update(r, { status: 'cleared' })}>
                      Mark done
                    </button>
                    {REMIND_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="btn-ghost !px-2 !py-1 text-[11px]"
                        title={absolute(preset.at().toISOString())}
                        onClick={() => update(r, { remindAt: preset.at().toISOString() })}
                      >
                        Snooze to {preset.label.toLowerCase()}
                      </button>
                    ))}
                  </>
                )}
                <button type="button" className="text-[11px] text-slate-500 underline cursor-pointer hover:text-red-700" onClick={() => remove(r)}>
                  Cancel reminder
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="space-y-2 border-t border-slate-200 pt-3">
        <div>
          <label className="block text-xs text-slate-600" htmlFor="reminder-note">Remind me to</label>
          <input id="reminder-note" className="input mt-1" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <FieldError error={error} field="note" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {REMIND_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="rounded-full border border-slate-300 px-2.5 py-1 text-[11px] text-slate-700 hover:border-accent-500 cursor-pointer"
              title={absolute(preset.at().toISOString())}
              onClick={() => setWhen(toLocalInput(preset.at()))}
            >
              {preset.label} — {absolute(preset.at().toISOString())}
            </button>
          ))}
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="reminder-at">Remind me on</label>
          <input id="reminder-at" type="datetime-local" className="input mt-1" value={when} onChange={(e) => setWhen(e.target.value)} />
          <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
            {iso ? `You will be reminded ${absolute(iso)} — ${relative(iso)}.` : 'Pick a date and time.'}
          </p>
          <FieldError error={error} field="remindAt" />
        </div>
        <Banner error={error} handled={['note', 'remindAt']} />
        <button type="submit" className="btn-primary !py-1.5 text-xs" disabled={busy || !note.trim() || !iso}>
          {busy ? 'Saving…' : 'Set reminder'}
        </button>
      </form>
    </div>
  )
}

// ------------------------------------------------------------------ notes ---

function NotesPanel({ leadId, threadId }) {
  const [state, setState] = useState({ items: null, error: null })
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    api.get(`/api/leads/${leadId}/notes?limit=50`)
      .then((r) => setState({ items: r.items || [], error: null }))
      .catch((err) => setState({ items: null, error: err }))
  }, [leadId])
  useEffect(() => { load() }, [load])

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/inbox/threads/${threadId}/notes`, { text })
      setText('')
      load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {state.error && <Banner error={state.error} onRetry={load} />}
      {!state.items && !state.error && <p className="text-sm text-slate-600">Loading notes…</p>}
      {state.items?.length === 0 && <p className="text-sm text-slate-600">No notes yet — add what you learned.</p>}
      {state.items?.length > 0 && (
        <ul className="space-y-2">
          {state.items.map((n) => (
            <li key={n.id} className="rounded-lg border border-slate-200 p-2.5">
              <div className="whitespace-pre-wrap text-sm text-ink-900">{n.body}</div>
              <div className="mt-1 text-[11px] text-slate-500" title={absolute(n.createdAt)}>
                {n.author?.name || n.author?.email || 'Someone'} · {timeAgo(n.createdAt)}
                {n.campaign?.name ? ` · ${n.campaign.name}` : ' · general'}
                <span className="sr-only"> — {absolute(n.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="space-y-2 border-t border-slate-200 pt-3">
        <label className="block text-xs text-slate-600" htmlFor="note-text">Add a note</label>
        <textarea id="note-text" className="input min-h-20" value={text} maxLength={10000} onChange={(e) => setText(e.target.value)} />
        <div className="text-[11px] text-slate-500">{text.length}/10000 characters</div>
        <FieldError error={error} field="text" />
        <Banner error={error} handled={['text']} />
        <button type="submit" className="btn-primary !py-1.5 text-xs" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save note'}</button>
      </form>
    </div>
  )
}

// ------------------------------------------------------------------ tasks ---

function TasksPanel({ leadId, threadId, refs }) {
  const [state, setState] = useState({ items: null, error: null })
  const [form, setForm] = useState({ name: '', description: '', dueAt: '', assignee: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    api.get(`/api/leads/${leadId}/tasks?status=open&limit=50`)
      .then((r) => setState({ items: r.items || [], error: null }))
      .catch((err) => setState({ items: null, error: err }))
  }, [leadId])
  useEffect(() => { load() }, [load])

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/inbox/threads/${threadId}/tasks`, {
        name: form.name,
        description: form.description || undefined,
        dueAt: form.dueAt ? fromLocalInput(form.dueAt) : undefined,
        assignee: form.assignee || undefined,
      })
      setForm({ name: '', description: '', dueAt: '', assignee: '' })
      load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const complete = async (task) => {
    try {
      await api.patch(`/api/tasks/${task.id}`, { status: 'done' })
      load()
    } catch (err) { setError(err) }
  }

  return (
    <div className="space-y-3">
      {state.error && <Banner error={state.error} onRetry={load} />}
      {!state.items && !state.error && <p className="text-sm text-slate-600">Loading tasks…</p>}
      {state.items?.length === 0 && <p className="text-sm text-slate-600">No tasks.</p>}
      {state.items?.length > 0 && (
        <ul className="space-y-2">
          {state.items.map((t) => (
            <li key={t.id} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5">
              <input
                type="checkbox" className="mt-1 accent-accent-500" checked={false}
                aria-label={`Complete task: ${t.title}`}
                onChange={() => complete(t)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-900">{t.title}</span>
                  {t.overdue && <Marker tone="bad">Overdue</Marker>}
                  {t.unowned && <Marker tone="warn">Nobody is carrying this</Marker>}
                </div>
                {t.body && <div className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600">{t.body}</div>}
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {t.dueAt ? <span title={absolute(t.dueAt)}>Due {relative(t.dueAt)}<span className="sr-only"> — {absolute(t.dueAt)}</span></span> : 'No due date'}
                  {t.assignedEmail ? ` · ${t.assignedEmail}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="space-y-2 border-t border-slate-200 pt-3">
        <div>
          <label className="block text-xs text-slate-600" htmlFor="task-name">Task</label>
          <input id="task-name" className="input mt-1" value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <FieldError error={error} field="name" />
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="task-desc">Detail (optional)</label>
          <textarea id="task-desc" className="input mt-1 min-h-16" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-xs text-slate-600" htmlFor="task-due">Due (optional)</label>
            <input id="task-due" type="datetime-local" className="input mt-1" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
            <FieldError error={error} field="dueAt" />
          </div>
          {!refs.solo && (
            <div>
              <label className="block text-xs text-slate-600" htmlFor="task-assignee">Owner (optional)</label>
              <select id="task-assignee" className="input mt-1" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                <option value="">Nobody yet</option>
                {refs.members.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <FieldError error={error} field="assignee" />
            </div>
          )}
        </div>
        <Banner error={error} handled={['name', 'dueAt', 'assignee']} />
        <button type="submit" className="btn-primary !py-1.5 text-xs" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Add task'}</button>
      </form>
    </div>
  )
}

// ------------------------------------------------------- outbound state line -

const TERMINAL = ['sent', 'failed', 'cancelled']

// The state of an outbound message, in words, in the timeline. No toast: the
// information belongs beside the message it describes, and polling backs off
// and stops the moment the answer cannot change again.
export function MessageStatusLine({ message, onCancelled }) {
  const [status, setStatus] = useState(() => ({
    status: message.send_status || (message.provider_message_id ? 'sent' : ''),
    statusMessage: '',
    scheduledAt: message.scheduled_at || '',
  }))
  const timer = useRef(null)

  useEffect(() => {
    let live = true
    let delay = 3000
    const settled = (s) => !s || TERMINAL.includes(s)
    const poll = async () => {
      try {
        const next = await api.get(`/api/messages/${message.id}/status`)
        if (!live) return
        setStatus(next)
        if (next.terminal) return
      } catch { /* keep the last known state rather than claiming failure */ }
      if (!live) return
      delay = Math.min(delay * 1.6, 60000)
      timer.current = setTimeout(poll, delay)
    }
    if (!settled(status.status)) timer.current = setTimeout(poll, delay)
    return () => { live = false; clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id])

  if (message.direction !== 'out') return null

  const value = status.status
  if (!value) return <div className="mt-1 text-[11px] text-slate-500">Not tracked</div>

  const label = value === 'queued'
    ? `Queued${status.scheduledAt ? ` for ${absolute(status.scheduledAt)}` : ''}`
    : value === 'sending' ? 'Sending'
      : value === 'sent' ? `Sent ${absolute(message.created_at)}`
        : value === 'failed' ? 'Failed'
          : value === 'cancelled' ? 'Cancelled' : value

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]" aria-live="polite">
      <span className={value === 'failed' ? 'text-red-700' : 'text-slate-500'}>
        {label}
        {/* "Sent" means the mailbox provider accepted it — never that it landed. */}
        {value === 'sent' && <span className="sr-only"> — accepted by the mailbox provider at {absolute(message.created_at)}</span>}
      </span>
      {status.statusMessage && <span className="text-slate-500">{status.statusMessage}</span>}
      {value === 'queued' && onCancelled && (
        <button type="button" className="underline text-slate-600 cursor-pointer hover:text-red-700" onClick={() => onCancelled(message)}>
          Cancel this send
        </button>
      )}
    </div>
  )
}
