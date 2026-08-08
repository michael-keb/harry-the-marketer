// Find prospects — the two-pane search-and-preview that lives inside Leads.
//
// This is one of only three endpoints in the whole parity backlog that needed a
// genuinely new surface, and it is a PANEL inside Leads rather than a navigation
// item. Three rules shape everything below:
//
//   1. No provider concept ever reaches this file. There is no `scroll_id`, no
//      `filter_id`, no `provider_filter_id` and no API key. A page token is the
//      opaque `cursor` the server minted; every id in a URL here is a row in
//      Harry's own tables. If a response ever carried a provider id, that would
//      be a server bug to report rather than a field to read.
//   2. A credit failure is an HTTP 200 with `success: false`. It is rendered as
//      a first-class outcome that says what happened and what it would have
//      cost — never as a red "something went wrong".
//   3. Not connected is the normal case. With no provider configured every
//      route still answers, and saved searches, past fetches and stored
//      contacts all still read from Harry's own tables. The whole surface stays
//      usable and legible in that state.
//
// The server owns every ceiling (preview limit 1–500, arrays ≤2000, pasted
// lists ≤1000, names ≤255) and answers a breach with `{ field, message }`. Each
// one is also shown here BEFORE the server has to say no, and a 422 that does
// arrive is rendered against the control it names.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import {
  NotConnected, LiveRegion, LoadMore, Tabs, Stat, Drawer,
  Spinner, EmptyState, ErrorState, Modal, useToast,
} from '../parity-ui.jsx'

// ---- ceilings, mirrored from server/parity/prospects.js ----------------------
// Duplicated deliberately: the server is the guarantee, these are the courtesy.
const MAX_ARRAY = 2000          // per-criteria array maximum
const ARRAY_WARN = 1600         // warn well before the ceiling, never at it
const MAX_RECONCILE = 1000      // paste-a-list flows
const MAX_PREVIEW_LIMIT = 500   // search-contacts limit
const MAX_SAVE_LIMIT = 10000    // save-search limit
const MAX_FETCH_COUNT = 10000   // fetch-contacts count
const MAX_NAME = 255            // both rename endpoints
const VOCAB_PAGE = 100          // documented lookup maximum
const DEBOUNCE_MS = 300         // one request per 300ms of quiet
const PREVIEW_DEBOUNCE_MS = 500 // the preview costs more, so it waits longer

const ENV_VARS = ['PROSPECT_API_URL', 'PROSPECT_API_KEY']

const VERIFICATION_STATUSES = [
  { key: 'valid', label: 'Valid' },
  { key: 'catch_all', label: 'Catch-all' },
  { key: 'invalid', label: 'Invalid' },
]
const CATCH_ALL_STATUSES = [
  { key: 'catch_all_verified', label: 'Catch-all, verified' },
  { key: 'catch_all_soft_bounced', label: 'Catch-all, soft bounced' },
  { key: 'catch_all_hard_bounced', label: 'Catch-all, hard bounced' },
  { key: 'catch_all_unknown', label: 'Catch-all, unknown' },
  { key: 'catch_all_bounced', label: 'Catch-all, bounced' },
]

// ---- the filter set ----------------------------------------------------------
//
// Every key here is a key of the server's SEARCH_MAP. Chips are held as
// `{ key, label, id?, free? }` so a picker can show a readable name while the
// body carries the value the provider documents; `filters` is derived from them.
//
// `title`, `companyNames` and `companyDomains` are the provider's non-directional
// twins of the include/exclude fields below. Offering both would put two controls
// on screen that mean almost the same thing, so the directional pair is the one
// with a control. Nothing is sent for the other three.

const ARRAY_FIELDS = [
  'includeTitles', 'excludeTitles',
  'includeCompanies', 'excludeCompanies',
  'includeCompanyDomains', 'excludeCompanyDomains',
  'companyKeywords',
  'fullName', 'firstName', 'lastName',
  'departmentIds', 'levelIds', 'headCountIds', 'revenueIds',
  'industryIds', 'subIndustries',
  'countries', 'states', 'cities',
]
const BOOL_FIELDS = [
  'exactTitleMatch', 'exactCompanyMatch', 'exactCompanyDomainMatch', 'hideOwnedContacts',
]

function emptySelection() {
  const out = {}
  for (const f of ARRAY_FIELDS) out[f] = []
  for (const f of BOOL_FIELDS) out[f] = false
  return out
}

// Which control a 422's `field` belongs to. The server may name a pair
// ("includeTitles,excludeTitles"), so both halves point at the same control.
const FIELD_GROUP = {
  includeTitles: 'titles', excludeTitles: 'titles', exactTitleMatch: 'titles',
  includeCompanies: 'companies', excludeCompanies: 'companies', exactCompanyMatch: 'companies',
  includeCompanyDomains: 'domains', excludeCompanyDomains: 'domains',
  exactCompanyDomainMatch: 'domains', domains: 'domains',
  companyKeywords: 'keywords',
  fullName: 'names', firstName: 'names', lastName: 'names',
  departmentIds: 'departments', levelIds: 'levels',
  headCountIds: 'headCounts', revenueIds: 'revenue',
  industryIds: 'industries', subIndustries: 'subIndustries',
  countries: 'countries', states: 'states', cities: 'cities',
  limit: 'limit', count: 'count', name: 'name', adaptIds: 'count',
  'count,adaptIds': 'count', 'filterId,adaptIds': 'count',
}

function groupFor(field) {
  if (!field) return null
  if (FIELD_GROUP[field]) return FIELD_GROUP[field]
  for (const part of String(field).split(',')) {
    if (FIELD_GROUP[part.trim()]) return FIELD_GROUP[part.trim()]
  }
  return null
}

// A 422 from the parity modules carries `{ error, field, message }`. Anything
// else is an ordinary failure and keeps its own message.
function fieldFault(err) {
  const payload = err?.payload
  if (!payload?.field) return null
  return { field: String(payload.field), message: String(payload.message || err.message) }
}

// ---- small helpers -----------------------------------------------------------

function uniqueChips(list) {
  const seen = new Set()
  const out = []
  for (const chip of list) {
    const key = String(chip.key)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(chip)
  }
  return out
}

// Lowercase, drop the protocol, drop `www.`, drop the path and any trailing dot
// or slash. The same rule the server applies, run here first so a user can SEE
// what their paste turned into before anything is checked against the provider.
function normaliseDomain(raw) {
  let v = String(raw || '').trim().toLowerCase()
  if (!v) return ''
  v = v.replace(/^[a-z]+:\/\//, '')
  v = v.split('/')[0].split('?')[0]
  v = v.replace(/^www\./, '')
  v = v.replace(/\.$/, '')
  return v
}

// A count nobody can act on is not a fact worth stating precisely. Under the
// threshold the exact number is shown; above it the number is scaled and said
// to be approximate, because "16,482,913 people match" invites nobody to narrow.
function scaledCount(n) {
  const value = Number(n || 0)
  if (!Number.isFinite(value)) return '0'
  if (value < 100000) return value.toLocaleString()
  if (value < 1000000) return `about ${Math.round(value / 1000).toLocaleString()} thousand`
  const millions = value / 1000000
  return `about ${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')} million`
}

// Deliverability arrives as a number. It is read out in words: a coloured bar
// would make the same claim while being unreadable to half the people using it.
function deliverabilityWords(score) {
  if (score === null || score === undefined) return 'not scored'
  const n = Number(score)
  if (!Number.isFinite(n)) return 'not scored'
  const pct = n > 1 ? n / 100 : n
  if (pct >= 0.9) return 'very likely to deliver'
  if (pct >= 0.7) return 'likely to deliver'
  if (pct >= 0.4) return 'uncertain'
  return 'unlikely to deliver'
}

function humanKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function exactDate(value) {
  if (!value) return ''
  const stamp = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? String(value) : at.toLocaleString()
}

function shortDate(value) {
  if (!value) return ''
  const stamp = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`
  const at = new Date(stamp)
  if (Number.isNaN(at.getTime())) return String(value)
  return at.toLocaleDateString([], { day: 'numeric', month: 'long' })
}

// The status shape `NotConnected` wants. The server's `unconfigured()` names the
// variables in its sentence rather than in a field, so they are supplied here.
function connectionStatus(res) {
  if (!res) return null
  return { configured: res.configured !== false, envVars: res.envVars || ENV_VARS, message: res.message }
}

// ---- generic pieces ----------------------------------------------------------

function FieldError({ fault }) {
  if (!fault) return null
  return (
    <p className="mt-1 text-xs text-red-700" role="alert">{fault.message}</p>
  )
}

function Chip({ chip, onRemove }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-ink-900">
      <span className="truncate">{chip.label}</span>
      {chip.free && <span className="shrink-0 text-[10px] text-amber-700">as typed</span>}
      {chip.note && <span className="shrink-0 text-[10px] text-amber-700">{chip.note}</span>}
      <button
        type="button"
        onClick={() => onRemove(chip)}
        aria-label={`Remove ${chip.label}`}
        className="ml-0.5 shrink-0 cursor-pointer text-slate-500 hover:text-red-600"
      >
        ×
      </button>
    </span>
  )
}

// A real combobox over a real listbox: `aria-expanded`, `aria-activedescendant`,
// arrow keys, Enter to toggle, Escape to close, Backspace to drop the last chip.
// Under 640px the popup is a bottom sheet rather than a dropdown, because a
// 200px-tall list floating over a phone screen is unusable.
//
// `load(query, offset)` returns `{ items, hasMore }`. It is read through a ref so
// a caller may rebuild the function every render without restarting the request
// loop; `reloadKey` is how a caller says a dependency genuinely changed.
function Combobox({
  label, hint, placeholder = 'Type to search…', chips = [], onChange, load,
  allowFree = false, emptyText = 'No matches', keepTypedLabel = 'Keep as typed',
  disabled = false, disabledReason = '', fault = null, reloadKey = '',
  footer = null, warnAt = ARRAY_WARN, max = MAX_ARRAY,
}) {
  const uid = useId()
  const listId = `${uid}-listbox`
  const hintId = `${uid}-hint`
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [active, setActive] = useState(-1)
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const run = useCallback(async (q, offset, append) => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await loadRef.current(q, offset)
      if (seq.current !== mine) return   // a later keystroke already won
      setItems((prev) => (append ? [...prev, ...(res.items || [])] : (res.items || [])))
      setHasMore(Boolean(res.hasMore))
    } catch (err) {
      if (seq.current !== mine) return
      setError(err)
    } finally {
      if (seq.current === mine) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || disabled) return undefined
    const t = setTimeout(() => run(query.trim(), 0, false), query.trim() ? DEBOUNCE_MS : 0)
    return () => clearTimeout(t)
  }, [open, query, disabled, reloadKey, run])

  const selected = useMemo(() => new Set(chips.map((c) => String(c.key))), [chips])

  const add = (chip) => {
    if (chips.length >= max) return
    onChange(uniqueChips([...chips, chip]))
  }
  const remove = (chip) => onChange(chips.filter((c) => String(c.key) !== String(chip.key)))
  const toggle = (option) => {
    if (selected.has(String(option.key))) remove(option)
    else add(option)
  }

  const typed = query.trim()
  const exactShown = items.some((i) => String(i.label).toLowerCase() === typed.toLowerCase())
  const rows = useMemo(() => {
    const list = items.map((i) => ({ ...i, kind: 'option' }))
    if (allowFree && typed && !exactShown && !selected.has(typed)) {
      list.push({ key: typed, label: typed, free: true, kind: 'free' })
    }
    return list
  }, [items, allowFree, typed, exactShown, selected])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(rows.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      const row = rows[active] || (rows.length === 1 ? rows[0] : null)
      if (row) {
        toggle({ key: row.key, label: row.label, id: row.id, free: row.free })
        setQuery('')
        setActive(-1)
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setActive(-1)
      }
    } else if (e.key === 'Backspace' && !query && chips.length) {
      remove(chips[chips.length - 1])
    }
  }

  const near = chips.length >= warnAt
  const full = chips.length >= max

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); setActive(-1) }
      }}
    >
      <label className="block text-xs font-medium text-slate-700" htmlFor={`${uid}-input`}>
        {label}
      </label>
      {(hint || disabledReason) && (
        <p id={hintId} className="mt-0.5 text-[11px] text-slate-500">
          {disabled && disabledReason ? disabledReason : hint}
        </p>
      )}

      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chips.map((c) => <Chip key={c.key} chip={c} onRemove={remove} />)}
        </div>
      )}

      <input
        id={`${uid}-input`}
        className="input mt-1.5"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={hint || disabledReason ? hintId : undefined}
        aria-activedescendant={open && active >= 0 && rows[active] ? `${uid}-opt-${active}` : undefined}
        aria-invalid={fault ? true : undefined}
        placeholder={disabled ? '' : placeholder}
        disabled={disabled || full}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(-1) }}
        onKeyDown={onKeyDown}
      />

      {(near || full) && (
        <p className="mt-1 text-[11px] text-amber-700" role="status">
          {full
            ? `That is the maximum of ${max.toLocaleString()} values for this filter. Remove one before adding another.`
            : `${chips.length.toLocaleString()} of a maximum ${max.toLocaleString()} values.`}
        </p>
      )}
      <FieldError fault={fault} />
      {footer}

      {open && !disabled && (
        <div className="z-30 mt-1 max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-50 max-sm:mt-0 sm:absolute sm:left-0 sm:right-0">
          <div className="card max-h-64 overflow-y-auto p-1 shadow-2xl max-sm:max-h-[60vh] max-sm:rounded-b-none">
            <ul id={listId} role="listbox" aria-multiselectable="true" aria-label={label}>
              {rows.map((row, i) => {
                const on = selected.has(String(row.key))
                return (
                  <li key={`${row.kind}-${row.key}`}>
                    <button
                      type="button"
                      id={`${uid}-opt-${i}`}
                      role="option"
                      aria-selected={on}
                      tabIndex={-1}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { toggle({ key: row.key, label: row.label, id: row.id, free: row.free }); setQuery('') }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm cursor-pointer ${
                        active === i ? 'bg-slate-100 text-ink-950' : 'text-slate-700'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`flex size-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                          on ? 'border-accent-500 bg-accent-500 text-ink-950' : 'border-slate-300'
                        }`}
                        >
                          {on ? '✓' : ''}
                        </span>
                        <span className="truncate">{row.label}</span>
                      </span>
                      {row.free && <span className="shrink-0 text-[11px] text-amber-700">{keepTypedLabel}</span>}
                      {row.note && <span className="shrink-0 text-[11px] text-slate-500">{row.note}</span>}
                    </button>
                  </li>
                )
              })}
              {loading && (
                <li className="px-2 py-3 text-sm text-slate-500">Loading…</li>
              )}
              {!loading && !error && rows.length === 0 && (
                <li className="px-2 py-3 text-sm text-slate-500">{emptyText}</li>
              )}
              {error && (
                <li className="px-2 py-3 text-sm text-red-700">
                  {String(error.message || error)}{' '}
                  <button
                    type="button"
                    className="cursor-pointer underline"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(typed, 0, false)}
                  >
                    Try again
                  </button>
                </li>
              )}
            </ul>
            {hasMore && !loading && (
              <button
                type="button"
                className="btn-ghost mt-1 w-full justify-center"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(typed, items.length, true)}
              >
                Show more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// A fieldset with a legend and real checkboxes. Two columns above 640px, one
// below. Used wherever the whole vocabulary fits on screen and a search box
// would be furniture.
function CheckboxGroup({
  legend, hint, options, chips = [], onChange, loading, error, onRetry,
  empty = 'Nothing to choose from.', fault = null, note = null,
}) {
  const selected = useMemo(() => new Set(chips.map((c) => String(c.key))), [chips])
  const toggle = (opt) => {
    if (selected.has(String(opt.key))) onChange(chips.filter((c) => String(c.key) !== String(opt.key)))
    else onChange(uniqueChips([...chips, opt]))
  }
  return (
    <fieldset>
      <legend className="text-xs font-medium text-slate-700">{legend}</legend>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      {loading && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {String(error.message || error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={onRetry}>Try again</button>
        </p>
      )}
      {!loading && !error && options.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      )}
      {!loading && !error && options.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {options.map((opt) => (
            <label key={opt.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-100">
              <input
                type="checkbox"
                className="size-4 accent-accent-500"
                checked={selected.has(String(opt.key))}
                onChange={() => toggle(opt)}
              />
              <span className="truncate">{opt.label}</span>
              {opt.note && <span className="shrink-0 text-[11px] text-amber-700">{opt.note}</span>}
            </label>
          ))}
        </div>
      )}
      {note}
      <FieldError fault={fault} />
    </fieldset>
  )
}

// Collapsible filter group. Collapsed groups still say what they hold, so the
// form is short without hiding what it is doing.
function Section({ title, open, onToggle, count = 0, summary, children }) {
  return (
    <section className="border-b border-slate-200">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-ink-900 hover:bg-slate-100"
        >
          <span>
            {title}
            {count > 0 && (
              <span className="ml-2 rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">{count}</span>
            )}
          </span>
          <span aria-hidden className="text-slate-500">{open ? '−' : '+'}</span>
        </button>
      </h3>
      {open && <div className="space-y-4 px-4 pb-4">{children}</div>}
      {!open && summary && <p className="-mt-1 px-4 pb-3 text-[11px] text-slate-500">{summary}</p>}
    </section>
  )
}

// Include / exclude is a mode switch inside one field rather than two fields
// side by side, and a value can never sit in both lists: adding to one removes
// it from the other.
function IncludeExclude({
  label, hint, mode, onMode, include, exclude, onInclude, onExclude,
  load, allowFree, emptyText, exact, onExact, exactLabel = 'match exactly',
  fault, footer, reloadKey,
}) {
  const uid = useId()
  const chips = mode === 'exclude' ? exclude : include
  const setChips = (next) => {
    if (mode === 'exclude') {
      const keys = new Set(next.map((c) => String(c.key)))
      onExclude(next)
      onInclude(include.filter((c) => !keys.has(String(c.key))))
    } else {
      const keys = new Set(next.map((c) => String(c.key)))
      onInclude(next)
      onExclude(exclude.filter((c) => !keys.has(String(c.key))))
    }
  }
  const other = mode === 'exclude' ? include : exclude
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label={`${label}: include or exclude`} className="flex rounded-lg border border-slate-300 p-0.5">
          {['include', 'exclude'].map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => onMode(m)}
              className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] capitalize ${
                mode === m ? 'bg-accent-500 text-ink-950' : 'text-slate-600 hover:text-ink-900'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {onExact && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
            <input
              type="checkbox"
              className="size-3.5 accent-accent-500"
              checked={Boolean(exact)}
              onChange={(e) => onExact(e.target.checked)}
              id={`${uid}-exact`}
            />
            {exactLabel}
          </label>
        )}
      </div>
      <Combobox
        label={mode === 'exclude' ? `${label} to exclude` : label}
        hint={hint}
        chips={chips}
        onChange={setChips}
        load={load}
        allowFree={allowFree}
        emptyText={emptyText}
        fault={fault}
        reloadKey={reloadKey}
        footer={footer}
      />
      {other.length > 0 && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {mode === 'exclude'
            ? `${include.length} value(s) are set to include: ${include.slice(0, 3).map((c) => c.label).join(', ')}${include.length > 3 ? '…' : ''}`
            : `${exclude.length} value(s) are set to exclude: ${exclude.slice(0, 3).map((c) => c.label).join(', ')}${exclude.length > 3 ? '…' : ''}`}
        </p>
      )}
    </div>
  )
}

// The industry taxonomy is a two-level tree fetched once and filtered locally,
// so typing in it costs nothing. A parent with only some children ticked reads
// as `aria-checked="mixed"` rather than looking unticked.
function IndustryTree({ tree, loading, error, onRetry, industries, subIndustries, onIndustries, onSubIndustries }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const uid = useId()

  const pickedIndustries = useMemo(() => new Set(industries.map((c) => String(c.key))), [industries])
  const pickedSubs = useMemo(() => new Set(subIndustries.map((c) => String(c.key))), [subIndustries])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tree
    return tree
      .map((node) => {
        const selfHit = String(node.name || '').toLowerCase().includes(q)
        const kids = (node.subIndustries || []).filter((s) => String(s.name || '').toLowerCase().includes(q))
        if (selfHit) return node
        if (kids.length) return { ...node, subIndustries: kids }
        return null
      })
      .filter(Boolean)
  }, [tree, query])

  const toggleIndustry = (node) => {
    const key = String(node.id)
    if (pickedIndustries.has(key)) onIndustries(industries.filter((c) => String(c.key) !== key))
    else onIndustries(uniqueChips([...industries, { key: node.id, label: node.name }]))
  }
  const toggleSub = (name) => {
    if (pickedSubs.has(name)) onSubIndustries(subIndustries.filter((c) => String(c.key) !== name))
    else onSubIndustries(uniqueChips([...subIndustries, { key: name, label: name }]))
  }

  if (loading) return <p className="text-sm text-slate-500">Loading the industry list…</p>
  if (error) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {String(error.message || error)}{' '}
        <button type="button" className="cursor-pointer underline" onClick={onRetry}>Try again</button>
      </p>
    )
  }
  if (!tree.length) return <p className="text-sm text-slate-500">No industries are available.</p>

  return (
    <div>
      <label className="block text-xs font-medium text-slate-700" htmlFor={`${uid}-filter`}>Industries</label>
      <p className="mt-0.5 text-[11px] text-slate-500">
        The whole list is already loaded, so typing here filters it on your machine — no request is made.
        Sub-industry names match too.
      </p>
      <input
        id={`${uid}-filter`}
        className="input mt-1.5"
        placeholder="Filter industries…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-1" role="tree" aria-label="Industries">
        {shown.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No industries match that</p>}
        {shown.map((node) => {
          const kids = node.subIndustries || []
          const kidsOn = kids.filter((s) => pickedSubs.has(s.name)).length
          const on = pickedIndustries.has(String(node.id))
          const mixed = !on && kidsOn > 0
          const isOpen = expanded.has(String(node.id)) || Boolean(query.trim())
          return (
            <div key={node.id} role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-checked={mixed ? 'mixed' : on}>
              <div className="flex items-center gap-1">
                {kids.length > 0 ? (
                  <button
                    type="button"
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
                    onClick={() => setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(String(node.id))) next.delete(String(node.id))
                      else next.add(String(node.id))
                      return next
                    })}
                    className="cursor-pointer px-1 text-slate-500 hover:text-slate-700"
                  >
                    {isOpen ? '−' : '+'}
                  </button>
                ) : (
                  <span className="px-1 text-transparent" aria-hidden>·</span>
                )}
                <label className="flex flex-1 cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-slate-700 hover:bg-slate-100">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent-500"
                    checked={on}
                    ref={(el) => { if (el) el.indeterminate = mixed }}
                    onChange={() => toggleIndustry(node)}
                  />
                  <span className="truncate">{node.name}</span>
                  {mixed && <span className="text-[11px] text-slate-500">{kidsOn} sub-industry selected</span>}
                </label>
              </div>
              {isOpen && kids.length > 0 && (
                <div role="group" className="ml-7">
                  {kids.map((sub) => (
                    <label key={sub.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-slate-600 hover:bg-slate-100">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent-500"
                        checked={pickedSubs.has(sub.name)}
                        onChange={() => toggleSub(sub.name)}
                      />
                      <span className="truncate">{sub.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Editing a name in place: click it, type, Enter to save, Escape to cancel.
// No new control appears until the name is clicked, the counter appears as the
// 255-character limit approaches, and a failure reverts visibly with the reason
// on the row rather than in a page banner.
function InlineName({ value, onSave, label }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const uid = useId()

  useEffect(() => { setDraft(value) }, [value])

  const commit = async () => {
    const name = draft.trim()
    if (!name || name === value) { setEditing(false); setDraft(value); return }
    if (name.length > MAX_NAME) { setError(`Names may be at most ${MAX_NAME} characters.`); return }
    setBusy(true)
    setError(null)
    try {
      await onSave(name)
      setEditing(false)
    } catch (err) {
      setDraft(value)
      setError(err?.status === 403
        ? 'You do not have permission to rename this. The name has been put back.'
        : err?.status === 404
          ? 'That list is no longer available. The name has been put back.'
          : `${String(err?.message || err)} The name has been put back.`)
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="cursor-pointer text-left text-sm font-medium text-ink-950 hover:text-accent-700"
        aria-label={`${label}: ${value}. Click to rename.`}
      >
        {value}
        {error && <span className="ml-2 text-[11px] text-red-700">{error}</span>}
      </button>
    )
  }

  const near = draft.length > MAX_NAME - 40
  return (
    <div className="w-full">
      <label className="sr-only" htmlFor={`${uid}-name`}>{label}</label>
      <input
        id={`${uid}-name`}
        className="input"
        autoFocus
        disabled={busy}
        value={draft}
        maxLength={MAX_NAME}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); setDraft(value); setEditing(false); setError(null) }
        }}
        onBlur={commit}
      />
      <p className="mt-1 flex items-center gap-2 text-[11px] text-slate-500" aria-live="polite">
        {busy ? 'Saving…' : 'Enter to save, Escape to cancel.'}
        {near && <span className="text-amber-700">{draft.length} of {MAX_NAME} characters</span>}
      </p>
      {error && <p className="mt-1 text-[11px] text-red-700" role="alert">{error}</p>}
    </div>
  )
}

// ---- offset paging for Harry's own lists -------------------------------------
// Saved searches, recent searches and fetch history are limit/offset lists with
// `pagination.hasMore`, not the keyset lists `usePagedList` serves.
function useOffsetList(path, pageSize = 10) {
  const [items, setItems] = useState([])
  const [status, setStatus] = useState(null)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchPage = useCallback(async (offset) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`${path}${qs({ limit: pageSize, offset })}`)
      setItems((prev) => (offset ? [...prev, ...(res.items || [])] : (res.items || [])))
      setTotal(res.totalCount || 0)
      setHasMore(Boolean(res.pagination?.hasMore))
      setStatus(connectionStatus(res))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [path, pageSize])

  useEffect(() => { fetchPage(0) }, [fetchPage])

  return {
    items, setItems, total, hasMore, loading, error, status,
    reload: () => fetchPage(0),
    loadMore: () => fetchPage(items.length),
  }
}

// =============================================================================

export default function ProspectSearch({ onImported }) {
  const toast = useToast()

  const [sel, setSel] = useState(emptySelection)
  const [modes, setModes] = useState({ titles: 'include', companies: 'include', domains: 'include' })
  const [previewLimit, setPreviewLimit] = useState(25)
  const [open, setOpen] = useState({ people: true, company: false, industries: false, location: false, options: false })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [tab, setTab] = useState('preview')
  const [announce, setAnnounce] = useState('')
  const [faults, setFaults] = useState({})          // control group → { field, message }
  const [loadedNote, setLoadedNote] = useState(null)

  // preview
  const [preview, setPreview] = useState(null)      // last good result
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const [previewAt, setPreviewAt] = useState(null)
  const [restarted, setRestarted] = useState(false)
  const [ticked, setTicked] = useState([])
  const [dirty, setDirty] = useState(false)

  // dialogs
  const [saveOpen, setSaveOpen] = useState(false)
  const [fetchOpen, setFetchOpen] = useState(false)
  const [contactsFor, setContactsFor] = useState(null)

  // reference vocabularies loaded once (server-cached, so this is cheap)
  const [refs, setRefs] = useState({
    departments: null, levels: null, headCounts: null, revenue: null,
    revenueStale: [], loading: true, error: null,
  })
  const [tree, setTree] = useState({ items: [], loading: false, error: null, loaded: false })
  const [analytics, setAnalytics] = useState(null)

  const setField = useCallback((field, value) => {
    setSel((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
  }, [])

  const filters = useMemo(() => {
    const out = {}
    for (const f of ARRAY_FIELDS) if (sel[f].length) out[f] = sel[f].map((c) => c.key)
    for (const f of BOOL_FIELDS) if (sel[f]) out[f] = true
    return out
  }, [sel])

  const activeCount = useMemo(
    () => ARRAY_FIELDS.reduce((n, f) => n + (sel[f].length ? 1 : 0), 0) + BOOL_FIELDS.filter((f) => sel[f]).length,
    [sel],
  )

  // ---- reference lists -------------------------------------------------------

  const loadRefs = useCallback(async () => {
    setRefs((r) => ({ ...r, loading: true, error: null }))
    try {
      const [departments, levels, headCounts, revenue] = await Promise.all([
        api.get(`/api/prospects/filters/departments${qs({ limit: VOCAB_PAGE })}`),
        api.get(`/api/prospects/filters/levels${qs({ limit: VOCAB_PAGE })}`),
        api.get(`/api/prospects/filters/head-counts${qs({ limit: VOCAB_PAGE })}`),
        api.get('/api/prospects/filters/revenue'),
      ])
      setRefs({
        departments: (departments.items || []).map((i) => ({ key: i.id, label: i.name })),
        levels: (levels.items || []).map((i) => ({ key: i.id, label: i.name })),
        headCounts: (headCounts.items || []).map((i) => ({ key: i.id, label: i.label })),
        revenue: (revenue.items || []).map((i) => ({ key: i.id, label: i.label })),
        revenueStale: revenue.stale || [],
        loading: false,
        error: null,
      })
    } catch (err) {
      setRefs((r) => ({ ...r, loading: false, error: err }))
    }
  }, [])

  useEffect(() => { loadRefs() }, [loadRefs])

  const loadTree = useCallback(async () => {
    setTree((t) => ({ ...t, loading: true, error: null }))
    try {
      const rows = []
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const res = await api.get(`/api/prospects/filters/industries${qs({
          withSubIndustry: 'true', limit: VOCAB_PAGE, offset: pageIndex * VOCAB_PAGE,
        })}`)
        const items = res.items || []
        rows.push(...items)
        if (items.length < VOCAB_PAGE) break
      }
      setTree({ items: rows, loading: false, error: null, loaded: true })
    } catch (err) {
      setTree((t) => ({ ...t, loading: false, error: err }))
    }
  }, [])

  useEffect(() => {
    if (open.industries && !tree.loaded && !tree.loading) loadTree()
  }, [open.industries, tree.loaded, tree.loading, loadTree])

  const loadAnalytics = useCallback(async (searchId) => {
    try {
      const res = await api.get(`/api/prospects/analytics${qs({ filterId: searchId ?? undefined })}`)
      setAnalytics(res)
    } catch (err) {
      // Analytics failing must never stop a fetch dialog opening; the dialog
      // states the reason and caps the count conservatively instead.
      setAnalytics({ configured: true, unavailable: true, message: String(err?.message || err) })
    }
  }, [])

  useEffect(() => { loadAnalytics(null) }, [loadAnalytics])

  // ---- vocabulary loaders ----------------------------------------------------

  // The path is passed in whole rather than assembled from a fragment. It reads
  // no worse, and it keeps every route this file calls greppable — the
  // requirements matrix finds call sites by scanning for literal `/api/…`
  // strings, so a path built inside the helper is a route the project's own
  // tracking reports as reaching no screen.
  const flatLoader = (path, pick) => async (search, offset = 0) => {
    const res = await api.get(`${path}${qs({ search, limit: VOCAB_PAGE, offset })}`)
    return {
      items: (res.items || []).map(pick),
      hasMore: Boolean(res.hasMore),
    }
  }

  const loadJobTitles = flatLoader('/api/prospects/filters/job-titles', (i) => ({ key: i.title, label: i.title }))
  const loadCompanies = flatLoader('/api/prospects/filters/companies', (i) => ({
    key: i.name, label: i.name, note: i.alreadyInLeads ? 'already in your leads' : undefined,
  }))
  const loadDomains = flatLoader('/api/prospects/filters/domains', (i) => ({ key: i.domain, label: i.domain }))
  const loadKeywords = flatLoader('/api/prospects/filters/keywords', (i) => ({ key: i.keyword, label: i.keyword }))
  const loadDepartments = flatLoader('/api/prospects/filters/departments', (i) => ({ key: i.id, label: i.name }))

  const loadCountries = async (search, offset = 0) => {
    const res = await api.get(`/api/prospects/filters/countries${qs({ search, limit: VOCAB_PAGE, offset })}`)
    return {
      items: (res.items || []).map((i) => ({ key: i.name, label: i.name, id: i.id })),
      hasMore: (res.items || []).length === VOCAB_PAGE,
    }
  }

  const countryIds = useMemo(() => sel.countries.map((c) => c.id).filter(Boolean).join(','), [sel.countries])
  const countryNames = useMemo(() => sel.countries.map((c) => c.label).join(', '), [sel.countries])
  const stateNames = useMemo(() => sel.states.map((s) => s.label).join(','), [sel.states])

  const loadStates = async (search, offset = 0) => {
    const res = await api.get(`/api/prospects/filters/states${qs({
      search, countryIds: countryIds || undefined, limit: VOCAB_PAGE, offset,
    })}`)
    return {
      items: (res.items || []).map((i) => ({ key: i.name, label: i.name, id: i.id })),
      hasMore: (res.items || []).length === VOCAB_PAGE,
    }
  }

  // Cities are the one lookup with its own rule: a country may only be supplied
  // alongside a state. The field is disabled until a state is chosen and says so,
  // rather than sending a request the server would refuse.
  const loadCities = async (search, offset = 0) => {
    const res = await api.get(`/api/prospects/filters/cities${qs({
      search,
      state: stateNames || undefined,
      country: stateNames ? (sel.countries.map((c) => c.label).join(',') || undefined) : undefined,
      limit: VOCAB_PAGE,
      offset,
    })}`)
    return {
      items: (res.items || []).map((i) => ({ key: i.name, label: i.name, id: i.id })),
      hasMore: (res.items || []).length === VOCAB_PAGE,
    }
  }

  const [parentNote, setParentNote] = useState(null)
  const industryIdList = useMemo(() => sel.industryIds.map((c) => c.key).join(','), [sel.industryIds])

  const loadSubIndustries = async (search, offset = 0) => {
    const res = await api.get(`/api/prospects/filters/sub-industries${qs({
      search,
      industryIds: industryIdList || undefined,
      limit: VOCAB_PAGE,
      offset,
    })}`)
    const items = (res.items || []).map((i) => ({
      key: i.name,
      label: i.name,
      id: i.industryId,
      note: i.parentMissing ? 'parent industry not selected' : undefined,
    }))
    const orphan = (res.items || []).find((i) => i.parentMissing)
    if (orphan) {
      setParentNote({
        subIndustry: orphan.name,
        industryId: orphan.industryId,
        industryName: (tree.items.find((t) => String(t.id) === String(orphan.industryId)) || {}).name || `industry ${orphan.industryId}`,
      })
    }
    return { items, hasMore: (res.items || []).length === VOCAB_PAGE }
  }

  // ---- the preview -----------------------------------------------------------

  const runSearch = useCallback(async (cursor) => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await api.post('/api/prospects/search', {
        limit: previewLimit,
        filters,
        ...(cursor ? { cursor } : {}),
      })
      setRestarted(Boolean(res.cursorRestarted))
      setPreview((prev) => {
        const append = Boolean(cursor) && !res.cursorRestarted
        return {
          ...res,
          items: append ? [...(prev?.items || []), ...(res.items || [])] : (res.items || []),
        }
      })
      setPreviewAt(new Date().toISOString())
      setDirty(false)
      setFaults((f) => {
        const next = { ...f }
        for (const k of Object.keys(next)) if (next[k]?.origin === 'search') delete next[k]
        return next
      })
      if (res.cursorRestarted) {
        setAnnounce('Filters changed — showing results from the start.')
      } else {
        setAnnounce(`${scaledCount(res.totalCount)} contacts match. Showing ${(res.items || []).length}.`)
      }
      if (res.searchId) loadAnalytics(res.searchId)
    } catch (err) {
      const fault = fieldFault(err)
      if (fault) {
        const group = groupFor(fault.field)
        if (group) setFaults((f) => ({ ...f, [group]: { ...fault, origin: 'search' } }))
        setAnnounce(fault.message)
      }
      setPreviewError(err)
    } finally {
      setPreviewLoading(false)
    }
  }, [filters, previewLimit, loadAnalytics])

  // Debounced re-search whenever the filters change. The previous results stay
  // on screen, dimmed, so the pane never blinks empty between two audiences.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; runSearch(null); return undefined }
    const t = setTimeout(() => { setTicked([]); runSearch(null) }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), previewLimit])

  const status = connectionStatus(preview)
  const searchId = preview?.searchId ?? null

  // ---- loading a stored filter set into the form ------------------------------

  const hydrate = useCallback((raw) => {
    const next = emptySelection()
    const unknown = []
    const idLists = {
      departmentIds: refs.departments, levelIds: refs.levels,
      headCountIds: refs.headCounts, revenueIds: refs.revenue,
    }
    for (const [key, value] of Object.entries(raw || {})) {
      if (BOOL_FIELDS.includes(key)) { next[key] = Boolean(value); continue }
      if (!ARRAY_FIELDS.includes(key)) {
        unknown.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
        continue
      }
      const values = Array.isArray(value) ? value : [value]
      if (key === 'industryIds') {
        next[key] = values.map((v) => {
          const hit = tree.items.find((t) => String(t.id) === String(v))
          return { key: v, label: hit ? hit.name : `Industry ${v}` }
        })
      } else if (idLists[key]) {
        next[key] = values.map((v) => {
          const hit = (idLists[key] || []).find((o) => String(o.key) === String(v))
          return { key: v, label: hit ? hit.label : `#${v}` }
        })
      } else {
        next[key] = values.map((v) => ({ key: v, label: String(v) }))
      }
    }
    setSel(next)
    setDirty(true)
    return unknown
  }, [refs.departments, refs.levels, refs.headCounts, refs.revenue, tree.items])

  const loadIntoForm = (row) => {
    const unknown = hydrate(row.filters || {})
    setLoadedNote({
      name: row.name,
      date: shortDate(row.updatedAt || row.createdAt),
      unknown,
    })
    setTab('preview')
    setSheetOpen(false)
    setAnnounce(`Loaded the filters from "${row.name}". Nothing has been fetched.`)
  }

  // ---- summaries -------------------------------------------------------------

  const peopleSummary = useMemo(() => {
    const parts = []
    if (sel.departmentIds.length) parts.push(`People in ${sel.departmentIds.map((c) => c.label).join(', ')}`)
    if (sel.levelIds.length) parts.push(`at ${sel.levelIds.map((c) => c.label).join(' or ')} level`)
    if (sel.includeTitles.length) parts.push(`with titles like ${sel.includeTitles.slice(0, 3).map((c) => c.label).join(', ')}`)
    if (sel.excludeTitles.length) parts.push(`but not ${sel.excludeTitles.slice(0, 3).map((c) => c.label).join(', ')}`)
    if (!parts.length) return ''
    return parts.join(', ')
  }, [sel.departmentIds, sel.levelIds, sel.includeTitles, sel.excludeTitles])

  const companySummary = useMemo(() => {
    const parts = []
    if (sel.headCountIds.length) parts.push(`${sel.headCountIds.map((c) => c.label).join(', ')} people`)
    if (sel.revenueIds.length) parts.push(`${sel.revenueIds.map((c) => c.label).join(', ')} revenue`)
    if (!parts.length) return ''
    return `Companies with ${parts.join(' and ')}`
  }, [sel.headCountIds, sel.revenueIds])

  const locationSummary = useMemo(() => {
    const parts = []
    if (sel.cities.length) parts.push(sel.cities.map((c) => c.label).join(', '))
    if (sel.states.length) parts.push(sel.states.map((c) => c.label).join(', '))
    if (sel.countries.length) parts.push(sel.countries.map((c) => c.label).join(', '))
    return parts.join(' · ')
  }, [sel.cities, sel.states, sel.countries])

  // ---- render ----------------------------------------------------------------

  const filterPanel = (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-950">Filters</h2>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <button
              type="button"
              className="cursor-pointer text-[11px] text-slate-600 hover:text-ink-900"
              onClick={() => { setSel(emptySelection()); setLoadedNote(null); setDirty(true) }}
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            className="cursor-pointer text-[11px] text-slate-600 hover:text-ink-900 lg:hidden"
            onClick={() => setSheetOpen(false)}
          >
            Done
          </button>
        </div>
      </div>

      {loadedNote && (
        <div className="border-b border-slate-200 bg-slate-100/50 px-4 py-3 text-xs text-slate-700" role="status">
          <div className="flex items-start justify-between gap-2">
            <p>Loaded from your search of {loadedNote.date || 'an earlier session'}. Nothing has been fetched.</p>
            <button
              type="button"
              className="cursor-pointer text-slate-500 hover:text-slate-700"
              aria-label="Dismiss the loaded-search note"
              onClick={() => setLoadedNote(null)}
            >
              ×
            </button>
          </div>
          {loadedNote.unknown?.length > 0 && (
            <p className="mt-1.5 text-amber-700">
              These filters have no control here and were not applied: {loadedNote.unknown.join(' · ')}
            </p>
          )}
        </div>
      )}

      <Section
        title="People"
        open={open.people}
        onToggle={() => setOpen((o) => ({ ...o, people: !o.people }))}
        count={[sel.includeTitles, sel.excludeTitles, sel.departmentIds, sel.levelIds, sel.fullName, sel.firstName, sel.lastName].filter((l) => l.length).length}
        summary={peopleSummary}
      >
        <Combobox
          label="Departments"
          hint="The provider's own department list."
          chips={sel.departmentIds}
          onChange={(v) => setField('departmentIds', v)}
          load={loadDepartments}
          emptyText="No departments match that"
          fault={faults.departments}
        />
        <IncludeExclude
          label="Job titles"
          hint="Pick from the provider's vocabulary, or press Enter to keep exactly what you typed."
          mode={modes.titles}
          onMode={(m) => setModes((s) => ({ ...s, titles: m }))}
          include={sel.includeTitles}
          exclude={sel.excludeTitles}
          onInclude={(v) => setField('includeTitles', v)}
          onExclude={(v) => setField('excludeTitles', v)}
          load={loadJobTitles}
          allowFree
          emptyText="No job titles match that"
          exact={sel.exactTitleMatch}
          onExact={(v) => setField('exactTitleMatch', v)}
          fault={faults.titles}
        />
        {/* Follows the active include/exclude mode, exactly as Paste domains
            does below, so the two "bring a list in" controls behave alike. */}
        <FromGoal
          path="/api/prospects/filters/job-titles/reconcile"
          bodyKey="titles"
          icpKey="titles"
          noun="job title"
          existing={modes.titles === 'exclude' ? sel.excludeTitles : sel.includeTitles}
          onKeep={(chips) => setField(modes.titles === 'exclude' ? 'excludeTitles' : 'includeTitles', chips)}
          onAnnounce={setAnnounce}
        />
        <CheckboxGroup
          legend="Seniority"
          hint="The provider's ladder, in the order it returns."
          options={refs.levels || []}
          chips={sel.levelIds}
          onChange={(v) => setField('levelIds', v)}
          loading={refs.loading}
          error={refs.error}
          onRetry={loadRefs}
          empty="No levels match that"
          fault={faults.levels}
        />
        {peopleSummary && (
          <p className="rounded-lg bg-slate-100/60 px-3 py-2 text-xs text-slate-700" aria-live="polite">{peopleSummary}</p>
        )}
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">Search by name</summary>
          <div className="mt-3 space-y-3">
            {[['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name']].map(([key, label]) => (
              <Combobox
                key={key}
                label={label}
                hint="Free text — press Enter to add."
                chips={sel[key]}
                onChange={(v) => setField(key, v)}
                load={async () => ({ items: [], hasMore: false })}
                allowFree
                emptyText="Type a name and press Enter"
                fault={faults.names}
              />
            ))}
          </div>
        </details>
      </Section>

      <Section
        title="Company"
        open={open.company}
        onToggle={() => setOpen((o) => ({ ...o, company: !o.company }))}
        count={[sel.includeCompanies, sel.excludeCompanies, sel.includeCompanyDomains, sel.excludeCompanyDomains, sel.companyKeywords, sel.headCountIds, sel.revenueIds].filter((l) => l.length).length}
        summary={companySummary}
      >
        <IncludeExclude
          label="Companies"
          hint="Names are the only key the provider gives here, so two companies with the same name cannot be told apart."
          mode={modes.companies}
          onMode={(m) => setModes((s) => ({ ...s, companies: m }))}
          include={sel.includeCompanies}
          exclude={sel.excludeCompanies}
          onInclude={(v) => setField('includeCompanies', v)}
          onExclude={(v) => setField('excludeCompanies', v)}
          load={loadCompanies}
          allowFree
          emptyText="No companies match that name"
          exact={sel.exactCompanyMatch}
          onExact={(v) => setField('exactCompanyMatch', v)}
          fault={faults.companies}
        />

        <div>
          <IncludeExclude
            label="Company domains"
            hint="acme.com, https://www.Acme.com/pricing and ACME.COM are all the same account here."
            mode={modes.domains}
            onMode={(m) => setModes((s) => ({ ...s, domains: m }))}
            include={sel.includeCompanyDomains}
            exclude={sel.excludeCompanyDomains}
            onInclude={(v) => setField('includeCompanyDomains', v)}
            onExclude={(v) => setField('excludeCompanyDomains', v)}
            load={loadDomains}
            allowFree
            emptyText="No domains match that"
            exact={sel.exactCompanyDomainMatch}
            onExact={(v) => setField('exactCompanyDomainMatch', v)}
            fault={faults.domains}
          />
          <PasteDomains
            existing={modes.domains === 'exclude' ? sel.excludeCompanyDomains : sel.includeCompanyDomains}
            onKeep={(chips) => setField(
              modes.domains === 'exclude' ? 'excludeCompanyDomains' : 'includeCompanyDomains',
              chips,
            )}
            onAnnounce={setAnnounce}
          />
        </div>

        <div>
          <Combobox
            label="Keywords"
            hint="What the provider matches a keyword against is not documented, so Harry does not claim to know."
            chips={sel.companyKeywords}
            onChange={(v) => setField('companyKeywords', v)}
            load={loadKeywords}
            allowFree
            emptyText="No keywords match that"
            fault={faults.keywords}
          />
          {/* The goal's ICP signals are the same words the qualifier quotes back
              in a score's reason, so bringing them here keeps one vocabulary
              rather than two that drift. */}
          <FromGoal
            path="/api/prospects/filters/keywords/reconcile"
            bodyKey="signals"
            icpKey="keywords"
            noun="keyword"
            existing={sel.companyKeywords}
            onKeep={(chips) => setField('companyKeywords', chips)}
            onAnnounce={setAnnounce}
          />
        </div>

        <CheckboxGroup
          legend="Company size"
          hint="The provider's bands, shown exactly as it returns them."
          options={refs.headCounts || []}
          chips={sel.headCountIds}
          onChange={(v) => setField('headCountIds', v)}
          loading={refs.loading}
          error={refs.error}
          onRetry={loadRefs}
          fault={faults.headCounts}
        />

        {(refs.revenue || []).length > 0 && (
          <CheckboxGroup
            legend="Company revenue"
            hint="This lookup documents no search or paging, so it has neither."
            options={(refs.revenue || []).map((o) => ({
              ...o,
              note: (refs.revenueStale || []).includes(String(o.key)) ? 'no longer available' : undefined,
            }))}
            chips={sel.revenueIds}
            onChange={(v) => setField('revenueIds', v)}
            loading={refs.loading}
            error={refs.error}
            onRetry={loadRefs}
            fault={faults.revenue}
          />
        )}

        {companySummary && (
          <p className="rounded-lg bg-slate-100/60 px-3 py-2 text-xs text-slate-700" aria-live="polite">{companySummary}</p>
        )}
      </Section>

      <Section
        title="Industries"
        open={open.industries}
        onToggle={() => setOpen((o) => ({ ...o, industries: !o.industries }))}
        count={[sel.industryIds, sel.subIndustries].filter((l) => l.length).length}
        summary={sel.industryIds.map((c) => c.label).join(', ')}
      >
        <IndustryTree
          tree={tree.items}
          loading={tree.loading}
          error={tree.error}
          onRetry={loadTree}
          industries={sel.industryIds}
          subIndustries={sel.subIndustries}
          onIndustries={(v) => setField('industryIds', v)}
          onSubIndustries={(v) => setField('subIndustries', v)}
        />
        <Combobox
          label="Search all sub-industries"
          hint={sel.industryIds.length
            ? `Searching within ${sel.industryIds.map((c) => c.label).join(', ')}.`
            : 'Searches every industry. Choosing one here ticks the matching leaf above.'}
          chips={sel.subIndustries}
          onChange={(v) => setField('subIndustries', v)}
          load={loadSubIndustries}
          emptyText="No sub-industries match that"
          reloadKey={industryIdList}
          fault={faults.subIndustries}
        />
        {parentNote && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            <p>
              “{parentNote.subIndustry}” sits under {parentNote.industryName}, which is not among your selected industries.
            </p>
            <div className="mt-1.5 flex gap-3">
              <button
                type="button"
                className="cursor-pointer underline"
                onClick={() => {
                  setField('industryIds', uniqueChips([...sel.industryIds, { key: parentNote.industryId, label: parentNote.industryName }]))
                  setParentNote(null)
                }}
              >
                Add {parentNote.industryName}
              </button>
              <button type="button" className="cursor-pointer underline" onClick={() => setParentNote(null)}>Dismiss</button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Location"
        open={open.location}
        onToggle={() => setOpen((o) => ({ ...o, location: !o.location }))}
        count={[sel.countries, sel.states, sel.cities].filter((l) => l.length).length}
        summary={locationSummary}
      >
        <Combobox
          label="Countries"
          chips={sel.countries}
          onChange={(v) => setField('countries', v)}
          load={loadCountries}
          emptyText="No countries match that"
          fault={faults.countries}
        />
        <Combobox
          label="States or regions"
          hint={sel.countries.length
            ? `Narrowed to ${countryNames}.`
            : 'Not narrowed to any country — every state is listed.'}
          chips={sel.states}
          onChange={(v) => setField('states', v)}
          load={loadStates}
          reloadKey={countryIds}
          emptyText="No states match that"
          fault={faults.states}
        />
        <Combobox
          label="City"
          hint="The provider will only list cities inside a state."
          disabled={sel.states.length === 0}
          disabledReason="Select a state or region first — the provider needs one before it will list cities."
          chips={sel.cities}
          onChange={(v) => setField('cities', v)}
          load={loadCities}
          reloadKey={`${stateNames}|${countryIds}`}
          emptyText="No cities match that"
          fault={faults.cities}
        />
      </Section>

      <Section
        title="Options"
        open={open.options}
        onToggle={() => setOpen((o) => ({ ...o, options: !o.options }))}
        count={sel.hideOwnedContacts ? 1 : 0}
      >
        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent-500"
            checked={sel.hideOwnedContacts}
            onChange={(e) => setField('hideOwnedContacts', e.target.checked)}
          />
          <span>
            Hide contacts I already own
            <span className="block text-[11px] text-slate-500">Leaves out anyone the provider has already sold you.</span>
          </span>
        </label>
        <div>
          <label className="block text-xs font-medium text-slate-700" htmlFor="prospect-preview-limit">
            Preview size
          </label>
          <p className="mt-0.5 text-[11px] text-slate-500">Between 1 and {MAX_PREVIEW_LIMIT} rows per page of the preview.</p>
          <input
            id="prospect-preview-limit"
            type="number"
            min={1}
            max={MAX_PREVIEW_LIMIT}
            className="input mt-1.5"
            value={previewLimit}
            onChange={(e) => {
              const n = Number(e.target.value)
              setPreviewLimit(Number.isFinite(n) ? Math.min(MAX_PREVIEW_LIMIT, Math.max(1, Math.round(n))) : 1)
            }}
          />
          <FieldError fault={faults.limit} />
        </div>
      </Section>

      <div className="flex flex-wrap gap-2 px-4 py-4">
        <button type="button" className="btn-ghost" onClick={() => setSaveOpen(true)}>Save search</button>
        <button type="button" className="btn-ghost" onClick={() => { setTicked([]); runSearch(null) }} disabled={previewLoading}>
          {previewLoading ? 'Searching…' : 'Search again'}
        </button>
      </div>
    </div>
  )

  return (
    <section className="mt-8" aria-label="Find prospects">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-950">Find prospects</h2>
          <p className="text-sm text-slate-600">
            Describe an audience, look at who is in it, then pay to turn some of them into leads.
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost lg:hidden"
          onClick={() => setSheetOpen(true)}
          aria-expanded={sheetOpen}
        >
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
      </div>

      <NotConnected status={status} what="Prospect search" />
      {status && !status.configured && (
        <p className="-mt-2 mb-4 text-xs text-slate-500">
          Saved searches, past fetches and every contact already fetched still read from Harry’s own tables below.
        </p>
      )}

      <LiveRegion message={announce} />

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,380px)_1fr]">
        <div className="hidden lg:block">{filterPanel}</div>

        {sheetOpen && (
          <div className="fixed inset-0 z-40 overflow-y-auto bg-white p-3 lg:hidden" role="dialog" aria-label="Filters">
            {filterPanel}
          </div>
        )}

        <div className="min-w-0">
          <Tabs
            ariaLabel="Prospect search sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'preview', label: 'Preview' },
              { id: 'recent', label: 'Recent' },
              { id: 'saved', label: 'Saved' },
              { id: 'history', label: 'History' },
            ]}
          />

          {tab === 'preview' && (
            <PreviewPane
              preview={preview}
              loading={previewLoading}
              error={previewError}
              at={previewAt}
              restarted={restarted}
              dirty={dirty}
              ticked={ticked}
              setTicked={setTicked}
              onShowMore={() => runSearch(preview?.cursor)}
              onRetry={() => runSearch(null)}
              onFetch={() => setFetchOpen(true)}
              analytics={analytics}
              activeCount={activeCount}
            />
          )}

          {tab === 'recent' && <RecentTab onLoad={loadIntoForm} />}

          {tab === 'saved' && (
            <SavedTab
              onLoad={loadIntoForm}
              onReviewed={onImported}
              onAnnounce={setAnnounce}
              toast={toast}
            />
          )}

          {tab === 'history' && (
            <HistoryTab
              onAnnounce={setAnnounce}
              onOpenContacts={setContactsFor}
              toast={toast}
            />
          )}
        </div>
      </div>

      {saveOpen && (
        <SaveDialog
          filters={filters}
          sel={sel}
          onClose={() => setSaveOpen(false)}
          onSaved={(row) => {
            setSaveOpen(false)
            setAnnounce(`Saved “${row.name}”.`)
            toast(`Saved “${row.name}”`)
            setTab('saved')
          }}
        />
      )}

      {fetchOpen && (
        <FetchDialog
          searchId={searchId}
          totalCount={preview?.totalCount || 0}
          ticked={ticked}
          configured={status?.configured !== false}
          analytics={analytics}
          onClose={() => setFetchOpen(false)}
          onDone={(res) => {
            if (res?.success) {
              setAnnounce(`Fetched ${res.fetched} contact(s). ${res.leadsCreated} new lead(s), ${res.leadsUpdated} updated, ${res.skipped} skipped.`)
              if (typeof onImported === 'function') onImported()
              loadAnalytics(searchId)
            }
          }}
        />
      )}

      {contactsFor && (
        <ContactsDrawer row={contactsFor} onClose={() => setContactsFor(null)} />
      )}
    </section>
  )
}

// ---- preview pane ------------------------------------------------------------

function PreviewPane({
  preview, loading, error, at, restarted, dirty, ticked, setTicked,
  onShowMore, onRetry, onFetch, analytics, activeCount,
}) {
  const items = preview?.items || []
  const total = preview?.totalCount || 0
  const configured = preview?.configured !== false
  const tooBroad = total > 100000

  const toggle = (id) => setTicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const allTicked = items.length > 0 && ticked.length === items.length

  if (!preview && loading) return <Spinner label="Searching…" />
  if (!preview && error) return <ErrorState error={error} onRetry={onRetry} />

  return (
    <div>
      <div className="card mb-4 px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs text-slate-600">Contacts matching these filters</p>
            <p className="text-2xl font-semibold text-ink-950" aria-live="polite">
              {configured ? scaledCount(total) : '—'}
            </p>
            {at && (
              <p className="mt-0.5 text-[11px] text-slate-500" title={exactDate(at)}>
                Counted {exactDate(at)}
                {dirty && ' · filters have changed since'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={onFetch}
              disabled={!preview?.searchId || (!items.length && ticked.length === 0)}
            >
              Get email addresses
            </button>
          </div>
        </div>

        {tooBroad && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            That is a very broad audience. Narrow it with a department, a seniority or a location before fetching —
            the count above is approximate at this size.
          </p>
        )}

        {restarted && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            Filters changed — showing results from the start. The page you were on belonged to the previous audience,
            so it could not be continued.
          </p>
        )}

        {preview?.ignoredFilters?.length > 0 && (
          <p className="mt-3 text-xs text-amber-700" role="status">
            These filters were not applied because the server does not recognise them:{' '}
            {preview.ignoredFilters.join(', ')}
          </p>
        )}

        {analytics?.credits && (
          <p className="mt-3 text-[11px] text-slate-500">
            {Number(analytics.credits.available ?? 0).toLocaleString()} email credit(s) available
            {analytics.maxSingleFetchLimit ? ` · at most ${analytics.maxSingleFetchLimit.toLocaleString()} in one fetch` : ''}
          </p>
        )}
      </div>

      {error && preview && (
        <div className="card mb-4 border-red-200 px-4 py-3 text-sm text-red-700" role="alert">
          <p>{String(error.message || error)}</p>
          <p className="mt-1 text-xs text-slate-600" title={exactDate(at)}>
            The results below are the last that loaded, from {exactDate(at)}.
          </p>
          <button type="button" className="btn-ghost mt-2" onClick={onRetry}>Try again</button>
        </div>
      )}

      {!configured && (
        <div className="card mb-4 px-4 py-3 text-sm text-slate-700">
          No live preview is available without a prospect provider. The Saved, Recent and History tabs still work —
          they read from Harry’s own tables.
        </div>
      )}

      {configured && items.length === 0 && !loading && (
        <EmptyState
          icon="search"
          title={activeCount === 0 ? 'Add a filter to see who is out there' : 'Nothing matches those filters'}
          hint={activeCount === 0
            ? 'Start with a department or a job title on the left, then narrow by company size or location.'
            : 'The narrowest filter is usually the culprit — an exact-match toggle, a city, or an excluded title. Try removing one.'}
        />
      )}

      {items.length > 0 && (
        <div className={`transition-opacity ${loading ? 'opacity-50' : ''}`} aria-busy={loading}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>
              Showing {items.length.toLocaleString()} of {scaledCount(total)}
              {ticked.length > 0 && <span aria-live="polite"> · {ticked.length} selected</span>}
            </span>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-accent-500"
                checked={allTicked}
                onChange={() => setTicked(allTicked ? [] : items.map((i) => i.previewId))}
              />
              Select every row shown
            </label>
          </div>

          <p className="mb-2 text-[11px] text-slate-500">
            The email column is a preview, not a usable address. Fetching is what buys one.
          </p>

          {/* ≥640px: a real table with header scopes. */}
          <div className="card hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Preview of contacts matching the current filters</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-600">
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Select</span></th>
                  <th scope="col" className="px-3 py-2">Name</th>
                  <th scope="col" className="px-3 py-2">Title</th>
                  <th scope="col" className="px-3 py-2">Company</th>
                  <th scope="col" className="px-3 py-2">Location</th>
                  <th scope="col" className="px-3 py-2">Seniority</th>
                  <th scope="col" className="px-3 py-2">Email confidence</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.previewId} className="border-b border-slate-200 last:border-0">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent-500"
                        checked={ticked.includes(c.previewId)}
                        onChange={() => toggle(c.previewId)}
                        aria-label={`Select ${c.fullName || 'this contact'}`}
                      />
                    </td>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-ink-900">
                      {c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                    </th>
                    <td className="px-3 py-2 text-slate-700">{c.title || '—'}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {c.company?.name || '—'}
                      {c.company?.website && <span className="block text-[11px] text-slate-500">{c.company.website}</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {[c.city, c.state, c.country].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{c.level || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{deliverabilityWords(c.deliverability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* <640px: the same rows as stacked cards. */}
          <ul className="space-y-2 sm:hidden">
            {items.map((c) => (
              <li key={c.previewId} className="card px-3 py-2.5">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-accent-500"
                    checked={ticked.includes(c.previewId)}
                    onChange={() => toggle(c.previewId)}
                    aria-label={`Select ${c.fullName || 'this contact'}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-950">
                      {c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                    </span>
                    <span className="block truncate text-xs text-slate-700">{c.title || '—'}</span>
                    <span className="block truncate text-xs text-slate-600">{c.company?.name || '—'}</span>
                    <span className="block text-[11px] text-slate-500">
                      {[c.city, c.state, c.country].filter(Boolean).join(', ') || 'Location unknown'} ·{' '}
                      {deliverabilityWords(c.deliverability)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <LoadMore hasMore={Boolean(preview?.cursor)} loading={loading} onClick={onShowMore} />
        </div>
      )}
    </div>
  )
}

// ---- paste domains -----------------------------------------------------------

function PasteDomains({ existing, onKeep, onAnnounce }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const uid = useId()

  const parsed = useMemo(() => {
    const raw = text.split(/[\n,;\t]/).map((s) => s.trim()).filter(Boolean)
    const seen = new Set()
    const out = []
    for (const item of raw) {
      const d = normaliseDomain(item)
      if (d && !seen.has(d)) { seen.add(d); out.push(d) }
    }
    return { raw, normalised: out }
  }, [text])

  const over = parsed.normalised.length > MAX_ARRAY
  const nearArray = parsed.normalised.length >= ARRAY_WARN
  const batches = Math.ceil(parsed.normalised.length / MAX_RECONCILE)

  const check = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    const all = { matched: [], unknown: [], existing: [] }
    try {
      for (let i = 0; i < parsed.normalised.length; i += MAX_RECONCILE) {
        const slice = parsed.normalised.slice(i, i + MAX_RECONCILE)
        // Batched deliberately: one request per domain would be hundreds of calls.
        const res = await api.post('/api/prospects/filters/domains/reconcile', { domains: slice })
        all.matched.push(...(res.matched || []))
        all.unknown.push(...(res.unknown || []))
        all.existing.push(...(res.existing || []))
        const done = Math.min(i + MAX_RECONCILE, parsed.normalised.length)
        setProgress({ done, total: parsed.normalised.length })
        onAnnounce(`checked ${done} of ${parsed.normalised.length}`)
      }
      setResult(all)
    } catch (err) {
      const fault = fieldFault(err)
      setError(fault ? fault.message : String(err?.message || err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const keep = (list) => {
    const chips = list.map((d) => ({ key: d, label: d }))
    onKeep(uniqueChips([...existing, ...chips]).slice(0, MAX_ARRAY))
    onAnnounce(`Added ${list.length} domain(s) to the filter.`)
  }

  if (!open) {
    return (
      <button type="button" className="mt-2 cursor-pointer text-[11px] text-accent-700 underline" onClick={() => setOpen(true)}>
        Paste domains
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-slate-700" htmlFor={`${uid}-paste`}>Paste domains</label>
        <button type="button" className="cursor-pointer text-[11px] text-slate-600 hover:text-ink-900" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        One per line, or comma-separated. Each is lowercased, and the protocol, “www.” and any path are stripped
        before anything is checked.
      </p>
      <textarea
        id={`${uid}-paste`}
        className="input mt-1.5 min-h-28 font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'acme.com\nhttps://www.Globex.co.uk/pricing'}
      />

      {parsed.normalised.length > 0 && (
        <p className={`mt-1.5 text-[11px] ${over || nearArray ? 'text-amber-700' : 'text-slate-500'}`} role="status">
          {parsed.raw.length.toLocaleString()} pasted → {parsed.normalised.length.toLocaleString()} unique domain(s)
          {' '}after normalising.
          {batches > 1 && ` They will be checked in ${batches} batches of ${MAX_RECONCILE.toLocaleString()}.`}
          {nearArray && !over && ` This filter holds at most ${MAX_ARRAY.toLocaleString()} values — you are close to it.`}
          {over && ` That is over the ${MAX_ARRAY.toLocaleString()}-value maximum for this filter. Remove ${(parsed.normalised.length - MAX_ARRAY).toLocaleString()} before adding them.`}
        </p>
      )}

      {parsed.normalised.length > 0 && (
        <details className="mt-1.5 text-[11px] text-slate-600">
          <summary className="cursor-pointer">See what they normalised to</summary>
          <p className="mt-1 break-words font-mono text-slate-500">{parsed.normalised.slice(0, 50).join(', ')}
            {parsed.normalised.length > 50 && ` … and ${(parsed.normalised.length - 50).toLocaleString()} more`}
          </p>
        </details>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost" onClick={check} disabled={busy || !parsed.normalised.length || over}>
          {busy ? 'Checking…' : 'Check against the provider'}
        </button>
        {progress && (
          <span className="text-[11px] text-slate-600" aria-live="polite">
            checked {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error} Your pasted text is still here — nothing needs retyping.
        </p>
      )}

      {result && (
        <div className="mt-3 space-y-2 text-xs">
          {[
            ['matched', 'Known to the provider', result.matched],
            ['unknown', 'Not known to the provider', result.unknown],
            ['existing', 'Already in your leads', result.existing],
          ].map(([key, label, list]) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100/60 px-3 py-2">
              <span className="text-slate-700">{label}: {list.length.toLocaleString()}</span>
              {list.length > 0 && (
                <span className="flex gap-3">
                  <button type="button" className="cursor-pointer text-accent-700 underline" onClick={() => keep(list)}>
                    Keep all {list.length}
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer text-slate-600 underline"
                    onClick={() => setResult((r) => ({ ...r, [key]: [] }))}
                  >
                    Drop
                  </button>
                </span>
              )}
            </div>
          ))}
          <p className="text-slate-500">
            Nothing was dropped silently — every pasted domain is in exactly one of the three groups above.
          </p>
        </div>
      )}
    </div>
  )
}

// ---- bring a goal's audience into a filter -----------------------------------

// A goal already describes who it is aimed at, and the words in that description
// are the same ones the qualifier cites when it explains a score. Retyping them
// into a filter is both busywork and a chance to drift, so this reconciles them
// against the provider's vocabulary in one call and reports the result honestly:
// what the provider knows, and what it does not.
//
// The unmatched list is the reason this exists. Silently dropping a word the
// user wrote into their own goal would leave them searching for something
// narrower than they asked for without ever being told — so an unmatched value
// is shown, counted, and offered back as a keep-as-typed chip.
// `path` is the whole route for the same reason flatLoader takes one: a path
// assembled from a fragment is invisible to the requirements matrix's scan.
function FromGoal({ path, bodyKey, icpKey, noun, existing, onKeep, onAnnounce }) {
  const [open, setOpen] = useState(false)
  const [goals, setGoals] = useState(null)
  const [goalId, setGoalId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const uid = useId()

  useEffect(() => {
    if (!open || goals !== null) return
    api.get('/api/goals')
      .then((res) => setGoals(Array.isArray(res) ? res : (res?.items || [])))
      .catch((err) => setError(String(err?.message || err)))
  }, [open, goals])

  const chosen = (goals || []).find((g) => String(g.id) === String(goalId)) || null
  const values = useMemo(() => {
    const raw = chosen?.icp?.[icpKey]
    if (!Array.isArray(raw)) return []
    const seen = new Set()
    const out = []
    for (const item of raw) {
      const v = String(item || '').trim()
      const k = v.toLowerCase()
      if (!v || seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
    return out
  }, [chosen, icpKey])

  const check = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    const all = { matched: [], unmatched: [], configured: true, message: null }
    try {
      for (let i = 0; i < values.length; i += MAX_RECONCILE) {
        const slice = values.slice(i, i + MAX_RECONCILE)
        const res = await api.post(path, { [bodyKey]: slice })
        all.matched.push(...(res.matched || []))
        all.unmatched.push(...(res.unmatched || []))
        if (res.configured === false) {
          all.configured = false
          all.message = res.message || null
        }
      }
      setResult(all)
      onAnnounce(`${all.matched.length} of ${values.length} ${noun}s matched the provider's list.`)
    } catch (err) {
      const fault = fieldFault(err)
      setError(fault ? fault.message : String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  // Matched values carry the provider's own spelling; kept-as-typed ones carry
  // the user's. Both are marked so the chip row never implies the provider
  // validated a word it has never heard of.
  const keep = (list, free) => {
    const chips = list.map((v) => ({ key: v, label: v, free, note: 'from your goal' }))
    onKeep(uniqueChips([...existing, ...chips]).slice(0, MAX_ARRAY))
    onAnnounce(`Added ${list.length} ${noun}(s) from the goal to the filter.`)
  }

  if (!open) {
    return (
      <button type="button" className="mt-2 cursor-pointer text-[11px] text-accent-700 underline" onClick={() => setOpen(true)}>
        Bring {noun}s in from a goal
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-slate-700" htmlFor={`${uid}-goal`}>Bring {noun}s in from a goal</label>
        <button type="button" className="cursor-pointer text-[11px] text-slate-600 hover:text-ink-900" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Harry checks the goal's {noun}s against the provider's list. Ones it does not recognise are shown rather than
        dropped, so you decide what happens to them.
      </p>

      {goals === null && !error ? (
        <p className="mt-2 text-[11px] text-slate-600">Loading goals…</p>
      ) : (goals || []).length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-600">
          No goals yet. Create one on the Goals page and its audience becomes available here.
        </p>
      ) : (
        <>
          <select
            id={`${uid}-goal`}
            className="input mt-1.5"
            value={goalId}
            onChange={(e) => { setGoalId(e.target.value); setResult(null); setError(null) }}
          >
            <option value="">Choose a goal…</option>
            {(goals || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>

          {chosen && (
            <p className="mt-1.5 text-[11px] text-slate-600" role="status">
              {values.length === 0
                ? `This goal names no ${noun}s, so there is nothing to bring across.`
                : `${values.length.toLocaleString()} ${noun}(s) on this goal: ${values.slice(0, 8).join(', ')}${values.length > 8 ? ` … and ${values.length - 8} more` : ''}`}
            </p>
          )}

          <div className="mt-2">
            <button type="button" className="btn-ghost" onClick={check} disabled={busy || values.length === 0}>
              {busy ? 'Checking…' : 'Check against the provider'}
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error} The goal you picked is still selected — nothing needs redoing.
        </p>
      )}

      {result && (
        <div className="mt-3 space-y-2 text-xs">
          {result.configured === false && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
              {result.message || 'The prospect provider is not connected, so nothing could be checked against its list.'}
              {' '}Everything below is therefore unmatched.
            </p>
          )}
          {[
            ['matched', "Known to the provider", result.matched, false],
            ['unmatched', 'Not on the provider’s list', result.unmatched, true],
          ].map(([key, label, list, free]) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100/60 px-3 py-2">
              <span className="text-slate-700">{label}: {list.length.toLocaleString()}</span>
              {list.length > 0 && (
                <span className="flex gap-3">
                  <button type="button" className="cursor-pointer text-accent-700 underline" onClick={() => keep(list, free)}>
                    {free ? `Keep all ${list.length} as typed` : `Add all ${list.length}`}
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer text-slate-600 underline"
                    onClick={() => setResult((r) => ({ ...r, [key]: [] }))}
                  >
                    Drop
                  </button>
                </span>
              )}
            </div>
          ))}
          {result.unmatched.length > 0 && (
            <p className="break-words text-slate-500">
              Unmatched: {result.unmatched.slice(0, 20).join(', ')}
              {result.unmatched.length > 20 && ` … and ${result.unmatched.length - 20} more`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---- save dialog -------------------------------------------------------------

function SaveDialog({ filters, sel, onClose, onSaved }) {
  const suggestion = useMemo(() => {
    const parts = []
    if (sel.levelIds.length) parts.push(sel.levelIds.map((c) => c.label).join('/'))
    if (sel.departmentIds.length) parts.push(`in ${sel.departmentIds.map((c) => c.label).join(', ')}`)
    if (sel.countries.length) parts.push(sel.countries.map((c) => c.label).join(', '))
    if (sel.includeTitles.length && parts.length === 0) parts.push(sel.includeTitles.map((c) => c.label).join(', '))
    return parts.join(', ').slice(0, MAX_NAME) || 'All contacts'
  }, [sel])

  const [name, setName] = useState(suggestion)
  const [limit, setLimit] = useState(100)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fault, setFault] = useState(null)
  const [saved, setSaved] = useState(false)
  const [existing, setExisting] = useState([])

  useEffect(() => {
    api.get(`/api/prospects/searches${qs({ limit: 200, offset: 0 })}`)
      .then((res) => setExisting((res.items || []).map((i) => i.name)))
      .catch(() => setExisting([]))
  }, [])

  // A value in both an include and its matching exclude returns nothing and
  // looks like a provider fault, so it is named here before the call.
  const conflicts = useMemo(() => {
    const pairs = [
      ['includeTitles', 'excludeTitles', 'job titles'],
      ['includeCompanies', 'excludeCompanies', 'companies'],
      ['includeCompanyDomains', 'excludeCompanyDomains', 'company domains'],
    ]
    const out = []
    for (const [a, b, what] of pairs) {
      const right = new Set((filters[b] || []).map((v) => String(v).toLowerCase()))
      for (const v of filters[a] || []) {
        if (right.has(String(v).toLowerCase())) out.push(`“${v}” is in both the included and excluded ${what}`)
      }
    }
    return out
  }, [filters])

  const duplicate = existing.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())
  const near = name.length > MAX_NAME - 40

  const submit = async () => {
    setBusy(true)
    setError(null)
    setFault(null)
    try {
      const res = await api.post('/api/prospects/searches', { name: name.trim(), filters, limit })
      setSaved(true)
      // The provider's save carries no id; the listing is the resolution step,
      // so the dialog waits a beat on "Saved" and the Saved tab refreshes.
      setTimeout(() => onSaved(res), 700)
    } catch (err) {
      const f = fieldFault(err)
      if (f) setFault(f)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Save this search" onClose={onClose}>
      {saved ? (
        <p className="py-6 text-center text-sm text-accent-700" role="status">Saved</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="prospect-save-name">Name</label>
            <input
              id="prospect-save-name"
              className="input mt-1.5"
              value={name}
              maxLength={MAX_NAME}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fault?.field === 'name' ? true : undefined}
            />
            <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
              Suggested from your filters — edit it freely.
              {near && <span className="ml-2 text-amber-700">{name.length} of {MAX_NAME} characters</span>}
            </p>
            {duplicate && (
              <p className="mt-1 text-[11px] text-amber-700" role="status">
                You already have a saved search with that name. Saving will create a second one.
              </p>
            )}
            <FieldError fault={fault?.field === 'name' ? fault : null} />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="prospect-save-limit">Result limit</label>
            <p className="mt-0.5 text-[11px] text-slate-500">Between 1 and {MAX_SAVE_LIMIT.toLocaleString()}.</p>
            <input
              id="prospect-save-limit"
              type="number"
              min={1}
              max={MAX_SAVE_LIMIT}
              className="input mt-1.5"
              value={limit}
              onChange={(e) => {
                const n = Number(e.target.value)
                setLimit(Number.isFinite(n) ? Math.min(MAX_SAVE_LIMIT, Math.max(1, Math.round(n))) : 1)
              }}
            />
            <FieldError fault={fault?.field === 'limit' ? fault : null} />
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
              <p className="font-medium">This search contradicts itself and will return nothing:</p>
              <ul className="mt-1 list-disc pl-4">{conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}

          {fault && !['name', 'limit'].includes(fault.field) && (
            <p className="text-xs text-red-700" role="alert">{fault.message}</p>
          )}
          {error && <p className="text-xs text-red-700" role="alert">{String(error.message || error)}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save search'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---- fetch dialog ------------------------------------------------------------
//
// Nothing is fetched until this dialog is confirmed, and the confirmation names
// the count. A refusal for credit is HTTP 200 with `success: false` — rendered
// below as its own outcome with the provider's message and what it would have
// cost, never as a generic failure.

function FetchDialog({ searchId, totalCount, ticked, configured, analytics, onClose, onDone }) {
  const [mode, setMode] = useState(ticked.length ? 'selected' : 'count')
  const [count, setCount] = useState(Math.min(50, Math.max(1, totalCount || 1)))
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState(null)
  const [error, setError] = useState(null)
  const [outcome, setOutcome] = useState(null)

  const creditsAvailable = Number(analytics?.credits?.available ?? NaN)
  const singleCap = Number(analytics?.maxSingleFetchLimit ?? NaN)
  const dailyCap = Number(analytics?.maxDailyFetchLimit ?? NaN)
  const foundToday = Number(analytics?.foundToday ?? 0)
  const remainingToday = Number.isFinite(dailyCap) ? Math.max(0, dailyCap - foundToday) : NaN
  const unavailable = Boolean(analytics?.unavailable)

  // The lowest ceiling wins, and it is stated rather than silently applied.
  const caps = [MAX_FETCH_COUNT]
  if (Number.isFinite(singleCap) && singleCap > 0) caps.push(singleCap)
  if (Number.isFinite(remainingToday)) caps.push(remainingToday)
  if (unavailable) caps.push(100)   // conservative when the figures did not load
  const ceiling = Math.max(1, Math.min(...caps))

  const zeroCredits = Number.isFinite(creditsAvailable) && creditsAvailable <= 0
  const blockedReason = !configured
    ? 'No prospect provider is connected, so nothing can be fetched. Set PROSPECT_API_URL and PROSPECT_API_KEY.'
    : !searchId
      ? 'Run a preview first — the fetch is made against the search you are looking at.'
      : zeroCredits
        ? 'You have no email credits left, so this fetch cannot be made.'
        : remainingToday === 0
          ? 'Today’s fetch allowance is used up. This resets with your provider’s day.'
          : ''

  const submit = async () => {
    setBusy(true)
    setFault(null)
    setError(null)
    try {
      const body = mode === 'selected'
        ? { mode: 'selected', adaptIds: ticked }
        : { mode: 'count', count }
      const res = await api.post(`/api/prospects/searches/${searchId}/fetch`, body)
      setOutcome(res)
      onDone(res)
    } catch (err) {
      const f = fieldFault(err)
      if (f) setFault(f)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Get email addresses" onClose={onClose} wide>
      {outcome ? (
        <FetchOutcome outcome={outcome} onClose={onClose} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            This spends your provider’s credits. Nothing is fetched until you confirm below.
          </p>

          {/* Credits strip — in words, not a bar. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat
              label="Email credits"
              value={Number.isFinite(creditsAvailable) ? creditsAvailable.toLocaleString() : 'unknown'}
              hint={analytics?.credits?.total ? `of ${Number(analytics.credits.total).toLocaleString()}` : 'available now'}
              tone={zeroCredits ? 'bad' : undefined}
            />
            <Stat
              label="Left in today’s allowance"
              value={Number.isFinite(remainingToday) ? remainingToday.toLocaleString() : 'unknown'}
              hint={Number.isFinite(dailyCap) ? `${foundToday.toLocaleString()} of ${dailyCap.toLocaleString()} used today` : 'no daily cap reported'}
              tone={remainingToday === 0 ? 'bad' : undefined}
            />
            <Stat
              label="Most in one fetch"
              value={Number.isFinite(singleCap) && singleCap > 0 ? singleCap.toLocaleString() : MAX_FETCH_COUNT.toLocaleString()}
              hint="your provider’s single-fetch cap"
            />
          </div>

          {unavailable && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
              Your provider’s credit figures did not load, so the count below is capped at {ceiling} to be safe.
            </p>
          )}

          <fieldset>
            <legend className="text-xs font-medium text-slate-700">What to fetch</legend>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="fetch-mode"
                  className="mt-1 accent-accent-500"
                  checked={mode === 'count'}
                  onChange={() => setMode('count')}
                />
                <span>
                  The top matches
                  <span className="block text-[11px] text-slate-500">
                    Takes them in the provider’s own order from the {scaledCount(totalCount)} that match.
                  </span>
                </span>
              </label>
              {mode === 'count' && (
                <div className="pl-6">
                  <label className="block text-xs font-medium text-slate-700" htmlFor="prospect-fetch-count">
                    How many
                  </label>
                  <input
                    id="prospect-fetch-count"
                    type="number"
                    min={1}
                    max={ceiling}
                    className="input mt-1.5 max-w-40"
                    value={count}
                    aria-invalid={fault?.field?.includes('count') ? true : undefined}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      setCount(Number.isFinite(n) ? Math.min(ceiling, Math.max(1, Math.round(n))) : 1)
                    }}
                  />
                  <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
                    Between 1 and {ceiling.toLocaleString()} — the lowest of your single-fetch cap,
                    today’s remaining allowance and the {MAX_FETCH_COUNT.toLocaleString()} the endpoint permits.
                  </p>
                  <FieldError fault={fault?.field?.includes('count') ? fault : null} />
                </div>
              )}

              <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="fetch-mode"
                  className="mt-1 accent-accent-500"
                  checked={mode === 'selected'}
                  disabled={ticked.length === 0}
                  onChange={() => setMode('selected')}
                />
                <span>
                  The {ticked.length} people I ticked
                  <span className="block text-[11px] text-slate-500">
                    {ticked.length === 0
                      ? 'Tick rows in the preview to use this.'
                      : 'Only the rows ticked in the preview are fetched.'}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {blockedReason && (
            <p
              id="prospect-fetch-blocked"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              role="status"
            >
              {blockedReason}
            </p>
          )}

          {fault && !fault.field?.includes('count') && (
            <p className="text-xs text-red-700" role="alert">{fault.message}</p>
          )}
          {error && <p className="text-xs text-red-700" role="alert">{String(error.message || error)}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || Boolean(blockedReason) || (mode === 'selected' && ticked.length === 0)}
              aria-describedby={blockedReason ? 'prospect-fetch-blocked' : undefined}
            >
              {busy
                ? 'Fetching…'
                : mode === 'selected'
                  ? `Fetch ${ticked.length} contact${ticked.length === 1 ? '' : 's'}`
                  : `Fetch ${count.toLocaleString()} contact${count === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function FetchOutcome({ outcome, onClose }) {
  if (outcome.success === false) {
    // The documented credit outcome. Amber and explanatory, with the provider's
    // own words, because a retry cannot conjure credit and a red error would
    // invite one.
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          <p className="font-medium">The fetch was refused — nothing was charged and no lead was created.</p>
          <p className="mt-1 text-amber-800">{outcome.message || 'Your provider refused the fetch.'}</p>
          <p className="mt-2 text-xs text-amber-700">
            You asked for {Number(outcome.requested || 0).toLocaleString()} contact(s), which is what this would have
            cost in credits. The attempt is recorded in History as “insufficient credits”, so you can pick it up again
            once your provider has credit.
          </p>
        </div>
        <div className="flex justify-end">
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  const metrics = outcome.metrics || {}
  const keys = Object.keys(metrics)
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-300 bg-slate-100/60 px-4 py-3 text-sm text-ink-900" role="status">
        <p className="font-medium">
          Fetched {Number(outcome.fetched || 0).toLocaleString()} of {Number(outcome.requested || 0).toLocaleString()} requested.
        </p>
        <p className="mt-1 text-slate-700">
          {Number(outcome.leadsCreated || 0).toLocaleString()} new lead(s),
          {' '}{Number(outcome.leadsUpdated || 0).toLocaleString()} existing lead(s) filled in,
          {' '}{Number(outcome.skipped || 0).toLocaleString()} skipped for having no usable address.
        </p>
        {outcome.idempotent && (
          <p className="mt-1 text-xs text-slate-600">
            This was the same request as a moment ago, so the first result was returned rather than fetching twice.
          </p>
        )}
      </div>

      {keys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-slate-700">What your provider reported</h3>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {keys.map((k) => (
              <div key={k} className="flex justify-between gap-3 border-b border-slate-200 py-1">
                <dt className="text-slate-600">{humanKey(k)}</dt>
                <dd className="text-ink-900">{String(metrics[k])}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

// ---- recent tab --------------------------------------------------------------

function RecentTab({ onLoad }) {
  const list = useOffsetList('/api/prospects/searches/recent')

  if (list.loading && !list.items.length) return <Spinner label="Loading recent searches…" />
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />

  return (
    <div>
      <NotConnected status={list.status} what="Prospect search" />
      <p className="mb-3 text-xs text-slate-500">
        Clicking a row loads its filters into the form. It fetches nothing and costs nothing.
      </p>
      {list.items.length === 0 ? (
        <EmptyState icon="search" title="No recent searches yet" hint="Run a preview and it will appear here." />
      ) : (
        <ul className="space-y-2">
          {list.items.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onLoad(row)}
                className="card w-full cursor-pointer px-4 py-3 text-left hover:border-accent-500"
              >
                <span className="block text-sm font-medium text-ink-950">{row.name || row.summary}</span>
                <span className="block text-[11px] text-slate-500" title={exactDate(row.updatedAt)}>
                  {shortDate(row.updatedAt)}
                  {row.isSaved && ' · saved'}
                </span>
                <RawFilters filters={row.filters} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
    </div>
  )
}

// Any stored filter key Harry has no control for is listed as raw text, so
// reopening a search never silently drops part of it.
function RawFilters({ filters }) {
  const known = []
  const unknown = []
  for (const [key, value] of Object.entries(filters || {})) {
    const text = Array.isArray(value) ? value.slice(0, 3).join(', ') + (value.length > 3 ? '…' : '') : String(value)
    if (ARRAY_FIELDS.includes(key) || BOOL_FIELDS.includes(key)) known.push(`${humanKey(key)}: ${text}`)
    else unknown.push(`${key}: ${text}`)
  }
  if (!known.length && !unknown.length) return null
  return (
    <span className="mt-1.5 block text-[11px] text-slate-600">
      {known.join(' · ')}
      {unknown.length > 0 && (
        <span className="block text-amber-700">Not shown as a control: {unknown.join(' · ')}</span>
      )}
    </span>
  )
}

// ---- saved tab ---------------------------------------------------------------

function SavedTab({ onLoad, onReviewed, onAnnounce, toast }) {
  const list = useOffsetList('/api/prospects/searches')
  const [expanded, setExpanded] = useState(null)
  const [reviewing, setReviewing] = useState(null)
  const [reviews, setReviews] = useState({})

  const rename = async (row, name) => {
    await api.put(`/api/prospects/searches/${row.id}/name`, { name })
    list.setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, name } : r)))
    onAnnounce(`Renamed to “${name}”.`)
  }

  const review = async (row) => {
    setReviewing(row.id)
    try {
      const res = await api.patch(`/api/prospects/searches/${row.id}/review`)
      setReviews((prev) => ({ ...prev, [row.id]: res }))
      const before = Number(res.previousReview?.recordsUpdated ?? 0)
      const now = Number(res.recordsUpdated ?? 0)
      onAnnounce(now === 0
        ? 'Re-check finished — no changes.'
        : `Re-check finished — ${now} record(s) updated, previously ${before}. ${res.leadsFlagged} lead(s) flagged.`)
      list.setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, lastReviewedAt: res.reviewedAt } : r)))
      if (typeof onReviewed === 'function') onReviewed()
    } catch (err) {
      toast(String(err?.message || err), 'error')
    } finally {
      setReviewing(null)
    }
  }

  if (list.loading && !list.items.length) return <Spinner label="Loading saved searches…" />
  if (list.error) {
    return (
      <div>
        <ErrorState error={list.error} onRetry={list.reload} />
      </div>
    )
  }

  return (
    <div>
      <NotConnected status={list.status} what="Prospect search" />
      {list.items.length === 0 ? (
        <EmptyState
          icon="search"
          title="No saved searches yet"
          hint="Build an audience on the left and choose Save search to keep it."
        />
      ) : (
        <ul className="space-y-2">
          {list.items.map((row) => {
            const rv = reviews[row.id]
            return (
              <li key={row.id} className="card px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <InlineName value={row.name} label="Saved search name" onSave={(name) => rename(row, name)} />
                    <p className="mt-0.5 text-[11px] text-slate-500" title={exactDate(row.createdAt)}>
                      Saved {shortDate(row.createdAt)} by {row.createdBy}
                      {row.lastReviewedAt && (
                        <span title={exactDate(row.lastReviewedAt)}> · last re-checked {shortDate(row.lastReviewedAt)}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-ghost" onClick={() => onLoad(row)}>Load into the form</button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => review(row)}
                      disabled={reviewing === row.id}
                      aria-busy={reviewing === row.id}
                    >
                      {reviewing === row.id ? 'Re-checking…' : 'Re-check email quality'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      aria-expanded={expanded === row.id}
                      onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    >
                      {expanded === row.id ? 'Hide filters' : 'Show filters'}
                    </button>
                  </div>
                </div>

                {row.orphaned && (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800" role="status">
                    Your provider no longer has this search. Harry’s copy of the filters is intact — load it into the
                    form and save it again to recreate it.
                  </p>
                )}
                {!row.linked && !row.orphaned && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    Not yet linked to your provider, so it cannot be fetched from directly. Loading it into the form
                    and running a preview gives you a search you can fetch.
                  </p>
                )}

                {expanded === row.id && <RawFilters filters={row.filters} />}

                {rv && (
                  <div className="mt-2 rounded-lg bg-slate-100/60 px-3 py-2 text-[11px] text-slate-700" role="status">
                    <p>
                      {Number(rv.recordsUpdated || 0) === 0
                        ? 'no changes'
                        : `${rv.recordsUpdated} record(s) updated, previously ${rv.previousReview?.recordsUpdated ?? 0}`}
                      {' · '}
                      {Number(rv.leadsFlagged || 0) === 0
                        ? 'no leads flagged'
                        : `${rv.leadsFlagged} lead(s) now have an address that failed verification`}
                    </p>
                    <p className="text-slate-500" title={exactDate(rv.reviewedAt)}>Re-checked {shortDate(rv.reviewedAt)}</p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
    </div>
  )
}

// ---- history tab -------------------------------------------------------------

function HistoryTab({ onAnnounce, onOpenContacts, toast }) {
  const list = useOffsetList('/api/prospects/fetches')

  const rename = async (row, name) => {
    await api.put(`/api/prospects/fetches/${row.id}/name`, { name })
    list.setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, name } : r)))
    onAnnounce(`Renamed to “${name}”.`)
  }

  if (list.loading && !list.items.length) return <Spinner label="Loading fetch history…" />
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />

  return (
    <div>
      <NotConnected status={list.status} what="Prospect search" />
      {list.items.length === 0 ? (
        <EmptyState icon="leads" title="Nothing fetched yet" hint="Every fetch you make appears here with what it produced." />
      ) : (
        <ul className="space-y-2">
          {list.items.map((row) => (
            <li key={row.id} className="card px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <InlineName value={row.name} label="Fetched list name" onSave={(name) => rename(row, name)} />
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-600">
                    <span>{Number(row.fetched || 0).toLocaleString()} found of {Number(row.requested || 0).toLocaleString()} requested</span>
                    <span>· {Number(row.leadsCreated || 0).toLocaleString()} in your leads</span>
                    <span>· {Number(row.creditsUsed || 0).toLocaleString()} credit(s) used</span>
                    <span title={exactDate(row.createdAt)}>· {shortDate(row.createdAt)}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Status: {String(row.status).replace(/_/g, ' ')}
                    {row.status === 'insufficient_credits' && ' — nothing was charged and no lead was created'}
                  </p>
                  {row.error && <p className="mt-1 text-[11px] text-amber-700">{row.error}</p>}
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onOpenContacts(row)}
                  disabled={!row.searchId}
                >
                  View the contacts
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

// ---- contacts drawer ---------------------------------------------------------
//
// The contacts Harry already stored for a fetch. They read from Harry's own
// tables, so this panel works with no provider connected. There is no "add to
// leads" action because there is nothing to add: a fetch writes every usable
// address into Leads as it lands, and a contact without one is marked as such
// rather than offered as an import that would do nothing.

function ContactsDrawer({ row, onClose }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState(null)
  const [search, setSearch] = useState('')
  const [verification, setVerification] = useState('')
  const [catchAll, setCatchAll] = useState('')

  const load = useCallback(async (offset) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.post('/api/prospects/contacts', {
        filterId: row.searchId,
        limit: 50,
        offset,
        search: search || undefined,
        verificationStatus: verification || undefined,
        catchAllStatus: catchAll || undefined,
      })
      setItems((prev) => (offset ? [...prev, ...(res.items || [])] : (res.items || [])))
      setTotal(res.totalCount || 0)
      setHasMore(Boolean(res.pagination?.hasMore))
      setStatus(connectionStatus(res))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [row.searchId, search, verification, catchAll])

  useEffect(() => {
    const t = setTimeout(() => load(0), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [load])

  return (
    <Drawer title={row.name || 'Fetched contacts'} onClose={onClose}>
      <NotConnected status={status} what="Prospect search" />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs text-slate-600">
          Search by name
          <input
            className="input mt-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="First or last name"
          />
          <span className="mt-0.5 block text-[11px] text-slate-500">Names only — that is all this searches.</span>
        </label>
        <label className="text-xs text-slate-600">
          Verification
          <select className="input mt-1" value={verification} onChange={(e) => setVerification(e.target.value)}>
            <option value="">Any</option>
            {VERIFICATION_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          Email risk
          <select className="input mt-1" value={catchAll} onChange={(e) => setCatchAll(e.target.value)}>
            <option value="">Any</option>
            {CATCH_ALL_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="mt-4"><ErrorState error={error} onRetry={() => load(0)} /></div>}

      {!error && loading && items.length === 0 && <Spinner label="Loading contacts…" />}

      {!error && !loading && items.length === 0 && (
        <p className="mt-6 text-sm text-slate-600">
          {search || verification || catchAll ? 'No contacts match that name' : 'This search has no contacts yet'}
        </p>
      )}

      {items.length > 0 && (
        <>
          <div className="mt-4 hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Contacts fetched for {row.name}</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-600">
                  <th scope="col" className="px-2 py-2">Name</th>
                  <th scope="col" className="px-2 py-2">Title</th>
                  <th scope="col" className="px-2 py-2">Company</th>
                  <th scope="col" className="px-2 py-2">Email</th>
                  <th scope="col" className="px-2 py-2">Verification</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-b border-slate-200 last:border-0">
                    <th scope="row" className="px-2 py-2 text-left font-medium text-ink-900">{c.fullName || '—'}</th>
                    <td className="px-2 py-2 text-slate-700">{c.title || '—'}</td>
                    <td className="px-2 py-2 text-slate-700">
                      {c.company?.name || '—'}
                      {c.company?.website && <span className="block text-[11px] text-slate-500">{c.company.website}</span>}
                    </td>
                    <td className="px-2 py-2 text-slate-700">
                      {c.email || <span className="text-slate-500">no usable address</span>}
                      {c.alreadyInLeads && <span className="block text-[11px] text-accent-700">Already in your leads</span>}
                    </td>
                    <td className="px-2 py-2 text-slate-600">
                      {c.verificationStatus ? String(c.verificationStatus).replace(/_/g, ' ') : 'not checked'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-4 space-y-2 sm:hidden">
            {items.map((c) => (
              <li key={c.id} className="card px-3 py-2.5 text-sm">
                <p className="font-medium text-ink-950">{c.fullName || '—'}</p>
                <p className="text-[11px] text-slate-600">
                  {c.verificationStatus ? String(c.verificationStatus).replace(/_/g, ' ') : 'not checked'}
                  {c.alreadyInLeads && ' · already in your leads'}
                </p>
                <p className="truncate text-xs text-slate-700">{c.email || 'no usable address'}</p>
                <p className="truncate text-xs text-slate-600">{c.title || '—'} · {c.company?.name || '—'}</p>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-slate-500">
            Showing {items.length.toLocaleString()} of {total.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Every usable address here was written into Leads when it was fetched — there is nothing left to import.
          </p>
          <LoadMore hasMore={hasMore} loading={loading} onClick={() => load(items.length)} />
        </>
      )}
    </Drawer>
  )
}
