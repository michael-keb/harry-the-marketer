// The folder rail.
//
// SmartLead's ten inbox screens collapse into one query with a `state`, and this
// is that enum rendered the way every mail client renders it: a column of
// folders on the left, the one you are in obviously the one you are in. The
// values have not changed — `state=unread` is still `state=unread` — only where
// you choose them.
//
// "Needs your OK" sits first and alone above the rule, because it is the queue
// that must be cleared rather than a place mail happens to sit. It is not a
// `state` on the threads route at all; it is the draft queue, which is why it is
// separated here rather than sorted in among the others.
//
// Untracked is likewise its own route: campaign and category filters cannot
// apply to a reply that matched no lead. It is hidden entirely when there is
// nothing untracked, so a workspace that never sees a stray reply never sees
// the idea of one.

import { useEffect, useState } from 'react'
import { api, qs } from '../api.js'

// The one folder list. `state` is what goes to the API; a folder without one is
// served by its own route.
export const FOLDERS = [
  { id: 'approve', label: 'Needs your OK', lead: true, hint: 'Emails the agent has written and parked. Nothing sends until you say so.' },
  { id: 'active', state: 'active', label: 'Active', hint: 'Every conversation with a reply that is not archived or snoozed.' },
  { id: 'unread', state: 'unread', label: 'Unread', hint: 'Read state is shared with your whole workspace, not personal.' },
  { id: 'important', state: 'important', label: 'Important', hint: 'Your own priority mark — not the category the classifier sets.' },
  { id: 'assigned', state: 'assigned', label: 'Assigned to me', hint: 'Assignment marks who is chasing it. It never restricts who can approve.' },
  { id: 'snoozed', state: 'snoozed', label: 'Snoozed', hint: 'Hidden until the date you chose. A new reply brings it straight back.' },
  { id: 'reminders', state: 'reminders', label: 'Reminders', hint: 'Conversations you asked to be reminded about.' },
  { id: 'scheduled', state: 'scheduled', label: 'Scheduled', hint: 'Approved emails waiting for their slot in the sending rhythm.' },
  { id: 'sent', state: 'sent', label: 'Sent', hint: 'Every email that has left a connected mailbox.' },
  { id: 'archived', state: 'archived', label: 'Archived', hint: 'Cleared out of Active. A new reply brings it back.' },
  { id: 'all', state: 'all', label: 'All', hint: 'Every conversation, whatever state it is in.' },
  { id: 'untracked', label: 'Untracked', hint: 'Replies that reached a mailbox but matched no lead.' },
]

export const FOLDER_IDS = FOLDERS.map((f) => f.id)
export const folderOf = (id) => FOLDERS.find((f) => f.id === id) || FOLDERS[1]

// Folders whose contents are a list of outbound messages rather than of
// conversations — the response says so with `rowType`, and cancelling a queued
// send needs a message id.
export const MESSAGE_FOLDERS = new Set(['scheduled', 'sent'])

// Folders served by their own route rather than by `GET /api/inbox/threads`.
export const TOOL_FOLDERS = new Set(['reminders', 'untracked'])

// `sent` and `all` are deliberately uncounted. Both grow without bound, so the
// number would be a running total of everything that ever happened — noise in a
// rail whose job is to say what is waiting.
// Reminders is uncounted too, for a different reason: that folder lists
// reminders, and `state=reminders` counts the conversations they hang off. One
// conversation can carry three. A badge that counts a different thing from the
// list under it is worse than no badge.
const COUNTED = ['active', 'important', 'assigned', 'snoozed', 'scheduled', 'archived']

// Live counts for the rail. Each one is the same predicate the list itself runs
// (`total_count` off a one-row page), so a badge can never disagree with the
// folder it counts. A failed request keeps the last known value rather than
// flashing zero — "none" and "we could not ask" are different answers.
export function useFolderCounts(refreshKey) {
  const [counts, setCounts] = useState({})

  useEffect(() => {
    let live = true
    Promise.allSettled(COUNTED.map((state) =>
      api.get(`/api/inbox/threads${qs({ state, limit: 1 })}`).then((r) => [state, r.total_count])))
      .then((results) => {
        if (!live) return
        const next = {}
        for (const r of results) {
          if (r.status !== 'fulfilled') continue
          const [state, total] = r.value
          if (typeof total === 'number') next[state] = total
        }
        setCounts((prev) => ({ ...prev, ...next }))
      })
    return () => { live = false }
  }, [refreshKey])

  return counts
}

// ---------------------------------------------------------------- the rail --

// The pill is decoration; the number belongs in the accessible name, or a screen
// reader reads the folder as "Active12". And a bare number is not an answer on
// its own — each folder says what its number counts.
function counted(folder, count) {
  if (typeof count !== 'number') return ''
  if (folder.id === 'approve') return ` (${count} waiting for your approval)`
  if (folder.id === 'unread') return ` (${count} unread)`
  return ` (${count} conversation${count === 1 ? '' : 's'})`
}

// `variant="rail"` is the left column at 1024px and up. `variant="strip"` is the
// same list as a horizontal scroller for narrower windows, where a third column
// has nowhere to go. Only one is ever rendered, so `aria-current` marks exactly
// one element in the document.
export function FolderRail({ folder, onChange, counts = {}, approvals, showUntracked, variant = 'rail' }) {
  const shown = FOLDERS.filter((f) => f.id !== 'untracked' || showUntracked || folder === 'untracked')
  const countFor = (f) => (f.id === 'approve' ? approvals : counts[f.state])
  const strip = variant === 'strip'

  return (
    <nav
      aria-label="Mail folders"
      className={strip
        ? 'shrink-0 overflow-x-auto border-b border-slate-200 px-2 py-2'
        : 'flex w-56 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-slate-50 py-3'}
    >
      <ul className={strip ? 'flex w-max items-center gap-1' : 'space-y-0.5 px-2'}>
        {shown.map((f) => {
          const on = folder === f.id
          const count = countFor(f)
          const has = typeof count === 'number' && count > 0
          return (
            <li key={f.id} className={!strip && f.lead ? 'mb-1.5 border-b border-slate-200 pb-2.5' : undefined}>
              <button
                type="button"
                // A real list with a real current item: the rail is how you know
                // where you are, so that fact is in the markup and not only in
                // the background colour.
                aria-current={on ? 'true' : undefined}
                title={f.hint}
                onClick={() => onChange(f.id)}
                // `relative` is load-bearing, not decoration. `sr-only` is
                // `position: absolute`, and an absolutely-positioned element is
                // only clipped by an ancestor's `overflow` if that ancestor is
                // itself positioned. Without this the hidden count labels inside
                // the horizontally-scrolled strip took their coordinates from the
                // page, sat ~500px off the right edge, and gave the whole
                // document a sideways scrollbar on tablet. Anchoring each label
                // to its own button keeps it where it belongs.
                className={`relative flex w-full cursor-pointer items-center gap-2 rounded-lg text-left transition-colors ${
                  strip ? 'shrink-0 px-3 py-1.5 text-sm' : 'px-2.5 py-1.5 text-sm'
                } ${
                  on
                    ? 'bg-white font-semibold text-ink-950 shadow-sm ring-1 ring-slate-200'
                    : 'text-slate-700 hover:bg-white/70 hover:text-ink-900'
                }`}
              >
                <span className="truncate">{f.label}</span>
                <span className="sr-only">{counted(f, count)}</span>
                {has && (
                  <span
                    aria-hidden
                    className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
                      f.id === 'approve' ? 'bg-accent-600 text-white' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export default FolderRail
