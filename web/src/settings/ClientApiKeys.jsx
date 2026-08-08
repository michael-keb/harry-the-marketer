// Client API keys — Docs/clients/api-keys.md §4.
//
// One rule shapes every line of this file: the plaintext key exists only in the
// response that mints it. `server/parity/clients.js` stores a prefix and a
// SHA-256 hash and has no route that returns a value, so the create and reset
// result screens are the only places a secret is ever rendered. They say so, in
// those words, and they are a modal rather than a row so the value cannot
// scroll away while someone is reading it.
//
// The other rule the spec is firm about: revoking is not deleting. The row
// stays, because "which key was that?" needs an answer after the key stops
// working.

import { useMemo, useState } from 'react'
import { api } from '../api.js'
import {
  Confirm, Modal, Spinner, EmptyState, ErrorState, LoadMore, LiveRegion, useToast,
} from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'
import { CopyField, Field, StatusPill, describedBy, errFor, usePaged, useFieldErrors } from './common.jsx'

const SCOPES = [
  { value: 'read', label: 'Read only', hint: 'Can list and read. Cannot change anything.' },
  { value: 'write', label: 'Read and write', hint: 'Can also create, update and delete on this client’s behalf.' },
]

export default function ClientApiKeys({ client }) {
  const toast = useToast()
  const [status, setStatus] = useState('active')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [minted, setMinted] = useState(null)      // { key, notice, reset }
  const [confirming, setConfirming] = useState(null) // { kind, key }
  const [busyId, setBusyId] = useState(null)
  const [said, setSaid] = useState('')

  const params = useMemo(
    () => ({ status, key_name: search.trim() || undefined, limit: 25 }),
    [status, search],
  )
  const list = usePaged(`/api/clients/${client.id}/api-keys`, params)

  // Filters earn their place only once there are more keys than a person can
  // see at a glance (api-keys.md §4: "only when there are more than a handful").
  const showFilters = list.items.length > 5 || status !== 'active' || search.trim() !== ''

  const revoke = async (key) => {
    setBusyId(key.id)
    try {
      await api.del(`/api/api-keys/${key.id}`)
      setSaid(`Key ${key.key_name} revoked. It stops working immediately; the record stays.`)
      toast(`“${key.key_name}” revoked`)
      list.reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
      setConfirming(null)
    }
  }

  const reset = async (key) => {
    setBusyId(key.id)
    try {
      const res = await api.post(`/api/api-keys/${key.id}/reset`)
      setMinted({ key: res.data, notice: res.notice, reset: true })
      setSaid(`Key ${key.key_name} reset. The new value is shown once.`)
      list.reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
      setConfirming(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">API keys</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Programmatic access scoped to {client.name}. A key’s value is shown once, when it is created — Harry
            keeps only a hash, so there is no route that could show it again.
          </p>
        </div>
        <button type="button" className="btn-ghost shrink-0" onClick={() => setCreating(true)}>
          New key
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-2">
          <div>
            <label className="sr-only" htmlFor={`key-status-${client.id}`}>Filter keys by status</label>
            <select
              id={`key-status-${client.id}`}
              className="input w-auto"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="active">Active</option>
              <option value="revoked">Revoked</option>
              <option value="all">All</option>
            </select>
          </div>
          <div className="min-w-40 flex-1">
            <label className="sr-only" htmlFor={`key-search-${client.id}`}>Search keys by name</label>
            <input
              id={`key-search-${client.id}`}
              className="input"
              type="search"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && list.items.length === 0 ? (
        <Spinner label="Loading API keys…" />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon="settings"
          title="No API keys for this client yet"
          hint="Create one to give this brand’s engineer access to their own campaigns, leads and mailboxes — and nothing else."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <caption className="sr-only">API keys for {client.name}</caption>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                <th scope="col" className="py-2 pr-3 font-medium">Prefix</th>
                <th scope="col" className="py-2 pr-3 font-medium">Scope</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 pr-3 font-medium">Last used</th>
                <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {list.items.map((key) => (
                <tr key={key.id} className="align-top">
                  <td className="py-2.5 pr-3 text-ink-900">
                    {key.key_name}
                    <div className="text-[11px] text-slate-500">added {timeAgo(key.created_at)}</div>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[12px] text-slate-600">{key.key_prefix}</td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    {key.scope === 'write' ? 'Read and write' : 'Read only'}
                  </td>
                  <td className="py-2.5 pr-3">
                    <StatusPill tone={key.status === 'active' ? 'good' : 'neutral'}>
                      {key.status === 'active' ? 'Active' : 'Revoked'}
                    </StatusPill>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    {key.never_used ? (
                      <span>Never used</span>
                    ) : (
                      <span>{timeAgo(key.last_used_at)}</span>
                    )}
                    {key.stale && (
                      <div className="text-[11px] text-amber-700">unused for 90 days or more</div>
                    )}
                  </td>
                  <td className="py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={busyId === key.id}
                        className="cursor-pointer text-xs text-slate-600 hover:text-accent-700 disabled:opacity-40"
                        onClick={() => setConfirming({ kind: 'reset', key })}
                      >
                        Reset
                      </button>
                      {key.status === 'active' && (
                        <button
                          type="button"
                          disabled={busyId === key.id}
                          className="cursor-pointer text-xs text-slate-600 hover:text-red-600 disabled:opacity-40"
                          onClick={() => setConfirming({ kind: 'revoke', key })}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
      <LiveRegion message={said} />

      {creating && (
        <NewKeyDialog
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false)
            setMinted({ key: res.data, notice: res.notice, reset: false })
            setSaid(`Key ${res.data.key_name} created. The value is shown once.`)
            list.reload()
          }}
        />
      )}

      {minted && (
        <SecretOnce
          minted={minted}
          onClose={() => { setMinted(null); setSaid('') }}
        />
      )}

      {confirming?.kind === 'revoke' && (
        <Confirm
          title={`Revoke “${confirming.key.key_name}”?`}
          body={`Anything using this key stops working on its next request. The key is not deleted — the record stays, showing ${confirming.key.key_prefix} and when it was last used, so you can still answer "which key was that?".`}
          confirmLabel="Revoke key"
          danger
          onConfirm={() => revoke(confirming.key)}
          onClose={() => setConfirming(null)}
        />
      )}

      {confirming?.kind === 'reset' && (
        <Confirm
          title={`Reset “${confirming.key.key_name}”?`}
          body="The current value stops working immediately and a new one is shown once. Same key, same name, same permissions — only the secret changes. Anything still using the old value will start getting 401s."
          confirmLabel="Reset key"
          danger
          onConfirm={() => reset(confirming.key)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

// ---- the create dialog ------------------------------------------------------

function NewKeyDialog({ client, onClose, onCreated }) {
  const toast = useToast()
  const { errors, capture, clear } = useFieldErrors()
  const [name, setName] = useState('')
  const [scope, setScope] = useState('read')
  const [busy, setBusy] = useState(false)

  const nameError = errFor(errors, 'key_name', 'keyName')
  const scopeError = errFor(errors, 'scope')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    clear()
    try {
      const res = await api.post(`/api/clients/${client.id}/api-keys`, { key_name: name.trim(), scope })
      onCreated(res)
    } catch (err) {
      if (!capture(err)) toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={`New API key for ${client.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          id="new-key-name"
          label="What is this key for?"
          hint="Letters, numbers, spaces, hyphens and underscores. It is how you will recognise it later — “Acme production sync”, not “key 2”."
          error={nameError}
        >
          <input
            id="new-key-name"
            className="input"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...describedBy('new-key-name', { hint: true, error: nameError })}
          />
        </Field>

        <fieldset>
          <legend className="text-sm text-slate-700">What may it do?</legend>
          <div className="mt-2 space-y-2">
            {SCOPES.map((s) => (
              <label key={s.value} className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-700">
                <input
                  type="radio"
                  name="key-scope"
                  className="mt-1 cursor-pointer accent-accent-500"
                  checked={scope === s.value}
                  onChange={() => setScope(s.value)}
                />
                <span>
                  {s.label}
                  <span className="block text-xs text-slate-500">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {scopeError && <p className="mt-1 text-xs text-red-700">{scopeError}</p>}
        </fieldset>

        <p className="text-xs text-slate-500">
          The value appears once on the next screen and is never recoverable. Harry stores a hash of it, not the key.
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---- the one-time reveal ----------------------------------------------------

function SecretOnce({ minted, onClose }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const key = minted.key

  return (
    <Modal title={minted.reset ? 'New key value' : 'Your new API key'} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800" role="alert">
          <div className="font-medium">This is the only time this value is shown.</div>
          <p className="mt-0.5 text-amber-700">
            Harry stores a hash of it, not the key itself. Close this dialog without copying it and the only way
            back is a reset, which invalidates it again.
            {minted.reset && ' The previous value stopped working the moment this one was created.'}
          </p>
        </div>

        <CopyField
          id="minted-api-key"
          value={key.api_key}
          label={`API key value for ${key.key_name}`}
        />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-700">{key.key_name}</dd>
          <dt className="text-slate-500">Prefix</dt>
          <dd className="font-mono text-slate-700">{key.key_prefix}</dd>
          <dt className="text-slate-500">Scope</dt>
          <dd className="text-slate-700">{key.scope === 'write' ? 'Read and write' : 'Read only'}</dd>
        </dl>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5 cursor-pointer accent-accent-500"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I have stored this value somewhere safe.
        </label>

        <div className="flex justify-end">
          <button type="button" className="btn-primary" disabled={!acknowledged} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}
