// Lead notes — Docs/lead-notes/*.
//
// The one place in Harry where a human writes about a lead. The research
// profile above it is the agent's work and the activity trail beside it is a
// log; this panel is neither, and it has to look like neither — hence the
// accent rail, the author avatar and the standing line that a note is internal.
//
// Notes are grouped by campaign because a promise made in one campaign is not
// context for another; campaign-less notes are "General".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, useToast } from '../ui.jsx'
import { Confirm, LiveRegion } from '../parity-ui.jsx'
import { FieldError, FormError, Panel, initials, when } from './shared.jsx'

const PAGE = 10

export default function NotesPanel({ leadId }) {
  const toast = useToast()
  const [items, setItems] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState(null)
  const [maxLength, setMaxLength] = useState(4000)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [live, setLive] = useState('')
  const [deleting, setDeleting] = useState(null)

  const fetchPage = useCallback(async (before) => {
    const res = await api.get(`/api/leads/${leadId}/notes${qs({ limit: PAGE, before: before || undefined })}`)
    return res
  }, [leadId])

  const load = useCallback(async () => {
    setError(null)
    setItems(null)
    try {
      const res = await fetchPage(null)
      setItems(res.items || [])
      setHasMore(Boolean(res.hasMore))
      setCursor(res.nextCursor ?? null)
      if (res.maxLength) setMaxLength(res.maxLength)
    } catch (err) { setError(err) }
  }, [fetchPage])

  useEffect(() => { load() }, [load])

  const more = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const res = await fetchPage(cursor)
      setItems((list) => [...(list || []), ...(res.items || [])])
      setHasMore(Boolean(res.hasMore))
      setCursor(res.nextCursor ?? null)
    } catch (err) { toast(err.message, 'error') } finally { setLoadingMore(false) }
  }

  const groups = useMemo(() => {
    const out = new Map()
    for (const note of items || []) {
      const key = note.campaign ? `c${note.campaign.id}` : 'general'
      const label = note.campaign ? note.campaign.name || `Campaign #${note.campaign.id}` : 'General'
      if (!out.has(key)) out.set(key, { key, label, notes: [] })
      out.get(key).notes.push(note)
    }
    return [...out.values()]
  }, [items])

  const removeNote = async (note) => {
    const before = items
    setItems((list) => list.filter((n) => n.id !== note.id))
    setDeleting(null)
    try {
      await api.del(`/api/notes/${note.id}`)
      setLive('Note deleted')
    } catch (err) {
      setItems(before)
      toast(err.message, 'error')
    }
  }

  return (
    <Panel
      title="Notes"
      tone="human"
      hint="Written by people in this workspace. Nothing here is sent to the prospect and the agent never reads it."
    >
      <LiveRegion message={live} />

      <Composer
        leadId={leadId}
        maxLength={maxLength}
        onSaved={(note) => {
          setItems((list) => [note, ...(list || [])])
          setLive('Note added')
        }}
      />

      <div className="mt-4">
        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : items === null ? (
          <Spinner label="Loading notes…" />
        ) : items.length === 0 ? (
          <EmptyState title="No notes yet" hint="Write what the email thread cannot say — what was promised on a call, who else is involved, why they went quiet." />
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.key}>
                <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">{group.label}</h4>
                <ul className="space-y-2">
                  {group.notes.map((note) => (
                    <li key={note.id}>
                      <Note
                        note={note}
                        maxLength={maxLength}
                        onEdited={(updated) => setItems((list) => list.map((n) => (n.id === updated.id ? updated : n)))}
                        onDelete={() => setDeleting(note)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {hasMore && (
              <div className="flex justify-center pt-1">
                <button type="button" className="btn-ghost" onClick={more} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load older notes'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {deleting && (
        <Confirm
          title="Delete this note?"
          body="It disappears from this panel for everyone in the workspace. The record itself is kept, so the activity trail still shows that a note was written and by whom."
          confirmLabel="Delete note"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => removeNote(deleting)}
        />
      )}
    </Panel>
  )
}

function Composer({ leadId, maxLength, onSaved }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const keyRef = useRef(null)

  const submit = async (e) => {
    e.preventDefault()
    const text = body.trim()
    if (!text) { setError({ payload: { field: 'body' }, message: 'Write something before saving.' }); return }
    setBusy(true)
    setError(null)
    // A retry after a timeout must not post the note twice; the key survives
    // until a save succeeds.
    if (!keyRef.current) keyRef.current = `note-${leadId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const res = await api.post(`/api/leads/${leadId}/notes`, { body: text, idempotencyKey: keyRef.current })
      // The typed text is only cleared once the server has it.
      setBody('')
      keyRef.current = null
      onSaved(res.note)
    } catch (err) {
      setError(err)
    } finally { setBusy(false) }
  }

  const remaining = maxLength - body.length

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-xs text-slate-600" htmlFor="note-body">Add an internal note</label>
      <textarea
        id="note-body"
        className="input min-h-20"
        maxLength={maxLength}
        value={body}
        onChange={(e) => { setBody(e.target.value); setError(null) }}
        placeholder="Called Priya — she wants pricing for 50 seats before the end of the month."
        aria-describedby="note-counter"
      />
      <div className="flex items-center justify-between gap-3">
        <span id="note-counter" aria-live="polite" className="text-[11px] text-slate-500">
          {remaining.toLocaleString()} character{remaining === 1 ? '' : 's'} left
        </span>
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save note'}</button>
      </div>
      <FieldError err={error} field="body" />
      <FormError err={error} fields={['body']} />
    </form>
  )
}

function Note({ note, maxLength, onEdited, onDelete }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.patch(`/api/notes/${note.id}`, { body: draft })
      onEdited(res.note)
      setEditing(false)
    } catch (err) {
      setError(err)
      if (err?.status === 403) toast(err.message, 'error')
    } finally { setBusy(false) }
  }

  const author = note.author || {}

  return (
    <article className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2.5">
      <header className="flex flex-wrap items-center gap-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-[10px] font-semibold text-accent-700"
          aria-hidden
        >
          {initials(author.name, author.email)}
        </span>
        <span className="text-xs font-medium text-ink-900">{author.name || author.email || 'Unknown author'}</span>
        {author.formerMember && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">former member</span>
        )}
        <span className="text-[11px] text-slate-500">{when(note.createdAt)}</span>
        {note.edited && <span className="text-[11px] text-slate-500">· edited</span>}
        {note.mine && !editing && (
          <span className="ml-auto flex gap-2">
            <button type="button" className="cursor-pointer text-[11px] text-slate-600 hover:text-accent-700" onClick={() => { setDraft(note.body); setEditing(true) }}>
              Edit
            </button>
            <button type="button" className="cursor-pointer text-[11px] text-slate-600 hover:text-red-600" onClick={onDelete}>
              Delete
            </button>
          </span>
        )}
      </header>
      {editing ? (
        <form onSubmit={save} className="mt-2 space-y-2">
          <label className="sr-only" htmlFor={`note-edit-${note.id}`}>Edit note</label>
          <textarea
            id={`note-edit-${note.id}`}
            className="input min-h-20"
            maxLength={maxLength}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <FieldError err={error} field="body" />
          <FormError err={error} fields={['body']} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
            <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">{note.body}</p>
      )}
    </article>
  )
}
