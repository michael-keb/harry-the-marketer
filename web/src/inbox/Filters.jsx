// The one filter bar, and the saved views that sit on top of it.
//
// SmartLead's ten inbox screens each carried their own filters. Here there is
// one set, shared by every state, and a saved view is nothing more than that
// set given a name — which is exactly what the backend stores, so a view and an
// ad-hoc filter set travel the same query path.
//
// Ceilings are enforced here, before a request leaves, with the reason stated:
// the API answers 5 campaigns / 20 mailboxes / 10 categories / 30 search
// characters with a 422, and finding that out by being refused is worse than
// being told while you choose.

import { useState } from 'react'
import { Confirm } from '../parity-ui.jsx'
import { Modal } from '../ui.jsx'
import { Banner, FieldError, Menu } from './common.jsx'

export const CEILINGS = { campaignId: 5, mailboxId: 20, categoryId: 10, search: 30 }

export const EMPTY_FILTERS = {
  search: '', sort: '', intent: '', assignee: '',
  campaignId: [], mailboxId: [], categoryId: [],
  unread: '', important: '', hasReminder: '',
  repliedFrom: '', repliedTo: '',
}

const SORTS_FOR = {
  scheduled: [['scheduled_asc', 'Soonest first'], ['scheduled_desc', 'Latest first']],
  sent: [['sent_desc', 'Newest sent'], ['sent_asc', 'Oldest sent']],
  default: [['reply_desc', 'Newest reply'], ['reply_asc', 'Oldest reply'], ['sent_desc', 'Newest sent'], ['sent_asc', 'Oldest sent']],
}

export const sortsFor = (state) => SORTS_FOR[state] || SORTS_FOR.default

export function activeFilterCount(filters) {
  let n = 0
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'sort') continue
    if (Array.isArray(value) ? value.length : value !== '') n += 1
  }
  return n
}

// ------------------------------------------------------------- saved views --

export function SavedViews({ views, error, activeId, onApply, onClear, onSave, onSaved, onDeleted, filters, state }) {
  const [naming, setNaming] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [deleting, setDeleting] = useState(null)

  // With no views at all, none of this appears — a workspace that has never
  // saved one never sees the machinery for them.
  const hasViews = views.length > 0
  const canSave = activeFilterCount(filters) > 0 || state !== 'active'
  if (!hasViews && !canSave) return null

  const active = views.find((v) => String(v.id) === String(activeId))

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasViews && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Saved views">
          {views.map((view) => {
            const on = String(view.id) === String(activeId)
            return (
              <li key={view.id} className="flex items-center">
                <button
                  type="button"
                  aria-current={on ? 'true' : undefined}
                  onClick={() => onApply(view)}
                  className={`rounded-l-full border px-3 py-1 text-xs cursor-pointer ${
                    on ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {view.name}
                  {view.is_broken && <span className="ml-1.5 text-amber-700">· Needs attention</span>}
                </button>
                <Menu
                  ariaLabel={`Options for view ${view.name}`}
                  label="⋯"
                  buttonClass={`rounded-r-full border border-l-0 px-2 py-1 text-xs cursor-pointer ${
                    on ? 'border-accent-500 text-accent-700' : 'border-slate-300 text-slate-600 hover:border-slate-300'
                  }`}
                  items={[
                    { key: 'apply', label: 'Open this view', onSelect: () => onApply(view) },
                    { key: 'rename', label: 'Rename', onSelect: () => setRenaming(view) },
                    { key: 'update', label: 'Save current filters into this view', onSelect: () => setNaming({ ...view, mode: 'update' }) },
                    { key: 'delete', label: 'Delete view', danger: true, onSelect: () => setDeleting(view) },
                  ]}
                />
              </li>
            )
          })}
        </ul>
      )}

      {active && (
        <span className="text-xs text-slate-600">
          Showing <span className="text-ink-900">{active.name}</span>
          <button type="button" className="ml-2 underline cursor-pointer hover:text-ink-900" onClick={onClear}>Clear view</button>
        </span>
      )}

      {canSave && (
        <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setNaming({ mode: 'create', name: '' })}>
          Save this view
        </button>
      )}

      {error && <Banner error={error} />}

      {naming && (
        <ViewDialog
          view={naming}
          filters={filters}
          state={state}
          onSave={onSave}
          onClose={() => setNaming(null)}
          onSaved={(saved) => { setNaming(null); onSaved(saved) }}
        />
      )}
      {renaming && (
        <ViewDialog
          view={{ ...renaming, mode: 'rename' }}
          filters={filters}
          state={state}
          onSave={onSave}
          onClose={() => setRenaming(null)}
          onSaved={(saved) => { setRenaming(null); onSaved(saved) }}
        />
      )}
      {deleting && (
        <Confirm
          title={`Delete the view “${deleting.name}”?`}
          body="The view disappears for everyone in this workspace. No conversation is changed, and nothing is deleted from the inbox — only the saved filter set goes."
          confirmLabel="Delete view"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => { await onDeleted(deleting); setDeleting(null) }}
        />
      )}
    </div>
  )
}

function ViewDialog({ view, filters, state, onSave, onClose, onSaved }) {
  const [name, setName] = useState(view.name || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const creating = view.mode === 'create'

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Only filters that are actually set are stored. An empty string would be
      // read back as `false` by the API's boolean parser, so "no opinion on
      // unread" would be saved as "read only" — a view that quietly lies.
      const stored = { state }
      for (const [key, value] of Object.entries(toQuery(filters))) {
        if (value === '' || value === undefined || value === null) continue
        if (Array.isArray(value) && value.length === 0) continue
        stored[key] = value
      }
      const payload = view.mode === 'rename' ? { name } : { name, filters: stored }
      onSaved(await onSave(view, payload, creating))
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Modal title={creating ? 'Save this view' : view.mode === 'rename' ? 'Rename view' : 'Update this view'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-sm text-slate-700" htmlFor="view-name">View name</label>
          <input
            id="view-name" className="input mt-1" value={name} maxLength={80} autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <FieldError error={error} field="name" />
        </div>
        <p className="text-xs text-slate-600">
          {view.mode === 'rename'
            ? 'Only the name changes. The saved filters stay as they are.'
            : 'The filters and sort you have set right now are stored under this name. Views are shared with everyone in the workspace.'}
        </p>
        <Banner error={error} handled={['name']} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save view'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------- filters ---

// The filter set as the API wants it. Arrays become repeated keys via qs().
export function toQuery(filters) {
  return {
    search: filters.search || '',
    sort: filters.sort || '',
    intent: filters.intent || '',
    assignee: filters.assignee || '',
    campaignId: filters.campaignId,
    mailboxId: filters.mailboxId,
    categoryId: filters.categoryId,
    unread: filters.unread,
    important: filters.important,
    hasReminder: filters.hasReminder,
    repliedFrom: filters.repliedFrom ? new Date(filters.repliedFrom).toISOString() : '',
    repliedTo: filters.repliedTo ? new Date(filters.repliedTo).toISOString() : '',
  }
}

export function FilterBar({ filters, onChange, refs, state, open, onToggle }) {
  const count = activeFilterCount(filters)
  const set = (patch) => onChange({ ...filters, ...patch })

  const toggleId = (field, id) => {
    const list = filters[field]
    const next = list.includes(id) ? list.filter((v) => v !== id) : [...list, id]
    if (next.length > CEILINGS[field]) return
    set({ [field]: next })
  }

  // The list is what the pane is for, so the chrome above it is one row: a
  // search box and a Filters button carrying the count of what is active.
  // Sort lives in the panel with everything else — it is not a thing anyone
  // changes twice a minute, and at 360px a second row of controls costs a whole
  // conversation off the bottom of the list.
  const nearLimit = filters.search.length >= CEILINGS.search - 10

  return (
    <section aria-label="Filters" className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search replies</span>
          <input
            type="search"
            className="input !py-1.5 text-xs"
            placeholder="Search replies…"
            value={filters.search}
            maxLength={CEILINGS.search}
            aria-describedby="search-limit"
            onChange={(e) => set({ search: e.target.value.slice(0, CEILINGS.search) })}
          />
        </label>
        <button
          type="button"
          className="btn-ghost shrink-0 !px-2.5 !py-1.5 text-xs"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? 'Hide' : 'Filters'}
          {count > 0 && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] text-slate-700">{count}</span>}
        </button>
        {count > 0 && (
          <button type="button" className="shrink-0 cursor-pointer text-xs text-slate-600 underline hover:text-ink-900" onClick={() => onChange({ ...EMPTY_FILTERS, sort: filters.sort })}>
            Clear
          </button>
        )}
      </div>

      {/* The ceiling is announced as it is approached rather than after a 422. */}
      <span id="search-limit" className={`block text-[11px] ${nearLimit ? 'text-amber-700' : 'sr-only'}`}>
        {filters.search.length}/{CEILINGS.search} characters
      </span>

      {/* One column, always: the panel lives inside the list pane now, which is
          360px wide at every breakpoint above the fold. */}
      {open && (
        <div className="card grid grid-cols-1 gap-3 p-3">
          <div>
            <label className="block text-xs text-slate-600" htmlFor="filter-sort">Sort</label>
            <select
              id="filter-sort"
              className="input mt-1"
              value={filters.sort || sortsFor(state)[0][0]}
              onChange={(e) => set({ sort: e.target.value })}
            >
              {sortsFor(state).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>

          <IdGroup
            legend="Campaign" field="campaignId" filters={filters} onToggle={toggleId}
            options={refs.campaigns.map((c) => ({ id: c.id, label: c.name, hint: c.status }))}
          />
          <IdGroup
            legend="Mailbox" field="mailboxId" filters={filters} onToggle={toggleId}
            options={refs.mailboxes.map((m) => ({ id: m.id, label: m.email, hint: m.status }))}
          />
          <IdGroup
            legend="Reply category" field="categoryId" filters={filters} onToggle={toggleId}
            options={refs.categories.map((c) => ({ id: c.id, label: c.name }))}
          />

          <div>
            <label className="block text-xs text-slate-600" htmlFor="filter-intent">Intent</label>
            <select id="filter-intent" className="input mt-1" value={filters.intent} onChange={(e) => set({ intent: e.target.value })}>
              <option value="">Any intent</option>
              {refs.intents.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>

          {!refs.solo && (
            <div>
              <label className="block text-xs text-slate-600" htmlFor="filter-assignee">Owner</label>
              <select id="filter-assignee" className="input mt-1" value={filters.assignee} onChange={(e) => set({ assignee: e.target.value })}>
                <option value="">All owners</option>
                <option value="me">Assigned to me</option>
                <option value="none">Unassigned</option>
                {refs.members.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                Assignment marks who is responsible. It does not restrict who can approve.
              </p>
            </div>
          )}

          <TriGroup legend="Read state" field="unread" filters={filters} onChange={set} yes="Unread only" no="Read only" />
          <TriGroup legend="Important" field="important" filters={filters} onChange={set} yes="Starred only" no="Not starred" />
          <TriGroup legend="Reminder" field="hasReminder" filters={filters} onChange={set} yes="Has a reminder" no="No reminder" />

          <div>
            <fieldset>
              <legend className="text-xs text-slate-600">Replied between</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                <label className="text-[11px] text-slate-500">
                  From
                  <input type="date" className="input mt-0.5" value={filters.repliedFrom} onChange={(e) => set({ repliedFrom: e.target.value })} />
                </label>
                <label className="text-[11px] text-slate-500">
                  To
                  <input type="date" className="input mt-0.5" value={filters.repliedTo} onChange={(e) => set({ repliedTo: e.target.value })} />
                </label>
              </div>
            </fieldset>
          </div>
        </div>
      )}
    </section>
  )
}

function IdGroup({ legend, field, filters, onToggle, options }) {
  const chosen = filters[field]
  const max = CEILINGS[field]
  const full = chosen.length >= max
  if (options.length === 0) {
    return (
      <fieldset>
        <legend className="text-xs text-slate-600">{legend}</legend>
        <p className="mt-1 text-[11px] text-slate-500">Nothing to filter by yet.</p>
      </fieldset>
    )
  }
  return (
    <fieldset>
      <legend className="text-xs text-slate-600">{legend}</legend>
      <div className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {options.map((option) => {
          const on = chosen.includes(option.id)
          return (
            <label key={option.id} className={`flex items-center gap-2 text-xs ${on ? 'text-ink-900' : 'text-slate-600'}`}>
              <input
                type="checkbox"
                className="accent-accent-500"
                checked={on}
                disabled={!on && full}
                onChange={() => onToggle(field, option.id)}
              />
              <span className="truncate">{option.label}</span>
              {option.hint && <span className="ml-auto shrink-0 text-[10px] text-slate-500">{option.hint}</span>}
            </label>
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {full
          ? `${max} is the most this filter accepts — clear one to pick another.`
          : `${chosen.length} of ${max} selected.`}
      </p>
    </fieldset>
  )
}

// Three states, spelled out. "Unread only" / "Read only" / "Either" is clearer
// than a checkbox that silently means three things.
function TriGroup({ legend, field, filters, onChange, yes, no }) {
  const value = filters[field]
  const name = `tri-${field}`
  return (
    <fieldset>
      <legend className="text-xs text-slate-600">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-3">
        {[['', 'Either'], ['true', yes], ['false', no]].map(([v, label]) => (
          <label key={v || 'any'} className="flex items-center gap-1.5 text-xs text-slate-700">
            <input
              type="radio" name={name} className="accent-accent-500"
              checked={value === v}
              onChange={() => onChange({ [field]: v })}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
