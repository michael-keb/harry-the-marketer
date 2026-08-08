// Folder management: create, view, delete.
//
// Filing is reversible and deleting a folder never deletes a test — so the
// refusal a non-empty folder returns is shown in full, and the way past it is
// an explicit second decision rather than a flag hidden in the first dialog.

import { useState } from 'react'
import { api } from '../api.js'
import { Confirm, Modal, Spinner, ErrorState, useToast } from '../parity-ui.jsx'
import { FieldNote, localTime } from './delivery-kit.jsx'

export default function DeliverabilityFolders({ folders, loading, error, onReload, onClose, announce, onSelect }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState(null)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [refusal, setRefusal] = useState(null)
  const [rowError, setRowError] = useState(null)

  async function create(e) {
    e.preventDefault()
    const value = name.trim()
    if (!value) { setCreateErr('Give the folder a name.'); return }
    // Caught here rather than after a round trip, and the typed name is kept.
    if ((folders || []).some((f) => f.name.trim().toLowerCase() === value.toLowerCase())) {
      setCreateErr(`A folder named "${value}" already exists — file the test there instead of creating a second one.`)
      return
    }
    setCreating(true)
    setCreateErr(null)
    try {
      const created = await api.post('/api/deliverability/folders', { name: value })
      setName('')
      await onReload()
      announce?.(`Folder "${created.name}" created.`)
      toast?.(`Folder "${created.name}" created`)
      onSelect?.(String(created.id))
    } catch (err) {
      setCreateErr(err.payload?.field === 'name' ? err.payload.message : err.message)
    } finally {
      setCreating(false)
    }
  }

  async function remove(folder, unfile) {
    setRowError(null)
    try {
      const res = await api.del(`/api/deliverability/folders/${folder.id}${unfile ? '?unfile=1' : ''}`)
      setConfirmTarget(null)
      setRefusal(null)
      await onReload()
      announce?.(res.message || 'Folder deleted.')
      toast?.(res.message || 'Folder deleted.')
      onSelect?.('')
    } catch (err) {
      setConfirmTarget(null)
      if (err.status === 409 && err.payload?.error === 'folder_not_empty') {
        setRefusal({ folder, message: err.payload.message, testCount: err.payload.testCount })
      } else {
        setRowError(err.message)
      }
    }
  }

  return (
    <Modal title="Deliverability folders" onClose={onClose}>
      {/* An inline single-field form — one field, one button, Escape cancels. */}
      <form onSubmit={create} className="mb-4">
        <label className="block text-sm">
          <span className="text-slate-600">New folder name</span>
          <div className="mt-1 flex gap-2">
            <input
              className="input" value={name} maxLength={120}
              onChange={(e) => { setName(e.target.value); setCreateErr(null) }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setName(''); setCreateErr(null) } }}
              aria-invalid={Boolean(createErr)}
            />
            <button type="submit" className="btn-primary shrink-0 cursor-pointer" disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </label>
        <FieldNote error={createErr} />
      </form>

      {rowError && <p className="mb-3 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700" role="alert">{rowError}</p>}

      {refusal && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          <p>{refusal.message}</p>
          <p className="mt-1 text-xs text-amber-700">
            Deleting the folder keeps all {refusal.testCount} test{refusal.testCount === 1 ? '' : 's'} and everything they have recorded — they are simply no longer filed anywhere.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="btn-ghost cursor-pointer" onClick={() => setRefusal(null)}>Keep the folder</button>
            <button className="btn-danger cursor-pointer" onClick={() => remove(refusal.folder, true)}>
              Unfile {refusal.testCount} test{refusal.testCount === 1 ? '' : 's'} and delete “{refusal.folder.name}”
            </button>
          </div>
        </div>
      )}

      {loading && !folders && <Spinner label="Loading folders…" />}
      {error && <ErrorState error={error} onRetry={onReload} />}

      {folders && folders.length === 0 && (
        <p className="text-sm text-slate-500">No folders yet. Create one above to group placement tests.</p>
      )}

      {folders && folders.length > 0 && (
        <ul className="divide-y divide-slate-200">
          {folders.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <button
                  type="button"
                  className="cursor-pointer truncate text-sm text-ink-900 hover:text-accent-700"
                  onClick={() => { onSelect?.(String(f.id)); onClose() }}
                >
                  {f.name}
                </button>
                <div className="text-[11px] text-slate-500">
                  {f.testCount} test{f.testCount === 1 ? '' : 's'} · created {localTime(f.createdAt) || 'date not recorded'}
                </div>
              </div>
              <button
                className="btn-danger shrink-0 cursor-pointer"
                onClick={() => { setRefusal(null); setConfirmTarget(f) }}
              >
                Delete folder {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirmTarget && (
        <Confirm
          title={`Delete the folder "${confirmTarget.name}"?`}
          body={
            confirmTarget.testCount > 0
              ? `"${confirmTarget.name}" holds ${confirmTarget.testCount} test${confirmTarget.testCount === 1 ? '' : 's'}. Deleting a folder never deletes a test — every test and every result it recorded is kept. A folder that still holds tests will refuse this first attempt and tell you so.`
              : `"${confirmTarget.name}" is empty. Deleting it removes only the folder; no test or result is touched.`
          }
          confirmLabel="Delete folder"
          danger
          onConfirm={() => remove(confirmTarget, false)}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </Modal>
  )
}
