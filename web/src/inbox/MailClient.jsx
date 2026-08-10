// The mail client: folders, a list, and a reading pane.
//
// The Inbox used to be two tabs over a stack of full-width cards. It is now the
// shape everybody already knows from Outlook, Gmail and Apple Mail — folders on
// the left, a dense list in the middle, the whole conversation on the right —
// because that is the layout the job actually has: choose a folder, scan for the
// one that matters, read all of it, act.
//
// Nothing about the data changed. `GET /api/inbox/threads` is still one list
// with a validated `state`; the folders in the rail are that enum. `GET
// /api/inbox/threads/:id` still returns the whole `messages` array; the reading
// pane renders every one of them. Keyset paging still pages, so a reply landing
// mid-scroll cannot make the list jump.
//
// Two things are load-bearing and are stated here rather than left implicit:
//
//  * Needs your OK is the first folder. It is the product's spine — the agent
//    writes, the email stops, a person decides — so it is the first thing the
//    rail offers and the folder the page lands on while anything is waiting.
//
//  * Nothing sends without an explicit confirmation. The approval actions, the
//    reply composer and the forward all keep theirs. Read, archive, snooze and
//    important trade a dialog for an undo toast, because those are states Harry
//    can write back; putting mail on the wire is not one of them.
//
// Below 1024px the three columns become two levels — the list, and the reading
// pane in its place with a way back — which is what Outlook does on a narrow
// window and what 375px can actually hold.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, qs } from '../api.js'
import { LiveRegion, usePagedList } from '../parity-ui.jsx'
import { EmptyState, Spinner, useToast } from '../ui.jsx'
import { useUndo } from '../undo.jsx'
import { Banner, absolute, leadName, useMediaQuery, useRefs, useUnreadCount } from './common.jsx'
import { EMPTY_FILTERS, FilterBar, SavedViews, sortsFor, toQuery } from './Filters.jsx'
import FolderRail, { MESSAGE_FOLDERS, TOOL_FOLDERS, folderOf, useFolderCounts } from './FolderRail.jsx'
import ListPane from './ListPane.jsx'
import ReadingPane from './ReadingPane.jsx'
import Unmatched from './Unmatched.jsx'
import RemindersList from './RemindersList.jsx'

const WIDE = '(min-width: 1024px)'

// ------------------------------------------------------------ URL <-> state -

function readFilters(params) {
  const csv = (key) => (params.get(key) || '').split(',').map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
  return {
    search: params.get('search') || '',
    sort: params.get('sort') || '',
    intent: params.get('intent') || '',
    assignee: params.get('assignee') || '',
    campaignId: csv('campaignId'),
    mailboxId: csv('mailboxId'),
    categoryId: csv('categoryId'),
    unread: params.get('unread') || '',
    important: params.get('important') || '',
    hasReminder: params.get('hasReminder') || '',
    repliedFrom: params.get('repliedFrom') || '',
    repliedTo: params.get('repliedTo') || '',
  }
}

function writeParams(filters, { folder, viewId, thread, draft }) {
  const out = {}
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) { if (value.length) out[key] = value.join(',') } else if (value !== '') out[key] = value
  }
  // The folder is always written, even the default one. A link into the Inbox
  // should say which folder it means rather than depend on what is waiting.
  if (folder) out.folder = folder
  if (viewId) out.viewId = viewId
  if (thread) out.thread = thread
  if (draft) out.draft = draft
  return out
}

// Links minted before the rail existed still work: the Dashboard sends
// `?tab=approve` and `?tab=replies&thread=…`, the command palette sends
// `?state=snoozed`. Both are read once and turned into a folder.
export function legacyFolder(params) {
  const state = params.get('state')
  if (state) return state === 'unmatched' ? 'untracked' : state
  const tab = params.get('tab')
  if (tab === 'approve') return 'approve'
  if (tab === 'replies') return 'active'
  return ''
}

// ------------------------------------------------------------------- shell --

export default function MailClient() {
  const wide = useMediaQuery(WIDE)
  const refs = useRefs()
  const [params, setParams] = useSearchParams()
  const [drafts, setDrafts] = useState(null)
  const [draftsError, setDraftsError] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [hasUntracked, setHasUntracked] = useState(false)
  const [landed, setLanded] = useState(false)
  const paneRef = useRef(null)

  const unread = useUnreadCount(refreshKey)
  const counts = useFolderCounts(refreshKey)

  const folder = params.get('folder') || legacyFolder(params) || 'active'
  const viewId = params.get('viewId') || ''
  const thread = params.get('thread') || ''
  const draftId = params.get('draft') || ''
  const filters = useMemo(() => readFilters(params), [params])

  const announce = useCallback((message) => setAnnouncement(message), [])
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Pull provider inboxes every 10s while this page is open, then refresh the
  // list. Skips when the tab is hidden or a sync is already in flight so we
  // don't pile up Gmail calls.
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inFlight = true
      try {
        await api.post('/api/inbox/sync')
        if (!cancelled) refresh()
      } catch {
        // Quiet — upkeep / next tick will try again; don't toast every 10s.
      } finally {
        inFlight = false
      }
    }
    const id = setInterval(tick, 10_000)
    tick()
    return () => { cancelled = true; clearInterval(id) }
  }, [refresh])

  const update = useCallback((patch) => {
    const nextFolder = patch.folder ?? folder
    const nextFilters = { ...(patch.filters ?? filters) }
    // A sort that belongs to another folder is dropped rather than sent and
    // refused: `scheduled_asc` means nothing to the reply list.
    const meta = folderOf(nextFolder)
    const valid = sortsFor(meta.state || 'active').map(([value]) => value)
    if (nextFilters.sort && !valid.includes(nextFilters.sort)) nextFilters.sort = ''
    setParams(writeParams(nextFilters, {
      folder: nextFolder,
      viewId: patch.viewId !== undefined ? patch.viewId : viewId,
      thread: patch.thread !== undefined ? patch.thread : thread,
      draft: patch.draft !== undefined ? patch.draft : draftId,
    }), { replace: true })
  }, [folder, filters, viewId, thread, draftId, setParams])

  // ---- the approval queue ---------------------------------------------------

  const loadDrafts = useCallback(async () => {
    setDraftsError(null)
    try { setDrafts(await api.get('/api/drafts')) } catch (err) { setDraftsError(err) }
  }, [])
  useEffect(() => { loadDrafts() }, [loadDrafts, refreshKey])

  // Land on whatever needs a human — unless the URL already says where to be,
  // because a deep link to a conversation must not be overruled by the queue.
  useEffect(() => {
    if (landed || !drafts) return
    setLanded(true)
    if (params.get('folder')) return
    const from = legacyFolder(params)
    update({ folder: from || (drafts.drafts.length ? 'approve' : 'active') })
  }, [drafts, landed, params, update])

  // The Untracked folder is hidden entirely when there is nothing untracked, so
  // a workspace that never sees a stray reply never sees the idea of one.
  useEffect(() => {
    api.get('/api/inbox/unmatched?status=new&limit=1')
      .then((r) => setHasUntracked((r.items || []).length > 0))
      .catch(() => setHasUntracked(false))
  }, [refreshKey])

  const focusPane = useCallback(() => {
    paneRef.current?.querySelector('[data-pane-heading]')?.focus()
  }, [])

  if (draftsError) return <Banner error={draftsError} onRetry={loadDrafts} />
  if (!drafts) return <Spinner label="Loading inbox…" />

  const waiting = drafts.drafts.length
  const showPane = folder === 'approve' ? Boolean(draftId) : Boolean(thread)
  // Unread has its own endpoint — one predicate, shared with the nav badge — so
  // it is folded in here rather than counted a second way.
  const railCounts = typeof unread === 'number' ? { ...counts, unread } : counts

  const shared = {
    folder, wide, refs, announce, refresh, update, filters, viewId, refreshKey,
    paneRef, focusPane, thread, draftId, showPane,
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LiveRegion message={announcement} />

      {/* `min-w-0` on every container in the chain: a flex item defaults to
          `min-width: auto`, which lets a wide child — the folder strip, a long
          subject — push the whole page sideways instead of scrolling inside its
          own pane. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {wide && (
          <FolderRail
            folder={folder}
            counts={railCounts}
            approvals={waiting}
            showUntracked={hasUntracked}
            onChange={(next) => update({ folder: next, thread: '', draft: '', viewId: '' })}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!wide && (
            <FolderRail
              variant="strip"
              folder={folder}
              counts={counts}
              approvals={waiting}
              showUntracked={hasUntracked}
              onChange={(next) => update({ folder: next, thread: '', draft: '', viewId: '' })}
            />
          )}

          <div className="flex min-h-0 min-w-0 flex-1">
            {folder === 'approve' && <ApproveFolder {...shared} queue={drafts} />}
            {folder === 'untracked' && <UntrackedFolder {...shared} />}
            {folder === 'reminders' && <RemindersFolder {...shared} />}
            {folder !== 'approve' && !TOOL_FOLDERS.has(folder) && <ThreadFolder {...shared} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// The widths every folder shares, so the three columns line up whichever one is
// filling them.
const LIST_CLASS = 'w-full shrink-0 lg:w-[22.5rem] lg:border-r lg:border-slate-200'
const PANE_CLASS = 'w-full flex-1'

// On a narrow window the list and the reading pane are two levels, not two
// columns: only one is rendered, so focus can never land in a list that is not
// on screen.
function Panes({ wide, showPane, list, pane }) {
  // An empty folder has nothing to read, so the caller passes no pane and the
  // list gets the width. Two empty states side by side say the same thing twice.
  if (wide) return <>{list}{pane}</>
  return showPane && pane ? pane : list
}

// ------------------------------------------------------------- conversations -

function ThreadFolder({
  folder, wide, refs, announce, refresh, update, filters, viewId, refreshKey,
  paneRef, focusPane, thread, showPane,
}) {
  const toast = useToast()
  const undo = useUndo()
  const [selected, setSelected] = useState([])
  const [bulkSnooze, setBulkSnooze] = useState(false)
  const [bulkError, setBulkError] = useState(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [views, setViews] = useState([])
  const [viewsError, setViewsError] = useState(null)
  const [total, setTotal] = useState(null)

  const meta = folderOf(folder)
  const messages = MESSAGE_FOLDERS.has(folder)

  const listParams = useMemo(() => ({
    ...toQuery(filters),
    state: meta.state || 'active',
    viewId: viewId || '',
    limit: 20,
  }), [filters, meta.state, viewId])

  const list = usePagedList('/api/inbox/threads', listParams, [refreshKey])

  // "Showing X of Y" needs the count the list itself reports. One cheap request
  // against the same predicate, so the number and the rows can never disagree.
  useEffect(() => {
    let live = true
    setTotal(null)
    api.get(`/api/inbox/threads${qs({ ...listParams, limit: 1 })}`)
      .then((r) => { if (live) setTotal(r.total_count ?? null) })
      .catch(() => { if (live) setTotal(null) })
    return () => { live = false }
  }, [listParams, refreshKey])

  useEffect(() => { setSelected([]) }, [folder, viewId])

  // ---- saved views ----------------------------------------------------------

  const loadViews = useCallback(() => {
    api.get('/api/inbox/views')
      .then((rows) => { setViews(rows || []); setViewsError(null) })
      .catch(setViewsError)
  }, [])
  useEffect(() => { loadViews() }, [loadViews])

  const applyView = (view) => {
    const stored = view.filters || {}
    update({
      filters: {
        ...EMPTY_FILTERS,
        search: stored.search || '',
        sort: stored.sort || '',
        intent: stored.intent || '',
        assignee: stored.assignee || '',
        campaignId: stored.campaignId || [],
        mailboxId: stored.mailboxId || [],
        categoryId: stored.categoryId || [],
        unread: stored.unread === undefined || stored.unread === null ? '' : String(stored.unread),
        important: stored.important === undefined || stored.important === null ? '' : String(stored.important),
        hasReminder: stored.hasReminder === undefined || stored.hasReminder === null ? '' : String(stored.hasReminder),
        repliedFrom: (stored.repliedFrom || '').slice(0, 10),
        repliedTo: (stored.repliedTo || '').slice(0, 10),
      },
      folder: stored.state || 'active',
      viewId: String(view.id),
      thread: '',
    })
    announce(`Showing the view ${view.name}`)
  }

  // ---- selection ------------------------------------------------------------

  const hint = list.items.find((r) => String(r.id) === String(thread))

  // The reading pane changing under you is a change worth hearing about.
  useEffect(() => {
    if (!thread) return
    const row = list.items.find((r) => String(r.id) === String(thread))
    if (row) announce(`Reading the conversation with ${leadName(row.lead)}`)
  }, [thread]) // eslint-disable-line react-hooks/exhaustive-deps

  const select = (row) => update({ thread: String(row.id) })

  // ---- single-row actions ---------------------------------------------------

  const patchThread = async (row, body) => {
    // Optimistic: the row moves now, and says so if the server disagrees.
    const before = list.items
    list.setItems((items) => items.map((r) => (r.id === row.id ? { ...r, ...optimistic(body) } : r)))
    try {
      await api.patch(`/api/inbox/threads/${row.id}`, body)
      announce(describe(body))
      refresh()
    } catch (err) {
      list.setItems(before)
      toast(err.message, 'error')
    }
  }

  const cancelScheduled = async (row) => {
    try {
      await api.del(`/api/scheduled/${row.id}`)
      announce('Queued email cancelled')
      refresh()
    } catch (err) { toast(err.message, 'error') }
  }

  // ---- bulk -----------------------------------------------------------------

  const selectedRows = list.items.filter((r) => selected.includes(r.id))

  // Read, archived, important and snoozed are all state on a conversation that
  // Harry can write in either direction — nothing is sent, nothing is deleted,
  // and a new reply drags a thread back to unread and unarchived on its own. So
  // these get an undo toast instead of a confirm dialog: clearing an inbox
  // should be fast, and the one time it was the wrong fifty rows, eight seconds
  // of Undo is worth more than a dialog that was clicked through anyway.
  const bulkPatch = async (body) => {
    setBulkError(null)
    const rows = selectedRows
    const asked = selected.length
    // The state each row is in now, written as the patch that would put it back.
    const priors = new Map(rows.map((r) => [r.id, priorPatch(r, body)]))
    // A blanket opposite would be wrong: unarchiving all twelve when three were
    // already archived un-archives three conversations the click never touched.
    const changing = rows.filter((r) => !samePatch(priors.get(r.id), body))
    const report = { text: '' }
    let putBack = []

    const perform = async () => {
      const result = await api.patch('/api/inbox/threads', { ids: selected, ...body })
      const ok = new Set((result.results || []).filter((r) => r.ok).map((r) => r.id))
      putBack = changing.filter((r) => ok.has(r.id))
      report.text = `${describe(body)} — ${ok.size === asked ? noun(ok.size) : `${ok.size} of ${asked} conversations`}`
      announce(`${ok.size} of ${asked} conversations updated`)
      if (ok.size !== asked) toast(`${ok.size} of ${asked} updated — the rest were left as they were`, 'error')
      setSelected([])
      refresh()
      return result
    }

    try {
      if (changing.length === 0) {
        await perform()
        toast('Nothing changed — every one of those was already in that state')
      } else {
        await undo.run({
          label: <Outcome report={report} />,
          perform,
          revert: async () => {
            const groups = new Map()
            for (const row of putBack) {
              const key = JSON.stringify(priors.get(row.id))
              if (!groups.has(key)) groups.set(key, [])
              groups.get(key).push(row.id)
            }
            for (const [key, ids] of groups) {
              await api.patch('/api/inbox/threads', { ids, ...JSON.parse(key) })
            }
            announce(`${noun(putBack.length)} put back as they were`)
            refresh()
          },
        })
      }
    } catch (err) { setBulkError(err) }
  }

  const bulkAssign = async (assignee) => {
    setBulkError(null)
    const ids = selectedRows.map((r) => r.campaign_lead_map_id).filter(Boolean)
    if (ids.length === 0) {
      setBulkError(new Error('None of the selected conversations is paired with a campaign lead, so there is nobody to assign.'))
      return
    }
    try {
      const result = await api.patch('/api/campaign-leads/assignee', { ids, assignee: assignee || 'none' })
      announce(`${result.updated} of ${selected.length} conversations reassigned`)
      toast(ids.length === selected.length
        ? `${result.updated} reassigned`
        : `${result.updated} reassigned — ${selected.length - ids.length} had no campaign lead to assign`)
      setSelected([])
      refresh()
    } catch (err) { setBulkError(err) }
  }

  // ---- render ---------------------------------------------------------------

  const filtered = JSON.stringify(filters) !== JSON.stringify({ ...EMPTY_FILTERS, sort: filters.sort })
  const solo = !list.loading && list.items.length === 0 && !thread

  const toolbar = (
    <div className="space-y-2">
      <SavedViews
        views={views}
        error={viewsError}
        activeId={viewId}
        filters={filters}
        state={meta.state || 'active'}
        onApply={applyView}
        onClear={() => update({ viewId: '', filters: { ...EMPTY_FILTERS, sort: filters.sort } })}
        onSave={async (view, payload, creating) => {
          const saved = creating
            ? await api.post('/api/inbox/views', payload)
            : await api.patch(`/api/inbox/views/${view.id}`, payload)
          loadViews()
          return saved
        }}
        onSaved={(saved) => { loadViews(); if (saved?.id) update({ viewId: String(saved.id) }) }}
        onDeleted={async (view) => {
          await api.del(`/api/inbox/views/${view.id}`)
          if (String(view.id) === String(viewId)) update({ viewId: '' })
          loadViews()
        }}
      />
      <FilterBar
        filters={filters}
        onChange={(next) => update({ filters: next })}
        refs={refs}
        state={meta.state || 'active'}
        open={filtersOpen}
        onToggle={() => setFiltersOpen((v) => !v)}
      />
      {bulkError && <Banner error={bulkError} />}
    </div>
  )

  return (
    <Panes
      wide={wide}
      showPane={showPane}
      list={(
        <ListPane
          className={solo ? 'flex-1' : LIST_CLASS}
          folder={folder}
          items={list.items}
          loading={list.loading}
          error={list.error}
          hasMore={list.hasMore}
          onLoadMore={list.loadMore}
          onRetry={list.reload}
          total={total}
          selectedId={thread}
          onSelect={select}
          onOpen={focusPane}
          filtered={filtered}
          onClearFilters={() => update({ filters: { ...EMPTY_FILTERS, sort: filters.sort }, viewId: '' })}
          checked={selected}
          onCheck={(row) => setSelected((s) => (s.includes(row.id) ? s.filter((id) => id !== row.id) : [...s, row.id]))}
          onCheckAll={(on) => setSelected(on ? list.items.map((r) => r.id) : [])}
          onPatch={patchThread}
          onCancelled={cancelScheduled}
          toolbar={toolbar}
          bulk={messages ? null : {
            count: selected.length,
            folder,
            refs,
            onClear: () => setSelected([]),
            onPatch: bulkPatch,
            onAssign: bulkAssign,
            snoozeOpen: bulkSnooze,
            onSnoozeOpen: () => setBulkSnooze(true),
            onSnoozeClose: () => setBulkSnooze(false),
          }}
        />
      )}
      pane={solo ? null : (
        <ReadingPane
          className={PANE_CLASS}
          folder={folder}
          threadId={thread}
          hint={hint}
          refs={refs}
          announce={announce}
          onChanged={refresh}
          onBack={wide ? null : () => update({ thread: '' })}
          paneRef={paneRef}
        />
      )}
    />
  )
}

// ---------------------------------------------------------------- approvals --

function ApproveFolder({ queue, wide, refs, announce, refresh, update, draftId, showPane, paneRef, focusPane }) {
  const toast = useToast()
  const drafts = queue.drafts
  const selected = drafts.find((d) => String(d.id) === String(draftId)) || null

  // The queue is the point of the folder, so the first email in it is open on
  // arrival rather than waiting to be clicked.
  useEffect(() => {
    if (!draftId && drafts.length > 0) update({ draft: String(drafts[0].id) })
    // A draft that has just been approved or declined is gone; move to the next
    // rather than leaving the pane pointing at nothing.
    else if (draftId && drafts.length > 0 && !drafts.some((d) => String(d.id) === String(draftId))) {
      update({ draft: String(drafts[0].id) })
    }
  }, [draftId, drafts, update])

  useEffect(() => {
    if (selected) announce(`Reading the email to ${selected.lead_email}`)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!queue.requireApproval && drafts.length === 0) {
    return (
      <div className="flex-1 p-6">
        <EmptyState
          icon="check"
          title="Sending without asking"
          hint="Emails go out as soon as the agent writes them. Turn approvals back on in Settings if you'd rather read each one first."
        />
      </div>
    )
  }

  // This one keeps its confirmation and always will. Approving is putting mail
  // on the wire, and eight seconds of "Undo" cannot recall an email somebody
  // has already read.
  const approveAll = async () => {
    if (!confirm(`Send all ${drafts.length} emails as written?`)) return
    try {
      const result = await api.post('/api/drafts/approve-all')
      if (!result.approved) {
        toast('Nothing could send — check the campaigns are running', 'error')
      } else if (result.queued) {
        toast(`Approved ${result.approved} — ${result.sent ? `${result.sent} away, ` : ''}${result.queued} queued to go out across your sending hours`)
      } else {
        toast(`Sent ${result.approved} email${result.approved === 1 ? '' : 's'}`)
      }
      announce(`Approved ${result.approved} emails`)
      refresh()
    } catch (err) { toast(err.message, 'error') }
  }

  return (
    <Panes
      wide={wide}
      showPane={showPane}
      list={(
        <ListPane
          className={drafts.length === 0 ? 'flex-1' : LIST_CLASS}
          folder="approve"
          items={drafts}
          loading={false}
          error={null}
          hasMore={false}
          total={drafts.length}
          selectedId={draftId}
          onSelect={(d) => update({ draft: String(d.id) })}
          onOpen={focusPane}
          onApproveAll={approveAll}
        />
      )}
      pane={drafts.length === 0 ? null : (
        <ReadingPane
          className={PANE_CLASS}
          folder="approve"
          draft={selected}
          refs={refs}
          announce={announce}
          onChanged={refresh}
          onBack={wide ? null : () => update({ draft: '' })}
          paneRef={paneRef}
        />
      )}
    />
  )
}

// -------------------------------------------------------------- tool folders -

// Untracked replies are not mail in a conversation — they matched no lead, so
// there is no trail to read beside them. The triage list gets the whole width
// instead of a reading pane that would have nothing to say.
function UntrackedFolder({ refs, announce }) {
  return (
    <section aria-label="Untracked replies" className="min-w-0 flex-1 overflow-y-auto p-4">
      <Unmatched refs={refs} announce={announce} />
    </section>
  )
}

// Reminders are a list of reminders, not of conversations — one conversation
// can carry three. Opening one puts its conversation in the reading pane, which
// is why this folder keeps both panes.
function RemindersFolder({ wide, refs, announce, refresh, update, thread, showPane, paneRef }) {
  const hasThread = Boolean(thread)
  return (
    <Panes
      wide={wide}
      showPane={showPane}
      list={(
        <section aria-label="Reminders" className={`${LIST_CLASS} min-h-0 overflow-y-auto p-3`}>
          <RemindersList
            refs={refs}
            announce={announce}
            onOpenThread={(messageId) => update({ thread: String(messageId) })}
          />
        </section>
      )}
      pane={(
        <ReadingPane
          className={PANE_CLASS}
          folder="reminders"
          threadId={hasThread ? thread : ''}
          refs={refs}
          announce={announce}
          onChanged={refresh}
          onBack={wide ? null : () => update({ thread: '' })}
          paneRef={paneRef}
        />
      )}
    />
  )
}

// ------------------------------------------------------------------ wording --

const noun = (n) => `${n} conversation${n === 1 ? '' : 's'}`

// `undo.run` reads the toast's label only once `perform` has resolved, so an
// element — unlike a string — can quote the per-id result the server sent back.
function Outcome({ report }) {
  return report.text
}

// The patch that would put a row back where it is now. Only the fields the
// write touches are mirrored, so undoing an archive never also rewrites read
// state that nobody asked about.
function priorPatch(row, body) {
  const patch = {}
  if (body.read !== undefined) patch.read = !!row.is_read
  if (body.archived !== undefined) patch.archived = !!row.is_archived
  if (body.important !== undefined) patch.important = !!row.is_important
  // A snooze that has already expired reads as awake, and waking it again is
  // the honest restore — re-snoozing to a date in the past would be a no-op
  // dressed up as a revert.
  if (body.snoozedUntil !== undefined) patch.snoozedUntil = row.is_snoozed ? (row.snoozed_until || '') : ''
  return patch
}

const samePatch = (a, b) => Object.keys(b).every((key) => a[key] === b[key])

// The row change an optimistic update should show before the server answers.
function optimistic(body) {
  const patch = {}
  if (body.read !== undefined) patch.is_read = body.read
  if (body.archived !== undefined) patch.is_archived = body.archived
  if (body.important !== undefined) patch.is_important = body.important
  if (body.snoozedUntil !== undefined) {
    patch.is_snoozed = !!body.snoozedUntil
    patch.snoozed_until = body.snoozedUntil || ''
  }
  return patch
}

export function describe(body) {
  if (body.read !== undefined) return body.read ? 'Marked read' : 'Marked unread'
  if (body.archived !== undefined) return body.archived ? 'Archived' : 'Unarchived'
  if (body.important !== undefined) return body.important ? 'Marked important' : 'Important mark removed'
  if (body.snoozedUntil !== undefined) return body.snoozedUntil ? `Snoozed until ${absolute(body.snoozedUntil)}` : 'Woken up'
  return 'Updated'
}
