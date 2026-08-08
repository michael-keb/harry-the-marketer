// One conversation, read in the pane beside the list.
//
// This used to be a drawer that covered the list it was opened from. It is now
// the third pane of a mail client: always present, always showing whatever the
// list has selected, and scrolling on its own. Nothing about the conversation
// itself changed — the thread's id is still the id of its earliest message, so
// `?thread=123` still survives a refresh and the back button.
//
// Thread state — read, archived, snoozed, important — is an aggregate over the
// messages, which is why a new inbound reply pulls the whole conversation back
// to unread and unarchived while a star survives. That is stated on the pane
// rather than left to be discovered.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Badge, useToast } from '../ui.jsx'
import { Banner, Marker, Menu, SkeletonRows, absolute, leadName, relative } from './common.jsx'
import { SnoozeDialog, snoozeItems } from './ThreadList.jsx'
import { ReplyComposer, ForwardDialog } from './Composer.jsx'
import { AssigneeControl, BlockDomainDialog, CategoryControl, RevenueField, ResumeControl, SubsequenceDialog } from './Triage.jsx'
import { MessageStatusLine, ThreadPanels } from './ThreadPanels.jsx'
import MessageTrail from './MessageTrail.jsx'

export default function ThreadView({ threadId, hint, refs, onChanged, announce, onBack }) {
  const toast = useToast()
  const [thread, setThread] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const [forwarding, setForwarding] = useState(null)
  const [blocking, setBlocking] = useState(null)
  const [moving, setMoving] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const heading = useRef(null)
  const marked = useRef(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setThread(await api.get(`/api/inbox/threads/${threadId}`))
    } catch (err) { setError(err) }
  }, [threadId])

  // A new selection is a new conversation: drop the one on screen rather than
  // leaving the previous trail visible under a new heading while it loads.
  useEffect(() => { marked.current = false; setThread(null); load() }, [load])

  // Opening a conversation marks it read for the workspace — read state is
  // shared, not per-person — and the badge moves in the same interaction.
  useEffect(() => {
    if (!thread || thread.is_read || marked.current) return
    marked.current = true
    api.patch(`/api/inbox/threads/${thread.id}`, { read: true })
      .then(() => { setThread((t) => (t ? { ...t, is_read: true } : t)); onChanged?.() })
      .catch(() => { /* the row simply stays unread */ })
  }, [thread, onChanged])

  const patch = async (body, said) => {
    setBusy(true)
    try {
      const result = await api.patch(`/api/inbox/threads/${threadId}`, body)
      setThread((t) => (t ? { ...t, ...result } : t))
      announce?.(said)
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    } finally { setBusy(false) }
  }

  const subject = thread?.messages?.[thread.messages.length - 1]?.subject || hint?.last_message?.subject || hint?.subject || 'Conversation'
  const who = leadName(thread?.lead || hint?.lead)

  if (error) return <div className="p-5"><Banner error={error} onRetry={load} /></div>

  if (!thread) {
    return (
      <div className="space-y-3 p-5">
        {/* Filled from the row that was clicked, so the pane is never a blank
            rectangle while it loads — and carrying the same handle as the real
            heading, so Enter on a row lands here even mid-load. */}
        <h3 tabIndex={-1} data-pane-heading className="text-base font-semibold text-ink-950 outline-none">{who}</h3>
        <SkeletonRows rows={3} label="Loading this conversation…" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- the fixed conversation header ------------------------------- */}
      <header className="shrink-0 border-b border-slate-200 px-5 py-3.5">
        {onBack && (
          <button type="button" className="mb-2 cursor-pointer text-xs text-slate-600 underline hover:text-ink-900" onClick={onBack}>
            ← Back to the list
          </button>
        )}
        {/* Enter on a row moves the reader here rather than leaving focus in the
            list; the pane finds this by attribute so it does not need a handle
            on this component's internals. */}
        <h3 ref={heading} tabIndex={-1} data-pane-heading className="text-base font-semibold text-ink-950 outline-none">{subject}</h3>
        <div className="mt-0.5 text-xs text-slate-600">
          {who}
          {thread.lead?.email ? ` · ${thread.lead.email}` : ''}
          {thread.lead?.company ? ` · ${thread.lead.company}` : ''}
          {thread.lead?.title ? `, ${thread.lead.title}` : ''}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Marker tone={thread.is_read ? 'plain' : 'good'}>{thread.is_read ? 'Read' : 'Unread'}</Marker>
          {thread.is_important && <Marker tone="warn">Important</Marker>}
          {thread.is_archived && <Marker>Archived</Marker>}
          {thread.is_snoozed && <Marker title={absolute(thread.snoozed_until)}>Snoozed · back {relative(thread.snoozed_until)}</Marker>}
          {thread.campaign?.name && <span className="text-[11px] text-slate-500">{thread.campaign.name}</span>}
          {thread.campaignLead?.state && <Badge value={thread.campaignLead.state} />}
          {thread.campaignLead?.assigned_email && <Marker>Owner: {thread.campaignLead.assigned_email}</Marker>}
        </div>

        {/* ---- state actions --------------------------------------------- */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button" className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy}
            onClick={() => patch({ read: !thread.is_read }, `Conversation with ${who} marked ${thread.is_read ? 'unread' : 'read'}`)}
            aria-label={thread.is_read ? `Mark conversation with ${who} unread` : `Mark conversation with ${who} read`}
          >
            {thread.is_read ? 'Mark unread' : 'Mark read'}
          </button>
          <button
            type="button" className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy}
            aria-pressed={thread.is_important}
            onClick={() => patch({ important: !thread.is_important }, thread.is_important ? 'Important mark removed' : 'Marked important')}
            aria-label={thread.is_important ? 'Remove important mark' : `Mark conversation with ${who} important`}
          >
            {thread.is_important ? 'Remove important' : 'Mark important'}
          </button>
          <button
            type="button" className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy}
            onClick={() => patch({ archived: !thread.is_archived }, thread.is_archived ? 'Unarchived' : 'Archived')}
            aria-label={thread.is_archived ? `Unarchive conversation with ${who}` : `Archive conversation with ${who}`}
          >
            {thread.is_archived ? 'Unarchive' : 'Archive'}
          </button>
          {thread.is_snoozed ? (
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => patch({ snoozedUntil: null }, 'Woken up')}>
              Wake now
            </button>
          ) : (
            <Menu
              label="Snooze"
              ariaLabel={`Snooze the conversation with ${who}`}
              buttonClass="btn-ghost !px-2.5 !py-1 text-xs"
              items={snoozeItems(
                (iso) => patch({ snoozedUntil: iso }, `Snoozed until ${absolute(iso)}`),
                () => setSnoozing(true),
              )}
            />
          )}
          <Menu
            label="More"
            ariaLabel="More actions for this conversation"
            buttonClass="btn-ghost !px-2.5 !py-1 text-xs"
            items={[
              {
                key: 'move',
                label: 'Move to another playbook',
                hint: 'Reclassifying changes the branch inside this playbook; moving sends them to a different one.',
                disabled: !thread.campaign?.id,
                onSelect: () => setMoving(true),
              },
              {
                key: 'block',
                label: 'Block this domain',
                hint: 'Suppression is unconditional and has no bypass.',
                danger: true,
                disabled: !thread.lead?.email,
                onSelect: () => setBlocking(thread.lead.email),
              },
            ]}
          />
        </div>
      </header>

      {/* ---- the trail, and everything that hangs off it ------------------ */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {(thread.is_archived || thread.is_snoozed) && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              A live conversation can never sit hidden. If this lead replies again, the new message arrives unread and
              the whole conversation returns to Active — the archive and the snooze both lift. Your important mark is
              yours and stays put.
            </p>
          )}

          <MessageTrail
            key={thread.id}
            messages={thread.messages}
            renderExtras={(m) => (
              <div className="space-y-1">
                {m.direction === 'out' && (
                  <MessageStatusLine
                    message={m}
                    onCancelled={async (msg) => {
                      try {
                        await api.del(`/api/scheduled/${msg.id}`)
                        announce?.('Queued email cancelled')
                        load(); onChanged?.()
                      } catch (err) { toast(err.message, 'error') }
                    }}
                  />
                )}
                {m.direction === 'out' && (m.opened_at || m.clicked_at) && (
                  <div className="text-[11px] text-slate-500">
                    {m.opened_at && <span title={absolute(m.opened_at)}>Opened {relative(m.opened_at)}</span>}
                    {m.opened_at && m.clicked_at && ' · '}
                    {m.clicked_at && <span title={absolute(m.clicked_at)}>Clicked {relative(m.clicked_at)}</span>}
                  </div>
                )}
                <Menu
                  label="Message actions"
                  ariaLabel={`Actions for the message of ${absolute(m.created_at)}`}
                  buttonClass="text-[11px] text-slate-500 underline cursor-pointer hover:text-slate-700"
                  items={[{ key: 'forward', label: 'Forward this message', hint: 'Asks you to confirm before anything is sent', onSelect: () => setForwarding(m) }]}
                />
              </div>
            )}
          />

          {/* ---- reply ---------------------------------------------------- */}
          {thread.lead && thread.campaign ? (
            <ReplyComposer
              thread={thread}
              onSent={(result) => {
                announce?.(result.scheduled ? `Reply queued for ${absolute(result.scheduledAt)}` : 'Reply sent')
                toast(result.scheduled ? `Queued — goes out around ${absolute(result.scheduledAt)}` : 'Reply sent')
                load(); onChanged?.()
              }}
            />
          ) : (
            <p className="text-xs text-slate-500">
              A manual reply needs a campaign, a lead and a mailbox. This conversation is missing one of them.
            </p>
          )}

          {/* Triage, reminders, notes and tasks are about the lead rather than
              about the mail, so they sit behind one disclosure at the foot of
              the pane. Everything is still here; none of it is in the way of
              reading the conversation, which is what the pane is for. */}
          <section className="rounded-xl border border-slate-200">
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-xs font-medium text-slate-700 hover:text-ink-900"
            >
              <span>Lead details, reminders, notes and tasks</span>
              <span aria-hidden className="text-slate-400">{detailsOpen ? '▲' : '▼'}</span>
            </button>

            {detailsOpen && (
              <div className="space-y-3 border-t border-slate-200 p-3">
                {thread.campaignLead ? (
                  <section aria-label="Lead triage" className="grid gap-3 sm:grid-cols-2">
                    <AssigneeControl
                      campaignLeadId={thread.campaignLead.id}
                      value={thread.campaignLead.assigned_email}
                      refs={refs}
                      onChanged={() => { load(); onChanged?.() }}
                    />
                    <CategoryControl
                      campaignLeadId={thread.campaignLead.id}
                      intent={thread.campaignLead.intent}
                      categoryId={thread.campaignLead.category_id}
                      refs={refs}
                      onChanged={(r) => {
                        announce?.(r?.routed ? 'Reply reclassified and the lead rerouted' : 'Reply category updated')
                        load(); onChanged?.()
                      }}
                    />
                    <RevenueField
                      campaignLeadId={thread.campaignLead.id}
                      revenue={thread.campaignLead.revenue}
                      onChanged={() => { load(); onChanged?.() }}
                    />
                    <div className="sm:col-span-2">
                      <ResumeControl campaignLead={thread.campaignLead} onChanged={() => { load(); onChanged?.() }} />
                    </div>
                  </section>
                ) : (
                  <p className="text-xs text-slate-500">
                    This conversation is not paired with a campaign lead, so there is nothing to triage on it yet.
                  </p>
                )}

                <ThreadPanels thread={thread} refs={refs} announce={announce} onChanged={async () => { await load(); onChanged?.() }} />
              </div>
            )}
          </section>
        </div>
      </div>

      {snoozing && (
        <SnoozeDialog
          onClose={() => setSnoozing(false)}
          onConfirm={async (iso) => { await patch({ snoozedUntil: iso }, `Snoozed until ${absolute(iso)}`); setSnoozing(false) }}
        />
      )}
      {forwarding && (
        <ForwardDialog
          thread={thread}
          message={forwarding}
          onClose={() => setForwarding(null)}
          onSent={(result) => {
            setForwarding(null)
            toast(`Forwarded to ${result.recipients} recipient${result.recipients === 1 ? '' : 's'}`)
            announce?.('Message forwarded')
            load(); onChanged?.()
          }}
        />
      )}
      {blocking && (
        <BlockDomainDialog
          address={blocking}
          onClose={() => setBlocking(null)}
          onDone={(result, value) => {
            setBlocking(null)
            toast(`${value} blocked — ${result.affectedLeads} lead${result.affectedLeads === 1 ? '' : 's'} stopped`)
            load(); onChanged?.()
          }}
        />
      )}
      {moving && (
        <SubsequenceDialog
          thread={thread}
          onClose={() => setMoving(false)}
          onDone={(result, target) => {
            setMoving(false)
            toast(`Moved into ${target?.name || 'the subsequence'} — the first email still needs your OK`)
            load(); onChanged?.()
          }}
        />
      )}
    </div>
  )
}
