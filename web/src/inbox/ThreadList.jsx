// The rows of the message list — the middle pane.
//
// These are rows you scan, not cards you read. Four short lines at most: who,
// what, the first line of it, and when. Everything else about a conversation is
// in the reading pane beside them, so the list can stay dense enough to hold a
// screenful of mail the way Outlook's does.
//
// Three shapes arrive here, and the response says which. `GET /api/inbox/threads`
// returns `rowType: "thread"` for every state except `scheduled` and `sent`,
// which return outbound message rows — because cancelling a queued send needs a
// message id, and a "sent" list of conversations would hide the second and third
// emails in the same thread. `GET /api/drafts` returns the approval queue.
//
// Selection is marked three ways at once: `aria-current` for assistive tech, a
// solid left rule for shape, and a tint. No row means anything by colour alone —
// unread carries weight and a dot with the word behind it, important carries a
// star with the word behind it.

import { useState } from 'react'
import { Badge, Modal, timeAgo } from '../ui.jsx'
import { Confirm } from '../parity-ui.jsx'
import { Marker, Menu, SNOOZE_PRESETS, absolute, fromLocalInput, leadName, relative, toLocalInput } from './common.jsx'

// --------------------------------------------------------------- snooze -----

// The resolved date is stated in words in every option, before it is chosen —
// "Next week" alone is not an answer anyone can check.
export function snoozeItems(onPick, onCustom) {
  return [
    ...SNOOZE_PRESETS.map((preset) => {
      const at = preset.at()
      return {
        key: preset.id,
        label: preset.label,
        hint: `Comes back ${absolute(at.toISOString())}`,
        onSelect: () => onPick(at.toISOString()),
      }
    }),
    { key: 'custom', label: 'Pick a date and time', onSelect: onCustom },
  ]
}

export function SnoozeDialog({ title = 'Snooze this conversation', onClose, onConfirm }) {
  const initial = SNOOZE_PRESETS[0].at()
  const [value, setValue] = useState(toLocalInput(initial))
  const [busy, setBusy] = useState(false)
  const iso = fromLocalInput(value)

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try { await onConfirm(iso) } finally { setBusy(false) }
        }}
      >
        <div>
          <label className="block text-sm text-slate-700" htmlFor="snooze-at">Bring it back on</label>
          <input
            id="snooze-at" type="datetime-local" className="input mt-1" value={value} autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <p className="text-xs text-slate-600" aria-live="polite">
          {iso ? `This conversation comes back ${absolute(iso)} — ${relative(iso)}.` : 'Choose a date and time.'}
        </p>
        <p className="text-xs text-slate-500">
          Snoozing hides the conversation from your list until then. It does not pause the lead: the
          campaign keeps running exactly as it does now. A new reply brings the conversation back straight away.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !iso}>{busy ? 'Snoozing…' : 'Snooze'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------- row chrome ---

// The shell every row shares: the selection rule, the checkbox, the roving
// tabstop and the overflow menu. `data-row-button` is what the list's arrow-key
// handler walks; keeping it in one place means every row type is navigable.
function Row({ active, tabStop, checked, onCheck, checkLabel, onSelect, actions, trailing, children }) {
  return (
    <li
      className={`flex items-start gap-2 border-l-2 px-2 py-2 ${
        active
          ? 'border-l-accent-500 bg-accent-50/70'
          : 'border-l-transparent hover:bg-slate-50'
      }`}
    >
      {onCheck && (
        <input
          type="checkbox"
          className="mt-1 shrink-0 accent-accent-500"
          checked={checked}
          onChange={onCheck}
          aria-label={checkLabel}
        />
      )}
      <button
        type="button"
        data-row-button
        // The selected row is the one the reading pane is showing, and that is
        // a fact about the document, not a colour.
        aria-current={active ? 'true' : undefined}
        // Roving tabstop: one row is in the tab order and the arrow keys move
        // which. A list of two hundred rows must not cost two hundred tabs to
        // step past.
        tabIndex={tabStop ? 0 : -1}
        onClick={onSelect}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        {children}
      </button>
      {/* Anything clickable has to be a sibling of the row button, never a
          descendant of it — a control nested inside a button is unreachable by
          keyboard and invalid markup besides. */}
      {trailing}
      {actions && (
        <Menu
          label="⋯"
          ariaLabel={actions.label}
          buttonClass="mt-0.5 shrink-0 cursor-pointer rounded-md border border-transparent px-1.5 py-0.5 text-sm text-slate-500 hover:border-slate-300 hover:text-ink-900"
          items={actions.items}
        />
      )}
    </li>
  )
}

// A one-line strip of state, only ever rendered when there is state to report.
// Each marker is a word; the glyphs beside them are decoration.
function RowMarkers({ children }) {
  const kids = [].concat(children).filter(Boolean)
  if (kids.length === 0) return null
  return <div className="mt-1 flex flex-wrap items-center gap-1">{kids}</div>
}

const snippetOf = (body) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160)

// ------------------------------------------------------------ conversation --

export function ConversationRow({ row, active, tabStop, checked, onCheck, onSelect, onPatch }) {
  const [snoozing, setSnoozing] = useState(false)
  const who = leadName(row.lead)
  const at = row.last_reply_at || row.last_message?.at

  const actions = {
    label: `Actions for the conversation with ${who}`,
    items: [
      {
        key: 'read',
        label: row.is_read ? `Mark conversation with ${who} unread` : `Mark conversation with ${who} read`,
        onSelect: () => onPatch(row, { read: !row.is_read }),
      },
      {
        key: 'star',
        label: row.is_important ? 'Remove important mark' : `Mark conversation with ${who} important`,
        hint: 'Important is your own priority mark. It is not the reply category the classifier sets.',
        onSelect: () => onPatch(row, { important: !row.is_important }),
      },
      {
        key: 'archive',
        label: row.is_archived ? `Unarchive conversation with ${who}` : `Archive conversation with ${who}`,
        onSelect: () => onPatch(row, { archived: !row.is_archived }),
      },
      ...(row.is_snoozed
        ? [{ key: 'wake', label: 'Wake now', hint: `Currently asleep until ${absolute(row.snoozed_until)}`, onSelect: () => onPatch(row, { snoozedUntil: null }) }]
        : snoozeItems((iso) => onPatch(row, { snoozedUntil: iso }), () => setSnoozing(true))
          .map((item) => ({ ...item, key: `snooze-${item.key}`, label: `Snooze: ${item.label}` }))),
    ],
  }

  return (
    <Row
      active={active}
      tabStop={tabStop}
      checked={checked}
      onCheck={() => onCheck(row)}
      checkLabel={`Select conversation with ${who}`}
      onSelect={() => onSelect(row)}
      actions={actions}
      trailing={snoozing ? (
        <SnoozeDialog
          onClose={() => setSnoozing(false)}
          onConfirm={async (iso) => { await onPatch(row, { snoozedUntil: iso }); setSnoozing(false) }}
        />
      ) : null}
    >
        <div className="flex items-baseline gap-1.5">
          {/* Unread is weight, a dot and the word. Any one of the three alone
              would be a colour or a shape somebody cannot see. */}
          {!row.is_read && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent-500" />}
          {!row.is_read && <span className="sr-only">Unread. </span>}
          <span className={`min-w-0 truncate text-[13px] ${row.is_read ? 'text-slate-700' : 'font-semibold text-ink-950'}`}>{who}</span>
          {row.message_count > 1 && (
            <span className="shrink-0 text-[11px] text-slate-500 tabular-nums">
              <span aria-hidden>{row.message_count}</span>
              <span className="sr-only">{row.message_count} messages in this conversation</span>
            </span>
          )}
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-slate-500" title={absolute(at)}>
            {timeAgo(at)}
            <span className="sr-only"> — {absolute(at)}</span>
          </span>
        </div>

        <div className={`truncate text-[13px] ${row.is_read ? 'text-slate-600' : 'font-medium text-ink-900'}`}>
          {row.is_important && <span aria-hidden className="mr-1 text-amber-600">★</span>}
          {row.is_important && <span className="sr-only">Important. </span>}
          {row.last_message?.subject || '(no subject)'}
        </div>

        <div className="truncate text-[11.5px] text-slate-500">{snippetOf(row.last_message?.body)}</div>

        <RowMarkers>
          {row.intent ? <Badge key="intent" value={row.intent} /> : null}
          {row.is_archived ? <Marker key="arch">Archived</Marker> : null}
          {row.is_snoozed ? <Marker key="snz" title={absolute(row.snoozed_until)}>Snoozed · back {relative(row.snoozed_until)}</Marker> : null}
          {row.reminder_at ? (
            <Marker key="rem" tone={row.is_overdue_reminder ? 'bad' : 'plain'} title={absolute(row.reminder_at)}>
              {row.is_overdue_reminder ? 'Reminder overdue' : `Reminder ${relative(row.reminder_at)}`}
            </Marker>
          ) : null}
          {row.assigned_to ? <Marker key="own">Owner: {row.assigned_to}</Marker> : null}
          {row.campaign?.name ? <span key="camp" className="truncate text-[11px] text-slate-400">{row.campaign.name}</span> : null}
        </RowMarkers>
    </Row>
  )
}

// ---------------------------------------------------------------- outbound --

// `scheduled` and `sent`: outbound message rows.
export function OutboundRow({ row, folder, active, tabStop, onSelect, onCancelled }) {
  const [cancelling, setCancelling] = useState(false)
  const who = leadName(row.lead)
  const scheduled = folder === 'scheduled'

  return (
    <Row
      active={active}
      tabStop={tabStop}
      onSelect={() => onSelect(row)}
      trailing={(
        <>
          {scheduled && (
            <button
              type="button"
              className="mt-0.5 shrink-0 cursor-pointer rounded-md border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 hover:border-red-400 hover:text-red-700"
              aria-label={`Cancel the queued email to ${who}`}
              onClick={() => setCancelling(true)}
            >
              Cancel
            </button>
          )}
          {cancelling && (
            <Confirm
              title={`Cancel the queued email to ${who}?`}
              body={`It is due ${absolute(row.scheduled_at)}. Cancelling takes it out of the queue for good — it is not saved as a draft, and the campaign moves on without it. Nothing has been sent yet.`}
              confirmLabel="Cancel this email"
              danger
              onClose={() => setCancelling(false)}
              onConfirm={async () => { await onCancelled(row); setCancelling(false) }}
            />
          )}
        </>
      )}
    >
        <div className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-ink-900">{who}</span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-slate-500">
            {scheduled
              ? <span title={absolute(row.scheduled_at)}>Goes out {relative(row.scheduled_at)}</span>
              : <span title={absolute(row.created_at)}>{timeAgo(row.created_at)}</span>}
            <span className="sr-only"> — {absolute(scheduled ? row.scheduled_at : row.created_at)}</span>
          </span>
        </div>
        <div className="truncate text-[13px] text-slate-600">{row.subject || '(no subject)'}</div>
        <div className="truncate text-[11.5px] text-slate-500">{snippetOf(row.body)}</div>
        <RowMarkers>
          {row.manual_reply ? <Marker key="man">Manual reply</Marker> : null}
          {row.forwarded_to ? <Marker key="fwd">Forwarded to {row.forwarded_to}</Marker> : null}
          {scheduled && row.is_overdue ? <Marker key="due" tone="warn">Overdue — the sending rhythm has not reached it yet</Marker> : null}
          {!scheduled ? <Marker key="eng">{engagementText(row.stats)}</Marker> : null}
          {row.campaign?.name ? <span key="camp" className="truncate text-[11px] text-slate-400">{row.campaign.name}</span> : null}
        </RowMarkers>
    </Row>
  )
}

// ----------------------------------------------------------------- drafts ---

// The approval queue as list rows. The draft itself — and the reply that
// prompted it, and every action on it — is in the reading pane, exactly like a
// conversation, because reading what the agent wrote and reading what a lead
// said are the same daily habit.
export function DraftRow({ draft, active, tabStop, onSelect }) {
  const who = [draft.first_name, draft.last_name].filter(Boolean).join(' ') || draft.lead_email
  return (
    <Row active={active} tabStop={tabStop} onSelect={() => onSelect(draft)}>
      <div className="flex items-baseline gap-1.5">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent-600" />
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink-950">{who}</span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-slate-500" title={absolute(draft.created_at)}>
          {timeAgo(draft.created_at)}
          <span className="sr-only"> — written {absolute(draft.created_at)}</span>
        </span>
      </div>
      <div className="truncate text-[13px] font-medium text-ink-900">{draft.subject || '(no subject)'}</div>
      <div className="truncate text-[11.5px] text-slate-500">{snippetOf(draft.body)}</div>
      <RowMarkers>
        <Marker key="ok" tone="good">Needs your OK</Marker>
        {draft.campaign_status && draft.campaign_status !== 'running' ? <Marker key="cs" tone="warn">Campaign {draft.campaign_status}</Marker> : null}
        {draft.campaign_name ? <span key="camp" className="truncate text-[11px] text-slate-400">{draft.campaign_name}</span> : null}
      </RowMarkers>
    </Row>
  )
}

// "Not opened" and "we cannot know" are different answers, and the second one
// must never be reported as the first.
export function engagementText(stats) {
  if (!stats) return 'No engagement recorded'
  if (!stats.open_tracking_known) return 'Open tracking was off — whether it was opened is unknown'
  const opened = stats.opened_at ? 'Opened' : 'Not opened'
  const clicked = stats.clicked_at ? ', clicked a link' : ', no clicks'
  return `${opened}${clicked}`
}
