// Labelling several mailboxes at once.
//
// The server accepts 25 mailbox ids per request; the user is never told that.
// Batching is an implementation detail, so progress is reported as one figure
// across the whole selection, and a batch that fails leaves the ones that
// succeeded alone and offers a retry for exactly the rest.

import { useMemo, useState } from 'react'
import { api } from '../api.js'
import { LiveRegion, Modal, TagChip, TagPicker } from '../parity-ui.jsx'
import { TAG_BATCH, chunk, plural, useAnnounce } from './common.jsx'

async function runBatches(ids, tagIds, mode, onProgress) {
  const failed = []
  let done = 0
  let error = null
  for (const batch of chunk(ids, TAG_BATCH)) {
    const body = { appliesTo: 'mailbox', mailboxIds: batch, tagIds }
    try {
      if (mode === 'add') await api.post('/api/tags/assign', body)
      else await api.del('/api/tags/assign', body)
      done += batch.length
    } catch (err) {
      error = err
      failed.push(...batch)
    }
    onProgress(done)
  }
  return { done, failed, error }
}

export default function BulkLabels({ mode, rows, onClose, onDone }) {
  const ids = rows.map((r) => r.id)
  const [touched, setTouched] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [progress, setProgress] = useState(null)
  const [failure, setFailure] = useState(null)
  const [announcement, say] = useAnnounce()

  // The removal picker offers only labels actually present on the selection,
  // each with the count that carries it — asking to remove something that is
  // not there is not a thing a user should be able to do.
  const present = useMemo(() => {
    const map = new Map()
    for (const row of rows) {
      for (const tag of row.tags || []) {
        const found = map.get(tag.id) || { tag, count: 0 }
        found.count += 1
        map.set(tag.id, found)
      }
    }
    return [...map.values()].sort((a, b) => a.tag.name.localeCompare(b.tag.name))
  }, [rows])

  const apply = async (tag, targetIds, kind) => {
    setBusyId(tag.id)
    setFailure(null)
    setProgress({ tag: tag.name, done: 0, total: targetIds.length })
    const result = await runBatches(targetIds, [tag.id], kind, (done) => setProgress({ tag: tag.name, done, total: targetIds.length }))
    setBusyId(null)
    setProgress(null)
    if (result.failed.length) {
      setFailure({ tag, ids: result.failed, kind, done: result.done, message: result.error?.message || 'Some mailboxes could not be updated' })
      say(`${result.done} of ${targetIds.length} updated. ${result.failed.length} failed.`)
    } else {
      setTouched((t) => (kind === 'add' ? [...new Set([...t, tag.id])] : t.filter((id) => id !== tag.id)))
      say(`${tag.name} ${kind === 'add' ? 'added to' : 'removed from'} ${plural(result.done, 'mailbox', 'mailboxes')}`)
    }
    onDone?.()
  }

  const createTag = async (name) => {
    try {
      const res = await api.post('/api/tags', { appliesTo: 'mailbox', name })
      await apply(res.data, ids, 'add')
    } catch (err) {
      if (err.status === 409 && err.payload?.id) {
        say(`“${name}” already exists — applying that one`)
        await apply({ id: err.payload.id, name }, ids, 'add')
        return
      }
      setFailure({ message: err.message, ids: [], kind: 'add' })
    }
  }

  return (
    <Modal
      title={mode === 'add' ? `Add labels to ${plural(ids.length, 'mailbox', 'mailboxes')}` : `Remove labels from ${plural(ids.length, 'mailbox', 'mailboxes')}`}
      onClose={onClose}
    >
      <LiveRegion message={announcement} />

      <p className="mb-3 text-xs text-slate-600">
        {mode === 'add'
          ? 'Labels group a fleet so a filter can find it again. The selection stays after applying, so you can add a second label without reselecting.'
          : `Remove from ${plural(ids.length, 'mailbox', 'mailboxes')} — the label itself is kept. Deleting a label entirely is a different action, in Manage labels.`}
      </p>

      {mode === 'add' ? (
        <TagPicker
          appliesTo="mailbox"
          selected={touched}
          busyId={busyId}
          onToggle={(tag, on) => apply(tag, ids, on ? 'add' : 'remove')}
          onCreate={createTag}
        />
      ) : present.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          Nothing to remove — none of the selected mailboxes carries a label.
        </p>
      ) : (
        <ul className="space-y-1">
          {present.map(({ tag, count }) => (
            <li key={tag.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-100">
              <span className="flex items-center gap-2">
                <TagChip tag={tag} />
                <span className="text-[11px] text-slate-500">on {plural(count, 'mailbox', 'mailboxes')}</span>
              </span>
              <button
                type="button"
                className="btn-ghost text-xs cursor-pointer"
                disabled={busyId === tag.id}
                aria-label={`Remove label ${tag.name} from ${count} selected mailboxes`}
                onClick={() => apply(tag, rows.filter((r) => (r.tags || []).some((t) => t.id === tag.id)).map((r) => r.id), 'remove')}
              >
                {busyId === tag.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <p className="mt-3 text-xs text-slate-600" role="status">
          {progress.tag}: {progress.done} of {progress.total} mailboxes…
        </p>
      )}

      {failure && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p>{failure.message}</p>
          {failure.ids.length > 0 && (
            <p className="mt-1">
              {failure.done ?? 0} updated, {failure.ids.length} left.{' '}
              <button
                type="button"
                className="underline cursor-pointer"
                onClick={() => apply(failure.tag, failure.ids, failure.kind)}
              >
                Retry the {failure.ids.length} that failed
              </button>
            </p>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <button className="btn-ghost cursor-pointer" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}
