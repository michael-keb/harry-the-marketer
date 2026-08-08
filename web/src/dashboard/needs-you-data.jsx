// The four things that can need a person, normalised into one list.
//
// "What needs me?" used to have four answers on three pages: drafts waiting for
// an OK in the Inbox, leads parked for a decision in the Dashboard's Action
// Center, open tasks behind a tab on Leads, and reminders behind another tab on
// the Inbox. Each was correct; together they were a scavenger hunt. This file
// is the arithmetic that lets one list answer the question, and it lives apart
// from the section that renders it so the interesting part — four envelopes,
// four notions of "when", and one ordering that has to be defensible out loud —
// can be argued with on its own.
//
// The rule that shapes everything below: a count must never be a lie. Each
// source carries its own status, and a source that failed reports `null` for
// its count rather than 0. A silent 0 here reads as "nothing to do", and the
// person stops checking.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { rowsOf } from '../parity-ui.jsx'

// ---------------------------------------------------------------- time -------

// The older routes hand back SQLite's `2026-08-07 09:12:33` (UTC, no zone); the
// parity routes hand back real ISO. One parser, so a draft written by one and a
// reminder written by the other can be compared at all — the ordering below is
// worthless if half the timestamps land in 1970 or in local time by accident.
export function toMs(value) {
  if (!value) return null
  const s = String(value)
  const ms = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? null : ms
}

// `timeAgo` in ui.jsx only looks backwards — a due date next Tuesday comes out
// of it as "just now". This queue holds both past and future moments, so it
// needs a phrase that can say which side of now it is on.
export function whenPhrase(value) {
  const ms = toMs(value)
  if (ms === null) return ''
  const mins = Math.round((ms - Date.now()) / 60000)
  const behind = mins < 0
  const n = Math.abs(mins)
  if (n < 1) return 'just now'
  const span = n < 60 ? `${n}m` : n < 1440 ? `${Math.round(n / 60)}h` : `${Math.round(n / 1440)}d`
  return behind ? `${span} ago` : `in ${span}`
}

// The absolute moment, for a title attribute and for the screen-reader text —
// "3d ago" is easy to scan and impossible to act on.
export function absoluteWhen(value) {
  const ms = toMs(value)
  if (ms === null) return ''
  return new Date(ms).toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
}

// ------------------------------------------------------------- ordering ------

// Four bands, largest claim on a person first. Within a band everything sorts
// by an ascending timestamp, so "oldest / soonest at the top" is one rule
// rather than four. The bands are stated on screen in the same words used
// here — a sort nobody can describe is a sort nobody trusts.
export const BAND = { LATE: 0, BLOCKED: 1, DATED: 2, UNDATED: 3 }

export const SORT_EXPLAINER =
  'Sorted by urgency: anything already late first, longest overdue at the top — then work blocked on your decision, longest wait first — then what falls due next. Tasks with no due date sit last; they are undated, not urgent.'

// ------------------------------------------------------------- sources -------

export const SOURCE_IDS = ['approval', 'decision', 'task', 'reminder']

export const SOURCE_META = {
  approval: {
    label: 'Approvals',
    // Said in words on every row and in every accessible name. Nothing in this
    // queue is identifiable by colour alone.
    noun: (n) => `${n} email${n === 1 ? '' : 's'} waiting for your OK`,
    home: 'Inbox → Needs your OK',
  },
  decision: {
    label: 'Decisions',
    noun: (n) => `${n} lead${n === 1 ? '' : 's'} parked for your decision`,
    home: 'Dashboard → the leads the agent parked',
  },
  task: {
    label: 'Tasks',
    noun: (n) => `${n} open task${n === 1 ? '' : 's'}`,
    home: 'Leads → Tasks',
  },
  reminder: {
    label: 'Reminders',
    noun: (n) => `${n} reminder${n === 1 ? '' : 's'} now due`,
    home: 'Inbox → Reminders',
  },
}

// ---------------------------------------------------------- normalisers ------

function personName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || row.lead_email || ''
}

function fromDraft(d) {
  const who = personName(d)
  return {
    key: `approval-${d.id}`,
    source: 'approval',
    // The kind, in words, on the row itself.
    kind: 'An email waiting for your OK',
    headline: d.subject || '(no subject)',
    who,
    context: d.campaign_name || '',
    // A paused campaign cannot send, so approving it would look broken. Say so
    // before the click, not after it.
    note: d.campaign_status && d.campaign_status !== 'running'
      ? `That campaign is ${d.campaign_status} — resume it before this can go out.`
      : '',
    band: BAND.BLOCKED,
    order: toMs(d.created_at) ?? 0,
    at: d.created_at,
    atLabel: `written ${whenPhrase(d.created_at)}`,
    late: false,
    raw: d,
  }
}

function fromDecision(row) {
  const who = personName(row)
  const broke = row.state === 'error'
  return {
    key: `decision-${row.id}`,
    source: 'decision',
    kind: broke ? 'A lead stopped on an error' : 'A lead parked for your decision',
    headline: who,
    who,
    context: row.campaign_name || '',
    note: broke
      ? (row.error || 'The step failed and the lead is holding at this node.')
      : `The reply was read as “${row.intent}” and no playbook edge matches it. Reclassify it from the Inbox, or resume to keep waiting.`,
    band: BAND.BLOCKED,
    order: toMs(row.updated_at) ?? 0,
    at: row.updated_at,
    atLabel: `parked ${whenPhrase(row.updated_at)}`,
    late: false,
    raw: row,
  }
}

function fromTask(t) {
  const due = toMs(t.dueAt)
  // `overdue` is decided by the server and never stored, so it cannot drift —
  // the band follows it rather than re-deciding lateness in the browser.
  const band = t.overdue ? BAND.LATE : due === null ? BAND.UNDATED : BAND.DATED
  return {
    key: `task-${t.id}`,
    source: 'task',
    kind: t.overdue ? 'An overdue task' : due === null ? 'A task with no due date' : 'A task, not yet due',
    headline: t.title,
    who: '',
    leadId: t.leadId,
    context: t.campaign?.name || '',
    note: t.body || '',
    band,
    order: due ?? toMs(t.createdAt) ?? 0,
    at: t.dueAt,
    atLabel: t.dueAt ? `due ${whenPhrase(t.dueAt)}` : 'no due date',
    late: Boolean(t.overdue),
    raw: t,
  }
}

function fromReminder(r) {
  return {
    key: `reminder-${r.id}`,
    source: 'reminder',
    kind: 'A reminder that has come due',
    headline: r.note || '(no note)',
    who: '',
    leadId: r.lead_id,
    context: '',
    note: r.created_by ? `Set by ${r.created_by}.` : '',
    band: BAND.LATE,
    order: toMs(r.reminder_at) ?? 0,
    at: r.reminder_at,
    atLabel: `was due ${whenPhrase(r.reminder_at)}`,
    late: r.is_overdue !== false,
    raw: r,
  }
}

// ------------------------------------------------------------- fetchers ------

const FETCHERS = {
  // `GET /api/drafts` answers `{ requireApproval, drafts }` — neither of the two
  // envelopes `rowsOf()` knows about — so it is unwrapped by name here, with
  // rowsOf as the fallback if that route ever joins the others.
  approval: async () => {
    const res = await api.get('/api/drafts')
    const rows = Array.isArray(res?.drafts) ? res.drafts : rowsOf(res)
    return { items: rows.map(fromDraft), meta: { requireApproval: Boolean(res?.requireApproval) } }
  },
  // Every open task, the same filter the Leads → Tasks tab opens on, so the two
  // can never disagree about what is outstanding. `counts.open` is the whole
  // workspace's true number; the rows are the first page of it.
  task: async () => {
    const res = await api.get(`/api/tasks${qs({ status: 'open', limit: 50 })}`)
    return {
      items: rowsOf(res).map(fromTask),
      meta: { trueCount: res?.counts?.open ?? null, hasMore: Boolean(res?.hasMore) },
    }
  },
  // Only reminders that have actually come due. A reminder set for next week is
  // not something that needs you now, and putting it here would make the queue
  // the thing people learn to ignore.
  reminder: async () => {
    const res = await api.get(`/api/reminders${qs({ status: 'pending', due: 'overdue', limit: 50 })}`)
    return { items: rowsOf(res).map(fromReminder), meta: { hasMore: Boolean(res?.hasMore) } }
  },
}

const BLANK = { status: 'loading', error: null, items: [], meta: null }

// The count a tab may show. `null` means "we do not know" and must be rendered
// as such — never coerced to 0 further up.
export function countOf(entry) {
  if (!entry || entry.status !== 'ok') return null
  return entry.meta?.trueCount ?? entry.items.length
}

// ---------------------------------------------------------------- hook -------

// Reminders and tasks carry lead ids, not names. One best-effort lookup turns
// "Lead #42" into a person; if it fails the rows still render with the id,
// which is why this never becomes a source status of its own.
function useLeadNames(needed) {
  const [names, setNames] = useState(null)
  useEffect(() => {
    if (!needed || names) return
    let live = true
    api.get('/api/leads')
      .then((res) => {
        if (!live) return
        const rows = Array.isArray(res) ? res : rowsOf(res)
        setNames(Object.fromEntries(rows.map((l) => [l.id, personName({ ...l, lead_email: l.email })])))
      })
      .catch(() => { /* rows fall back to the lead id */ })
    return () => { live = false }
  }, [needed, names])
  return names || {}
}

/**
 * The queue's data layer.
 *
 * `decisions` arrives as a prop rather than a fifth fetch: the Dashboard
 * already polls `GET /api/dashboard` for its KPIs and the parked leads ride
 * along in that payload. That also means the decisions source cannot be in a
 * half-failed state here — if it failed the whole page is an ErrorState — so it
 * is reported as `ok` and refreshed through the parent's loader.
 */
export function useNeedsYou(decisions, onReloadDecisions) {
  const [remote, setRemote] = useState(() => ({ approval: BLANK, task: BLANK, reminder: BLANK }))
  const pausedRef = useRef(false)

  const loadSource = useCallback(async (source) => {
    if (source === 'decision') return onReloadDecisions?.()
    try {
      const { items, meta } = await FETCHERS[source]()
      setRemote((prev) => ({ ...prev, [source]: { status: 'ok', error: null, items, meta } }))
    } catch (error) {
      // The items are dropped deliberately: showing a stale list beside a live
      // count is how a queue starts lying. Unknown is the honest state.
      setRemote((prev) => ({ ...prev, [source]: { status: 'error', error, items: [], meta: null } }))
    }
  }, [onReloadDecisions])

  const reload = useCallback(() => Promise.all(
    Object.keys(FETCHERS).map((source) => loadSource(source)),
  ), [loadSource])

  useEffect(() => {
    reload()
    // Slower than the Dashboard's own 10s poll — this section holds open
    // dialogs and in-flight actions, and re-rendering it under someone's cursor
    // is worse than a count that is thirty seconds old.
    const timer = setInterval(() => { if (!pausedRef.current) reload() }, 30000)
    return () => clearInterval(timer)
  }, [reload])

  const sources = useMemo(() => ({
    approval: remote.approval,
    decision: { status: 'ok', error: null, items: (decisions || []).map(fromDecision), meta: null },
    task: remote.task,
    reminder: remote.reminder,
  }), [remote, decisions])

  const items = useMemo(() => {
    const all = SOURCE_IDS.flatMap((id) => sources[id].items)
    // Band first, then the ascending timestamp within it. `key` breaks ties so
    // two things queued in the same second never swap places between polls.
    return all.sort((a, b) => a.band - b.band || a.order - b.order || a.key.localeCompare(b.key))
  }, [sources])

  const counts = useMemo(
    () => Object.fromEntries(SOURCE_IDS.map((id) => [id, countOf(sources[id])])),
    [sources],
  )

  const unavailable = SOURCE_IDS.filter((id) => sources[id].status === 'error')
  const loading = SOURCE_IDS.some((id) => sources[id].status === 'loading')
  // A total is only a total when every source answered. With one down it is a
  // floor, and the section says "at least" rather than pretending otherwise.
  const total = SOURCE_IDS.reduce((sum, id) => sum + (counts[id] ?? 0), 0)

  const leadNames = useLeadNames(
    sources.task.items.length > 0 || sources.reminder.items.length > 0,
  )

  // Held by the section while a dialog is open or an action is in flight, so a
  // poll cannot pull the row out from under the click. Stable, because the
  // caller sets it from an effect.
  const setPaused = useCallback((value) => { pausedRef.current = value }, [])

  return {
    sources, items, counts, unavailable, loading, total, leadNames,
    reload, reloadSource: loadSource, setPaused,
  }
}
