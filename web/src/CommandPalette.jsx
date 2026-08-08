// ⌘K — one search box over everything the workspace holds.
//
// Roughly 200 endpoints landed behind nine navigation items, which is the right
// trade for the sidebar and the wrong one for anybody who knows the name of the
// thing but not which page owns it. This is the escape hatch: type a lead's
// email, a campaign's name, a label, a placement test, and go straight there.
//
// The component is fully controlled — App.jsx owns the shortcut and the open
// flag, so there is no global key listener here. Everything this file binds is
// scoped to the dialog, which is what lets the shell decide when ⌘K is live
// (never while a text editor has focus, for instance) without this file
// knowing anything about it.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, qs } from './api.js'
import { Icon, LiveRegion, rowsOf } from './parity-ui.jsx'

const DEBOUNCE_MS = 200
const PER_SOURCE = 6

// ------------------------------------------------------------ navigation ----

// The static half of the palette: what makes it useful before a single
// character is typed. Deep destinations are spelled out ("Settings → Never
// contact") because the whole point is that you should not have to know a
// section lives inside Settings to reach it.
//
// `keywords` carries the words people actually type for a surface but which do
// not appear in its label — "unsubscribe" for the block list, "warmup" for
// mailboxes. They match, they are never displayed.
const NAV_COMMANDS = [
  { id: 'nav:dashboard', title: 'Go to Dashboard', to: '/app', keywords: 'home overview today' },
  { id: 'nav:goals', title: 'Go to Goals', to: '/app/goals', keywords: 'targets objectives' },
  { id: 'nav:campaigns', title: 'Go to Campaigns', to: '/app/campaigns', keywords: 'sequences playbooks' },
  { id: 'nav:inbox', title: 'Go to Inbox', to: '/app/inbox', keywords: 'replies conversations threads' },
  { id: 'nav:inbox-snoozed', title: 'Go to Inbox → Snoozed', to: '/app/inbox?state=snoozed', keywords: 'later reminders' },
  { id: 'nav:leads', title: 'Go to Leads', to: '/app/leads', keywords: 'prospects people contacts' },
  { id: 'nav:reports', title: 'Go to Reports', to: '/app/reports', keywords: 'analytics stats numbers' },
  { id: 'nav:reports-campaigns', title: 'Go to Reports → Campaigns', to: '/app/reports?tab=campaigns', keywords: 'analytics performance' },
  { id: 'nav:reports-mailboxes', title: 'Go to Reports → Mailboxes', to: '/app/reports?tab=mailboxes', keywords: 'analytics sending domains' },
  { id: 'nav:reports-replies', title: 'Go to Reports → Replies', to: '/app/reports?tab=replies', keywords: 'analytics categories sentiment' },
  { id: 'nav:reports-clients', title: 'Go to Reports → Clients', to: '/app/reports?tab=clients', keywords: 'analytics agency accounts' },
  { id: 'nav:reports-team', title: 'Go to Reports → Team', to: '/app/reports?tab=team', keywords: 'analytics users seats' },
  { id: 'nav:monitoring', title: 'Go to Monitoring', to: '/app/monitoring', keywords: 'health status uptime incidents' },
  { id: 'nav:placement', title: 'Go to Monitoring → Inbox placement', to: '/app/monitoring', keywords: 'deliverability spam seed test blacklist' },
  { id: 'nav:mailboxes', title: 'Go to Mailboxes', to: '/app/mailboxes', keywords: 'senders accounts warmup smtp imap fleet' },
  { id: 'nav:mailboxes-attention', title: 'Go to Mailboxes → Needs attention', to: '/app/mailboxes?health=attention', keywords: 'broken sending failing smtp' },
  { id: 'nav:settings', title: 'Go to Settings', to: '/app/settings/briefing', keywords: 'profile briefing voice preferences' },
  { id: 'nav:settings-sending', title: 'Go to Settings → Sending', to: '/app/settings/sending', keywords: 'send controls hours pacing caps limits quiet hours holds bounces' },
  { id: 'nav:settings-block', title: 'Go to Settings → Never contact', to: '/app/settings/never-contact', keywords: 'block list suppression unsubscribe do not email blocked domains' },
  { id: 'nav:settings-alerts', title: 'Go to Settings → Alerts', to: '/app/settings/alerts', keywords: 'slack teams notifications channel' },
  { id: 'nav:settings-clients', title: 'Go to Settings → Clients', to: '/app/settings/team', keywords: 'agency accounts api keys team invite coach' },
  { id: 'nav:settings-webhooks', title: 'Go to Settings → Webhooks', to: '/app/settings/alerts', keywords: 'events integrations callbacks' },
  { id: 'nav:settings-integrations', title: 'Go to Settings → Connections', to: '/app/settings/connections', keywords: 'providers connect optional google sheet' },
]

// ---------------------------------------------------------------- sources ----

// One entry per searchable kind. `rows` exists because the API's list envelope
// is not quite uniform: rowsOf() covers `{items}`, `{data}` and a bare array,
// but /api/campaign-list answers `{campaigns}`, so that one unwraps itself here
// rather than teaching the shared helper a key only this file needs.
//
// `local: true` marks a source whose route takes no `q` — clients and labels
// are both small, workspace-wide lists with no server-side search — so it is
// fetched once per open and filtered in the browser. That is also why they are
// cheap enough to keep in the same parallel batch as the searching routes.
const SOURCES = [
  {
    kind: 'campaigns',
    group: 'Campaigns',
    order: 0,
    load: (q) => api.get(`/api/campaign-list${qs({ q, limit: PER_SOURCE })}`),
    rows: (res) => (Array.isArray(res?.campaigns) ? res.campaigns : rowsOf(res)),
    map: (c) => ({
      id: `campaign:${c.id}`,
      title: c.name || `Campaign ${c.id}`,
      meta: c.state || c.status || '',
      to: `/app/campaigns/${c.id}`,
    }),
  },
  {
    kind: 'leads',
    group: 'Leads',
    order: 1,
    // server/routes.js answers this one with a bare array of lead rows.
    load: (q) => api.get(`/api/leads${qs({ q })}`),
    map: (l) => ({
      id: `lead:${l.id}`,
      title: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email,
      meta: [l.email, l.company, l.title].filter(Boolean).join(' · '),
      to: '/app/leads',
    }),
  },
  {
    kind: 'segments',
    group: 'Segments',
    order: 2,
    load: (q) => api.get(`/api/lead-lists${qs({ q, limit: PER_SOURCE })}`),
    map: (s) => ({
      id: `segment:${s.id}`,
      title: s.name,
      meta: `${s.leadCount ?? 0} lead${s.leadCount === 1 ? '' : 's'}`,
      to: '/app/leads',
    }),
  },
  {
    kind: 'mailboxes',
    group: 'Mailboxes',
    order: 3,
    load: (q) => api.get(`/api/mailboxes/fleet${qs({ q, limit: PER_SOURCE })}`),
    map: (m) => ({
      id: `mailbox:${m.id}`,
      title: m.fromEmail || m.fromName || `Mailbox ${m.id}`,
      meta: [m.fromName, m.provider].filter(Boolean).join(' · '),
      // The fleet reads its filters straight off the query string, so naming
      // the mailbox lands on a one-row list rather than the whole fleet.
      to: `/app/mailboxes${qs({ q: m.fromEmail || '' })}`,
    }),
  },
  {
    kind: 'tests',
    group: 'Placement tests',
    order: 4,
    load: (q) => api.get(`/api/deliverability/tests${qs({ q, limit: PER_SOURCE })}`),
    map: (t) => ({
      id: `test:${t.id}`,
      title: t.name || `Test ${t.id}`,
      meta: [t.type, t.status].filter(Boolean).join(' · '),
      to: `/app/monitoring${qs({ ipTest: t.id })}`,
    }),
  },
  {
    kind: 'clients',
    group: 'Clients',
    order: 5,
    local: true,
    // GET /api/clients takes status/limit/cursor and no search parameter at
    // all — the switcher it was written for gets the whole list — so the
    // filtering below is ours, not the server's.
    load: () => api.get(`/api/clients${qs({ limit: 200 })}`),
    map: (c) => ({
      id: `client:${c.id}`,
      title: c.name,
      meta: c.email || '',
      to: '/app/settings/team',
    }),
  },
  {
    kind: 'tags:lead',
    group: 'Labels',
    order: 6,
    local: true,
    load: () => api.get(`/api/tags${qs({ appliesTo: 'lead' })}`),
    map: (t) => ({
      id: `tag-lead:${t.id}`,
      title: t.name,
      meta: `lead label · ${t.usageCount ?? 0} in use`,
      to: '/app/leads',
    }),
  },
  {
    kind: 'tags:mailbox',
    group: 'Labels',
    order: 6,
    local: true,
    load: () => api.get(`/api/tags${qs({ appliesTo: 'mailbox' })}`),
    map: (t) => ({
      id: `tag-mailbox:${t.id}`,
      title: t.name,
      meta: `mailbox label · ${t.usageCount ?? 0} in use`,
      to: '/app/mailboxes',
    }),
  },
]

// --------------------------------------------------------------- ranking ----

// A name that starts with what you typed should beat a name that merely
// contains it, and a word boundary beats mid-word — otherwise "acme" ranks
// "Placement: teacme-relay" above the Acme campaign. Zero means no match.
function score(text, term) {
  if (!text) return 0
  const t = String(text).toLowerCase()
  const at = t.indexOf(term)
  if (at < 0) return 0
  if (t === term) return 100
  if (at === 0) return 80
  return /[\s@._\-/,·]/.test(t[at - 1]) ? 60 : 40
}

function rank(option, term) {
  // The meta line matches too (an email, a company, a status) but scores lower,
  // so a title hit always sorts above a subtitle hit.
  return Math.max(score(option.title, term), score(option.meta, term) * 0.5, score(option.keywords, term) * 0.4)
}

// ------------------------------------------------------------- the dialog ----

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate()
  const baseId = useId()
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const dialogRef = useRef(null)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState([])       // ranked options from the API
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)       // every source failed
  const [degraded, setDegraded] = useState(0)    // some sources failed

  // Newer keystrokes must win regardless of which response lands first, so
  // every batch carries a sequence number and a stale batch is dropped rather
  // than merged. Without this, a slow /leads answer overwrites the results for
  // a query the person has already moved on from.
  const seqRef = useRef(0)
  // The no-`q` sources are fetched once per open and reused; the promise is
  // cached, not the value, so two keystrokes in flight share one request.
  const onceRef = useRef(new Map())
  // Whatever had focus before the palette opened, so closing puts it back.
  const returnToRef = useRef(null)

  const term = query.trim().toLowerCase()

  // ---- open / close lifecycle ----
  useEffect(() => {
    if (!open) return undefined
    returnToRef.current = document.activeElement
    inputRef.current?.focus()
    return () => {
      // Reset on close rather than on open: a palette that reopens showing the
      // previous query's results for a heartbeat looks like a bug.
      setQuery('')
      setActive(0)
      setRemote([])
      setError(null)
      setDegraded(0)
      setLoading(false)
      seqRef.current++
      onceRef.current.clear()
      const back = returnToRef.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [open])

  // ---- search ----
  const fetchSource = useCallback((source, q) => {
    if (!source.local) return source.load(q)
    if (!onceRef.current.has(source.kind)) onceRef.current.set(source.kind, source.load())
    return onceRef.current.get(source.kind)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    if (!term) {
      setRemote([])
      setLoading(false)
      setError(null)
      setDegraded(0)
      return undefined
    }
    setLoading(true)
    const timer = setTimeout(() => {
      const seq = ++seqRef.current
      // allSettled, not all: one broken source should cost that source's rows,
      // not the whole palette.
      Promise.allSettled(SOURCES.map((s) => fetchSource(s, term))).then((settled) => {
        if (seq !== seqRef.current) return
        const options = []
        let failed = 0
        settled.forEach((outcome, i) => {
          const source = SOURCES[i]
          if (outcome.status === 'rejected') {
            // A cached rejection must not stick around as a permanent hole.
            if (source.local) onceRef.current.delete(source.kind)
            failed++
            return
          }
          const rows = (source.rows ? source.rows(outcome.value) : rowsOf(outcome.value)).slice(0, source.local ? 200 : PER_SOURCE)
          for (const row of rows) {
            const option = { ...source.map(row), group: source.group, order: source.order }
            const s = rank(option, term)
            // A source that filtered server-side has already agreed the row
            // matches; only the local ones need the score as a gate.
            if (s === 0 && source.local) continue
            options.push({ ...option, score: s || 30 })
          }
        })
        // The local sources return everything they have — cap them after
        // ranking so what survives is the best few, not the first few.
        const trimmed = []
        const perGroup = new Map()
        for (const o of options.sort((a, b) => b.score - a.score)) {
          const n = perGroup.get(o.group) || 0
          if (n >= PER_SOURCE) continue
          perGroup.set(o.group, n + 1)
          trimmed.push(o)
        }
        setRemote(trimmed)
        setDegraded(failed)
        setError(failed === SOURCES.length ? new Error('Nothing could be searched — is the server running?') : null)
        setLoading(false)
        setActive(0)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, term, fetchSource])

  // ---- the rendered list ----
  const groups = useMemo(() => {
    const nav = NAV_COMMANDS
      .map((c) => ({ ...c, group: 'Navigation', order: 99, score: term ? rank(c, term) : 50 }))
      .filter((c) => !term || c.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, term ? 5 : NAV_COMMANDS.length)

    const byGroup = new Map()
    for (const option of [...remote, ...nav]) {
      if (!byGroup.has(option.group)) byGroup.set(option.group, [])
      byGroup.get(option.group).push(option)
    }
    return [...byGroup.entries()]
      .map(([label, options]) => ({
        label,
        options: options.sort((a, b) => b.score - a.score),
        best: Math.max(...options.map((o) => o.score)),
        order: options[0].order,
      }))
      // Ranked by the strongest hit in the group, with the source order as the
      // tiebreak so the list does not reshuffle between equally good keystrokes.
      .sort((a, b) => b.best - a.best || a.order - b.order)
  }, [remote, term])

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups])
  const activeOption = flat[Math.min(active, flat.length - 1)] || null
  const activeDomId = activeOption ? `${baseId}-${activeOption.id}` : undefined

  // Keep the active row on screen when the arrows walk past the fold. The rows
  // register themselves rather than being looked up by id — option ids contain
  // colons, which an attribute selector would have to escape.
  const rowRefs = useRef(new Map())
  useEffect(() => {
    if (!activeOption) return
    rowRefs.current.get(activeOption.id)?.scrollIntoView({ block: 'nearest' })
  }, [activeOption])

  const choose = useCallback((option) => {
    if (!option) return
    onClose()
    navigate(option.to)
  }, [navigate, onClose])

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      // aria-modal promises focus stays inside, so it has to actually stay
      // inside. The dialog holds two focusables; this wraps between them.
      const focusable = dialogRef.current?.querySelectorAll('input, button, [href], [tabindex]:not([tabindex="-1"])')
      if (!focusable?.length) return
      const list = [...focusable]
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      return
    }
    if (!flat.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % flat.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + flat.length) % flat.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(flat.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(activeOption)
    }
  }

  if (!open) return null

  const listboxId = `${baseId}-listbox`
  const showEmpty = !loading && !error && flat.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 sm:items-start sm:p-4 sm:pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Under 640px this is the whole screen, not a card floating on one. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onKeyDown={onKeyDown}
        className="flex h-full w-full flex-col border-slate-200 bg-white shadow-2xl sm:h-auto sm:max-h-[70vh] sm:max-w-2xl sm:rounded-xl sm:border"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
          <span className="text-slate-500" aria-hidden><Icon name="search" className="size-4" /></span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={activeDomId}
            aria-autocomplete="list"
            aria-label="Search leads, campaigns, segments, mailboxes, clients, labels and placement tests"
            autoComplete="off"
            spellCheck="false"
            placeholder="Search everything, or jump to a page…"
            className="w-full bg-transparent text-sm text-ink-950 placeholder:text-slate-500 focus:outline-none"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          />
          <kbd className="hidden shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-500 sm:inline">Esc</kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="shrink-0 cursor-pointer rounded px-2 text-xl leading-none text-slate-600 hover:text-ink-900 sm:hidden"
          >
            ×
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain py-2">
          {loading && (
            <p className="px-4 py-6 text-center text-sm text-slate-600">Searching…</p>
          )}

          {error && (
            <p className="px-4 py-6 text-center text-sm text-red-700">{error.message}</p>
          )}

          {showEmpty && (
            <p className="px-4 py-6 text-center text-sm text-slate-600">
              {term ? <>Nothing matches “{query.trim()}”.</> : 'Type to search.'}
            </p>
          )}

          {!loading && !error && flat.length > 0 && (
            <ul role="listbox" id={listboxId} aria-label="Search results">
              {groups.map((group) => (
                <li key={group.label} role="presentation">
                  {/* The group is text, always. Nothing here is distinguished
                      by colour alone. */}
                  <div
                    role="presentation"
                    className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {group.label}
                  </div>
                  <ul role="presentation">
                    {group.options.map((option) => {
                      const isActive = activeOption?.id === option.id
                      return (
                        <li
                          key={option.id}
                          id={`${baseId}-${option.id}`}
                          ref={(el) => {
                            if (el) rowRefs.current.set(option.id, el)
                            else rowRefs.current.delete(option.id)
                          }}
                          role="option"
                          aria-selected={isActive}
                          onMouseMove={() => setActive(flat.indexOf(option))}
                          onClick={() => choose(option)}
                          className={`mx-2 flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-2 text-sm ${
                            isActive ? 'bg-slate-200 text-ink-950' : 'text-slate-700'
                          }`}
                        >
                          <span className="truncate font-medium">{option.title}</span>
                          {option.meta && (
                            <span className="truncate text-xs text-slate-500">{option.meta}</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {degraded > 0 && !error && (
            <p className="px-4 pb-2 pt-3 text-xs text-amber-700">
              {degraded} of {SOURCES.length} sources could not be searched — these results are incomplete.
            </p>
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 sm:flex">
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>

      <LiveRegion
        message={loading ? 'Searching' : error ? error.message : term && flat.length === 0
          ? `Nothing matches ${query.trim()}`
          : flat.length ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : ''}
      />
    </div>
  )
}
