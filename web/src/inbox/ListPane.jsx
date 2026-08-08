// The middle pane: the list you scan.
//
// One list, whatever the folder — the approval queue, conversations, or the
// outbound message rows that `scheduled` and `sent` return. Its header carries
// the count, the search box, the collapsed filter bar and the one bulk action
// that belongs to the folder you are in; its body is rows; its foot is Load
// more, because keyset paging stays and a reply arriving mid-scroll must not
// make the list jump.
//
// Keyboard is the point of a list like this. Up and down move the selection and
// the reading pane follows; Enter takes you into what you are reading; Home and
// End go to the ends. One row at a time is in the tab order, so stepping past
// the list costs one Tab rather than two hundred.

import { useRef } from 'react'
import { BulkBar, LoadMore } from '../parity-ui.jsx'
import { EmptyState } from '../ui.jsx'
import { Banner, Menu, SkeletonRows } from './common.jsx'
import { ConversationRow, DraftRow, OutboundRow, SnoozeDialog, snoozeItems } from './ThreadList.jsx'
import { MESSAGE_FOLDERS, folderOf } from './FolderRail.jsx'

const EMPTY_COPY = {
  approve: ['Nothing waiting on you', 'The agent parks every email here before it sends. When one is ready, it appears here and in your Slack or Teams channel.'],
  active: ['No replies yet', 'When leads reply, the agent classifies each message by intent and routes it — and everything lands here.'],
  unread: ['All caught up.', 'Every reply in this workspace has been read by someone. Read state is shared, not personal.'],
  important: ['Nothing marked important yet', 'Star a conversation to keep it here. Important is your own priority mark — it is not the reply category the classifier sets.'],
  assigned: ['Nothing assigned to you', 'Assigning a conversation marks who is chasing it. It never restricts who can approve an email.'],
  snoozed: ['Nothing snoozed', 'Snoozing hides a conversation until a date you choose. It does not pause the lead — the campaign keeps running.'],
  reminders: ['No reminders', 'Set one from any conversation. Reminders are yours to chase; they never send anything.'],
  scheduled: ['Nothing queued', 'Emails appear here once you have approved them and before the sending rhythm reaches their minute.'],
  sent: ['Nothing sent yet', 'Every email that has left a connected mailbox shows up here, newest first.'],
  archived: ['Nothing archived yet.', 'Archiving clears a conversation out of Active. A new reply brings it straight back.'],
  all: ['No conversations yet', 'Once a campaign starts sending, both halves of every conversation appear here.'],
}

export default function ListPane({
  folder, items, loading, error, hasMore, onLoadMore, onRetry,
  total, selectedId, onSelect, onOpen, filtered, onClearFilters,
  checked = [], onCheck, onCheckAll, bulk, toolbar,
  onPatch, onCancelled, onApproveAll, className = '',
}) {
  const listRef = useRef(null)
  const meta = folderOf(folder)
  const messages = MESSAGE_FOLDERS.has(folder)
  const drafts = folder === 'approve'
  const [emptyTitle, emptyHint] = EMPTY_COPY[folder] || EMPTY_COPY.all

  // Selection follows the arrow keys, so the reading pane is always showing
  // whatever the list is pointing at. Enter is the one that moves you.
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) return
    const buttons = [...(listRef.current?.querySelectorAll('[data-row-button]') || [])]
    if (buttons.length === 0) return
    const here = buttons.findIndex((b) => b.closest('li')?.contains(document.activeElement))
    const current = here === -1 ? Math.max(0, items.findIndex((r) => String(r.id) === String(selectedId))) : here

    if (e.key === 'Enter') {
      // Without this the button's own default activation fires too and the row
      // is selected twice.
      e.preventDefault()
      onSelect(items[current])
      onOpen?.()
      return
    }
    const next = e.key === 'ArrowDown' ? Math.min(current + 1, buttons.length - 1)
      : e.key === 'ArrowUp' ? Math.max(current - 1, 0)
        : e.key === 'Home' ? 0 : buttons.length - 1
    e.preventDefault()
    buttons[next]?.focus()
    if (items[next]) onSelect(items[next])
  }

  // Whichever row holds the single tabstop: the selected one, or the first if
  // the selection is not on this page.
  const selectedIndex = items.findIndex((r) => String(r.id) === String(selectedId))
  const tabIndexAt = selectedIndex === -1 ? 0 : selectedIndex

  const allChecked = checked.length > 0 && checked.length === items.length

  return (
    <section aria-label="Message list" className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      {/* Capped and scrollable: an open filter panel must not be able to push
          the list it filters off the bottom of the pane. */}
      <header className="max-h-[55%] shrink-0 space-y-2 overflow-y-auto border-b border-slate-200 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-ink-950">{meta.label}</h2>
          <span className="text-[11px] text-slate-500">
            {items.length}
            {typeof total === 'number' ? ` of ${total}` : ''}
            {' '}{drafts ? 'waiting' : messages ? 'emails' : 'conversations'}
          </span>
          {loading && <span className="text-[11px] text-slate-500" aria-live="polite">Loading…</span>}

          {/* The approval queue's one bulk action, and it keeps its dialog. The
              state changes below trade a confirm for an undo toast because Harry
              can write them back; putting mail on the wire is not one of those. */}
          {drafts && items.length > 1 && (
            <button className="btn-ghost !ml-auto !px-2.5 !py-1 text-xs" onClick={onApproveAll}>
              Send all {items.length}
            </button>
          )}
          {!drafts && !messages && items.length > 0 && (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
              <input
                type="checkbox"
                className="accent-accent-500"
                checked={allChecked}
                onChange={(e) => onCheckAll(e.target.checked)}
                aria-label="Select every conversation on this page"
              />
              Select all
            </label>
          )}
        </div>
        <p className="text-[11px] text-slate-500">{meta.hint}</p>
        {toolbar}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="p-3"><Banner error={error} onRetry={onRetry} /></div>}
        {loading && items.length === 0 && <div className="p-2"><SkeletonRows rows={7} label="Loading conversations…" /></div>}

        {!loading && !error && items.length === 0 && (
          <div className="p-3">
            <EmptyState
              icon={drafts ? 'check' : messages ? 'mail' : 'inbox'}
              title={filtered ? 'Nothing matches these filters' : emptyTitle}
              hint={filtered ? 'Nothing in this folder matches what you have filtered to.' : emptyHint}
              action={filtered ? <button className="btn-ghost" onClick={onClearFilters}>Clear filters</button> : null}
            />
          </div>
        )}

        {items.length > 0 && (
          <ul
            ref={listRef}
            onKeyDown={onKeyDown}
            aria-label={`${meta.label} — ${drafts ? 'emails waiting for your approval' : messages ? 'emails' : 'conversations'}`}
            className="divide-y divide-slate-100"
          >
            {items.map((row, i) => {
              const active = String(row.id) === String(selectedId)
              const tabStop = i === tabIndexAt
              if (drafts) return <DraftRow key={row.id} draft={row} active={active} tabStop={tabStop} onSelect={onSelect} />
              if (messages) {
                return (
                  <OutboundRow
                    key={row.id} row={row} folder={folder} active={active} tabStop={tabStop}
                    onSelect={onSelect} onCancelled={onCancelled}
                  />
                )
              }
              return (
                <ConversationRow
                  key={row.id} row={row} active={active} tabStop={tabStop}
                  checked={checked.includes(row.id)}
                  onCheck={onCheck}
                  onSelect={onSelect}
                  onPatch={onPatch}
                />
              )
            })}
          </ul>
        )}

        <LoadMore hasMore={hasMore} loading={loading} onClick={onLoadMore} />
      </div>

      {bulk && <BulkActions {...bulk} />}
    </section>
  )
}

// The bulk bar and its menus, kept beside the list they act on.
function BulkActions({ count, folder, onClear, onPatch, onAssign, refs, snoozeOpen, onSnoozeOpen, onSnoozeClose }) {
  return (
    <>
      <BulkBar count={count} onClear={onClear}>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => onPatch({ read: true })}>Mark read</button>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => onPatch({ read: false })}>Mark unread</button>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => onPatch({ archived: folder !== 'archived' })}>
          {folder === 'archived' ? 'Unarchive' : 'Archive'}
        </button>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => onPatch({ important: true })}>Mark important</button>
        <Menu
          label="Snooze"
          ariaLabel="Snooze the selected conversations"
          buttonClass="btn-ghost !px-2.5 !py-1 text-xs"
          items={snoozeItems((iso) => onPatch({ snoozedUntil: iso }), onSnoozeOpen)}
        />
        {!refs.solo && (
          <Menu
            label="Assign"
            ariaLabel="Assign the selected conversations"
            buttonClass="btn-ghost !px-2.5 !py-1 text-xs"
            items={[
              { key: 'none', label: 'Unassigned', hint: 'Assignment marks responsibility; it never restricts who can approve.', onSelect: () => onAssign('') },
              ...refs.members.map((m) => ({ key: m, label: m, onSelect: () => onAssign(m) })),
            ]}
          />
        )}
      </BulkBar>

      {snoozeOpen && (
        <SnoozeDialog
          title={`Snooze ${count} conversation${count === 1 ? '' : 's'}`}
          onClose={onSnoozeClose}
          onConfirm={async (iso) => { await onPatch({ snoozedUntil: iso }); onSnoozeClose() }}
        />
      )}
    </>
  )
}
