// An email waiting for your OK, read in the same pane as everything else.
//
// This is the product's spine. The agent writes; the email stops here; nothing
// goes anywhere until a person says so. Putting it in the reading pane rather
// than in a stack of full-width cards changes where it is, not what it is: the
// draft, the reply that prompted it, and Send it / Edit / Send tomorrow / Don't
// send are all still on one screen, and none of them has lost a confirmation.

import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Badge, clockTime, timeAgo, useToast } from '../ui.jsx'
import { Marker, absolute } from './common.jsx'

export default function DraftPane({ draft, onChanged, onBack, announce }) {
  const toast = useToast()
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  // A different draft is a different email. Without this the edits typed into
  // one would follow the selection onto the next.
  useEffect(() => {
    setSubject(draft.subject)
    setBody(draft.body)
    setEditing(false)
    setBusy(false)
  }, [draft.id, draft.subject, draft.body])

  const edited = subject !== draft.subject || body !== draft.body
  const who = [draft.first_name, draft.last_name].filter(Boolean).join(' ') || draft.lead_email

  const send = async () => {
    setBusy(true)
    try {
      const result = await api.post(`/api/drafts/${draft.id}/approve`, edited ? { subject, body } : {})
      // Approving is "yes, send this", not "send this instant" — the sending
      // rhythm still picks the minute, so say which one.
      toast(result.sent
        ? `Sent to ${who}`
        : `Approved — goes to ${who}${result.sending?.until ? ` around ${clockTime(result.sending.until)}` : ' shortly'}`)
      announce?.(`Approved the email to ${who}`)
      onChanged()
    } catch (err) { toast(err.message, 'error'); setBusy(false) }
  }

  // Approve, but hold this one back. The sending window decides the minute
  // inside a day; this decides the day — "yes, but let it land tomorrow
  // morning" is a judgement about this particular person that no workspace-wide
  // setting can make.
  const sendTomorrow = async () => {
    setBusy(true)
    try {
      await api.post(`/api/drafts/${draft.id}/approve`, edited ? { subject, body } : {})
      const res = await api.post(`/api/queue/${draft.id}/send-at`, { hours: 16 })
      toast(res.sendAfter
        ? `Approved — held for ${who} until tomorrow, then it waits for your sending hours`
        : `Approved — goes to ${who} shortly`)
      announce?.(`Approved the email to ${who}, held until tomorrow`)
      onChanged()
    } catch (err) { toast(err.message, 'error'); setBusy(false) }
  }

  // Keeps its confirmation: declining closes this person's enrolment in the
  // campaign, and the draft the agent wrote is gone. Re-enrolling them is a
  // different act with a different cost, not an undo.
  const decline = async () => {
    if (!confirm(`Don't send this, and stop contacting ${who} in "${draft.campaign_name}"?`)) return
    setBusy(true)
    try {
      await api.post(`/api/drafts/${draft.id}/decline`)
      toast(`${who} stopped — nothing was sent`)
      announce?.(`Stopped contacting ${who}`)
      onChanged()
    } catch (err) { toast(err.message, 'error'); setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-200 px-5 py-3.5">
        {onBack && (
          <button type="button" className="mb-2 cursor-pointer text-xs text-slate-600 underline hover:text-ink-900" onClick={onBack}>
            ← Back to the list
          </button>
        )}
        <h3 tabIndex={-1} data-pane-heading className="text-base font-semibold text-ink-950 outline-none">
          {draft.subject || '(no subject)'}
        </h3>
        <div className="mt-0.5 text-xs text-slate-600">
          <span className="text-slate-400">To</span> {who}
          {draft.lead_email ? ` · ${draft.lead_email}` : ''}
          {draft.company ? ` · ${draft.company}${draft.title ? `, ${draft.title}` : ''}` : ''}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Marker tone="good">Needs your OK</Marker>
          {draft.campaign_status !== 'running' && <Badge value={draft.campaign_status} />}
          {draft.campaign_name && <span className="text-[11px] text-slate-500">{draft.campaign_name}</span>}
          <span className="text-[11px] text-slate-400" title={absolute(draft.created_at)}>
            written {timeAgo(draft.created_at)}
            <span className="sr-only"> — {absolute(draft.created_at)}</span>
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {/* The reply that prompted the draft, above the draft, so the answer is
            read next to the question. */}
        {draft.last_reply && (
          <section
            aria-label="The reply this email answers"
            className="rounded-xl border border-accent-200 border-l-4 border-l-accent-500 bg-accent-50/40 p-3"
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
              <Marker tone="good">They replied</Marker>
              <span>{draft.lead_email}</span>
            </div>
            <div className="whitespace-pre-wrap text-[13px] text-slate-700">{String(draft.last_reply).slice(0, 2000)}</div>
          </section>
        )}

        <section aria-label="The email the agent wrote" className="rounded-xl border border-slate-200 border-l-4 border-l-slate-400 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-[11px] text-slate-600">
            <Marker>Not sent yet</Marker>
            {edited && <Marker tone="warn">Edited by you</Marker>}
            {draft.thread_length > 0 && <span>Message {draft.thread_length + 1} in this conversation</span>}
          </div>

          {editing ? (
            <div className="space-y-2 p-3">
              <div>
                <label className="block text-xs text-slate-600" htmlFor="draft-subject">Subject</label>
                <input id="draft-subject" className="input mt-1 font-medium" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-slate-600" htmlFor="draft-body">Email body</label>
                <textarea id="draft-body" className="input mt-1 min-h-56 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="p-3">
              <div className="text-sm font-medium text-ink-900">{subject}</div>
              <div className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-900">{body}</div>
            </div>
          )}
        </section>
      </div>

      {/* The actions stay pinned: on a long draft, scrolling to the bottom to
          find "Send it" is how an approval queue stops being cleared. */}
      <footer className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary !py-2 text-sm" disabled={busy} onClick={send}>
            {busy ? 'Sending…' : edited ? 'Send my version' : 'Send it'}
          </button>
          <button className="btn-ghost !py-2 text-sm" disabled={busy} onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? 'Done editing' : 'Edit'}
          </button>
          <button className="btn-ghost !py-2 text-sm" disabled={busy} onClick={sendTomorrow}>Send tomorrow</button>
          <button className="ml-auto cursor-pointer text-xs text-slate-500 hover:text-red-600" disabled={busy} onClick={decline}>
            Don't send
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          Nothing has left a mailbox. Approving hands it to the sending rhythm, which picks the minute.
        </p>
      </footer>
    </div>
  )
}
