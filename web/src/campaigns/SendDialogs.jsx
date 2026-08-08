// The three things on this page that put mail on the wire: a test send, a manual
// reply, and a forward.
//
// All three require `confirm: true` in the body — the backend refuses without
// it, by design ("Nothing sends without the user's OK", Docs/README.md). That is
// not a formality to be ticked automatically: each dialog states plainly that
// this sends a real email, and the confirm box is the user's own act.
//
// A test send additionally needs `confirm_real_lead` when the address belongs to
// somebody in the workspace, so a test can never become an unapproved approach
// to a real prospect.

import { useState } from 'react'
import { api } from '../api.js'
import { Modal, useToast } from '../ui.jsx'
import { LiveRegion } from '../parity-ui.jsx'
import { Field, errorFor, fieldOf, messageOf } from './shared.jsx'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function SendNotice({ children }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {children}
    </p>
  )
}

// ------------------------------------------------------------- test send ----

export function TestSendDialog({ campaignId, steps = [], mailboxes = [], leads = [], defaultNodeId = '', userEmail = '', onClose }) {
  const toast = useToast()
  const sendSteps = steps.filter((s) => s.type === 'send')
  const [nodeId, setNodeId] = useState(defaultNodeId || sendSteps[0]?.nodeId || '')
  const [toEmail, setToEmail] = useState(userEmail)
  const [mailboxId, setMailboxId] = useState('')
  const [leadId, setLeadId] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [confirmRealLead, setConfirmRealLead] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)

  const realLeadPrompt = err && fieldOf(err) === 'to_email' && /confirm_real_lead/.test(messageOf(err))

  const send = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/test-send`, {
        confirm: true,
        node_id: nodeId,
        to_email: toEmail.trim(),
        ...(mailboxId ? { mailbox_id: Number(mailboxId) } : {}),
        ...(leadId ? { lead_id: Number(leadId) } : {}),
        ...(confirmRealLead ? { confirm_real_lead: true } : {}),
      })
      setResult(res)
      toast(`Test sent to ${res.sentTo}`)
    } catch (error) {
      setErr(error)
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Send me a test" onClose={onClose} wide>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-900" role="status">
            Sent to <span className="text-accent-700">{result.sentTo}</span> from{' '}
            <span className="text-accent-700">{result.mailbox}</span>. It is recorded as a test and is excluded
            from every figure in Reports.
          </p>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-sm font-medium text-ink-900">{result.subject}</div>
            <pre className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">{result.body}</pre>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost cursor-pointer" onClick={() => { setResult(null); setConfirm(false) }}>Send another</button>
            <button className="btn-primary cursor-pointer" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : sendSteps.length === 0 ? (
        <p className="text-sm text-slate-600">
          This playbook has no Send steps yet — there is nothing to test. Draw a{' '}
          <span className="font-mono text-accent-700">Send:</span> node first.
        </p>
      ) : (
        <div className="space-y-3">
          <Field label="Which step" htmlFor="ts-node" error={errorFor(err, 'node_id')}>
            <select id="ts-node" className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              {sendSteps.map((s) => (
                <option key={s.nodeId} value={s.nodeId}>
                  {s.label || s.instruction || s.nodeId}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Send it to"
            htmlFor="ts-to"
            hint="Prefilled with your own address."
            error={realLeadPrompt ? '' : errorFor(err, 'to_email')}
          >
            <input id="ts-to" type="email" className="input" value={toEmail} onChange={(e) => { setToEmail(e.target.value); setConfirmRealLead(false) }} />
          </Field>

          <Field
            label="Write it for (optional)"
            htmlFor="ts-lead"
            hint={leads.length ? 'The email is personalised from this person’s details.' : 'No leads attached, so a stand-in is used. Attach leads to preview against a real one.'}
          >
            <select id="ts-lead" className="input" value={leadId} onChange={(e) => setLeadId(e.target.value)} disabled={!leads.length}>
              <option value="">Example lead</option>
              {leads.map((l) => (
                <option key={l.leadId} value={l.leadId}>
                  {[l.firstName, l.lastName].filter(Boolean).join(' ') || l.email}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Send from (optional)" htmlFor="ts-mailbox" error={errorFor(err, 'mailbox_id')}>
            <select id="ts-mailbox" className="input" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              <option value="">First mailbox in this campaign’s pool</option>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </Field>

          <SendNotice>
            This puts a real email on the wire from a real mailbox and uses one of that mailbox’s sends for
            today. It is marked as a test, so it never reaches a count in Reports.
          </SendNotice>

          {realLeadPrompt && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5" role="alert">
              <p className="text-xs text-red-700">{messageOf(err)}</p>
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-red-700">
                <input type="checkbox" className="mt-0.5 accent-accent-500" checked={confirmRealLead}
                  onChange={(e) => setConfirmRealLead(e.target.checked)} />
                Yes — I really mean to email this person, who is a lead in this workspace.
              </label>
            </div>
          )}

          {err && !fieldOf(err) && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}
          {err && fieldOf(err) === 'confirm' && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}

          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 accent-accent-500" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            Yes — send this email now.
          </label>

          <div className="flex justify-end gap-2">
            <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn-primary cursor-pointer"
              disabled={busy || !confirm || !EMAIL_RE.test(toEmail.trim()) || !nodeId || (realLeadPrompt && !confirmRealLead)}
              onClick={send}
            >
              {busy ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ----------------------------------------------------------------- reply ----

export function ReplyDialog({ campaignId, message, leadEmail, onClose, onSent }) {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [later, setLater] = useState(false)
  const [when, setWhen] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState('')

  const split = (text) => text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)

  const send = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/threads/${message.id}/reply`, {
        confirm: true,
        body,
        ...(cc.trim() ? { cc: split(cc) } : {}),
        ...(bcc.trim() ? { bcc: split(bcc) } : {}),
        ...(later && when ? { scheduled_time: new Date(when).toISOString() } : {}),
      })
      setNote(res.scheduled ? `Reply scheduled for ${new Date(res.scheduledAt).toLocaleString()}` : 'Reply sent')
      toast(res.scheduled ? 'Reply scheduled' : 'Reply sent')
      onSent?.()
    } catch (error) {
      // Nothing typed is lost on any failure path.
      setErr(error)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Reply to ${leadEmail || 'this thread'}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Re: {message.subject || '(no subject)'} — this goes into the existing thread, through the same mailer
          an agent send uses, so the opt-out line and tracking are identical.
        </p>

        <Field label="Your reply" htmlFor="rp-body" error={errorFor(err, 'body')}>
          <textarea id="rp-body" className="input min-h-40" autoFocus value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>

        {!showCopies ? (
          <button type="button" className="cursor-pointer text-xs text-accent-700 hover:underline" onClick={() => setShowCopies(true)}>
            Add CC or BCC
          </button>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="CC" htmlFor="rp-cc" hint="Comma separated." error={errorFor(err, 'cc')}>
              <input id="rp-cc" className="input" value={cc} onChange={(e) => setCc(e.target.value)} />
            </Field>
            <Field label="BCC" htmlFor="rp-bcc" hint="Comma separated." error={errorFor(err, 'bcc')}>
              <input id="rp-bcc" className="input" value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </Field>
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="accent-accent-500" checked={later} onChange={(e) => setLater(e.target.checked)} />
          Send later
        </label>
        {later && (
          <Field label="When" htmlFor="rp-when" hint="It is parked, not sent — the sending rhythm still picks the minute." error={errorFor(err, 'scheduled_time')}>
            <input id="rp-when" type="datetime-local" className="input w-auto" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        )}

        <SendNotice>
          {later
            ? 'This schedules a real email to this person from your mailbox. You can still see it in the thread before it goes.'
            : 'This sends a real email to this person from your mailbox, right now.'}
        </SendNotice>

        {err && !fieldOf(err) && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}
        {err && fieldOf(err) === 'confirm' && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}

        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 accent-accent-500" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Yes — {later ? 'schedule' : 'send'} this email.
        </label>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary cursor-pointer" disabled={busy || !confirm || !body.trim() || (later && !when)} onClick={send}>
            {busy ? 'Sending…' : later ? 'Schedule reply' : 'Send reply'}
          </button>
        </div>
        <LiveRegion message={note} />
      </div>
    </Modal>
  )
}

// --------------------------------------------------------------- forward ----

export function ForwardDialog({ campaignId, message, mailboxEmail, onClose, onSent }) {
  const toast = useToast()
  const [recipients, setRecipients] = useState([])
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const add = () => {
    const value = draft.trim().toLowerCase()
    if (!value) return
    if (!EMAIL_RE.test(value)) { setErr(new Error(`${value} is not a valid email address`)); return }
    if (recipients.length >= 10) { setErr(new Error('At most 10 recipients')); return }
    setErr(null)
    setRecipients((prev) => (prev.includes(value) ? prev : [...prev, value]))
    setDraft('')
  }

  const send = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.post(`/api/campaigns/${campaignId}/messages/${message.id}/forward`, {
        confirm: true,
        to: recipients,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      toast(`Forwarded to ${recipients.join(', ')}`)
      onSent?.()
    } catch (error) {
      setErr(error)
      setBusy(false)
    }
  }

  return (
    <Modal title="Forward this email" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Sent from {mailboxEmail || 'the mailbox this thread belongs to'}. A forward carries no tracking pixel,
          no wrapped links and no opt-out footer, and it does not move the lead anywhere in the playbook.
          The lead’s own address is refused here — use Reply for that.
        </p>

        <Field label="Forward to" htmlFor="fw-to" hint="Up to ten addresses. Press Enter to add each one." error={errorFor(err, 'to')}>
          <div className="flex gap-2">
            <input
              id="fw-to"
              className="input"
              autoFocus
              type="email"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            />
            <button type="button" className="btn-ghost cursor-pointer shrink-0" onClick={add}>Add</button>
          </div>
        </Field>

        {recipients.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {recipients.map((address) => (
              <li key={address}>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-ink-900">
                  {address}
                  <button
                    type="button"
                    className="cursor-pointer text-slate-500 hover:text-red-600"
                    aria-label={`Remove ${address}`}
                    onClick={() => setRecipients((prev) => prev.filter((r) => r !== address))}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <Field label="Note (optional)" htmlFor="fw-note" hint="Goes above the quoted original." error={errorFor(err, 'note')}>
          <textarea id="fw-note" className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Forwarded message</div>
          <div className="mt-1 text-sm text-ink-900">{message.subject || '(no subject)'}</div>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">
            {String(message.body || '').replace(/<[^>]+>/g, '')}
          </pre>
        </div>

        <SendNotice>This puts a real email on the wire and uses one of that mailbox’s sends for today.</SendNotice>

        {err && !fieldOf(err) && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}

        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 accent-accent-500" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Yes — forward this email now.
        </label>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary cursor-pointer" disabled={busy || !confirm || recipients.length === 0} onClick={send}>
            {busy ? 'Forwarding…' : 'Forward'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
