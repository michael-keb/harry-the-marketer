// The two things in the Inbox that put real mail on the wire: a manual reply
// and a forward.
//
// Both refuse without `confirm: true` at the API, and both ask for it here in
// the same words the approval queue uses. The confirmation never says "are you
// sure" — it names the mailbox it leaves from, every address it reaches, and
// the fact that it cannot be recalled.

import { useState } from 'react'
import { api } from '../api.js'
import { Modal, useToast } from '../ui.jsx'
import { Banner, FieldError, absolute, fromLocalInput, leadName, relative } from './common.jsx'

const splitAddresses = (raw) => String(raw || '').split(/[,\s;]+/).map((v) => v.trim()).filter(Boolean)

// ------------------------------------------------------------- manual reply --

export function ReplyComposer({ thread, onSent }) {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [subject, setSubject] = useState('')
  const [sendLater, setSendLater] = useState(false)
  const [sendAt, setSendAt] = useState('')
  const [extras, setExtras] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const lead = thread.lead
  const mailbox = thread.messages?.find((m) => m.direction === 'out')?.from_email || ''
  const scheduledIso = sendLater && sendAt ? fromLocalInput(sendAt) : ''

  // Paste the agreement link straight into a manual reply — one click, and the
  // "yes" ends up on the record instead of in someone's memory. Unchanged.
  const addAgreementLink = async () => {
    try {
      const consent = await api.post(`/api/leads/${lead.id}/agreement`)
      setBody((current) => `${current.trimEnd()}${current.trim() ? '\n\n' : ''}When you have a moment, this confirms what you're agreeing to — it takes seconds:\n${consent.url}\n`)
      toast(consent.status === 'signed' ? 'They already signed — link added anyway' : 'Agreement link added to your reply')
    } catch (err) { toast(err.message, 'error') }
  }

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post(`/api/inbox/threads/${thread.id}/reply`, {
        body,
        subject: subject || undefined,
        sendAt: scheduledIso || undefined,
        confirm: true,
      })
      setConfirming(false)
      // The typed reply is only cleared once the server has taken it.
      setBody('')
      setSubject('')
      setSendLater(false)
      setSendAt('')
      onSent(result)
    } catch (err) {
      setError(err)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Write a reply" className="space-y-2">
      <label className="block text-xs text-slate-600" htmlFor="reply-body">Your reply</label>
      <textarea
        id="reply-body"
        className="input min-h-24"
        placeholder="Write a manual reply — it sends from the campaign mailbox and joins the thread…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <button type="button" className="text-xs text-slate-600 underline cursor-pointer hover:text-ink-900" aria-expanded={extras} onClick={() => setExtras((v) => !v)}>
        {extras ? 'Hide subject and send time' : 'Subject and send time'}
      </button>

      {extras && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <div>
            <label className="block text-xs text-slate-600" htmlFor="reply-subject">Subject</label>
            <input
              id="reply-subject" className="input mt-1" value={subject} maxLength={500}
              placeholder="Left blank, it replies on the existing subject line"
              onChange={(e) => setSubject(e.target.value)}
            />
            <FieldError error={error} field="subject" />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" className="accent-accent-500" checked={sendLater} onChange={(e) => setSendLater(e.target.checked)} />
            Send later
          </label>
          {sendLater && (
            <div>
              <label className="block text-xs text-slate-600" htmlFor="reply-at">Send on</label>
              <input
                id="reply-at" type="datetime-local" className="input mt-1"
                value={sendAt} onChange={(e) => setSendAt(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
                {scheduledIso
                  ? `Queued for ${absolute(scheduledIso)} — ${relative(scheduledIso)}. The sending rhythm still picks the exact minute, and you can cancel it from Scheduled until it goes.`
                  : 'Pick a date and time in your own timezone.'}
              </p>
              <FieldError error={error} field="sendAt" />
            </div>
          )}
        </div>
      )}

      <Banner error={error} handled={['subject', 'sendAt']} />

      <div className="flex flex-wrap justify-end gap-2">
        {lead?.id && <button type="button" className="btn-ghost" onClick={addAgreementLink}>Add agreement link</button>}
        <button type="button" className="btn-primary" disabled={!body.trim() || busy} onClick={() => setConfirming(true)}>
          {sendLater ? 'Schedule reply…' : 'Send reply…'}
        </button>
      </div>

      {confirming && (
        <Modal title={sendLater ? 'Queue this reply?' : 'Send this reply?'} onClose={() => setConfirming(false)}>
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              This puts a real email on the wire{mailbox ? <> from <span className="text-ink-950">{mailbox}</span></> : null} to{' '}
              <span className="text-ink-950">{lead?.email || leadName(lead)}</span>
              {sendLater && scheduledIso ? <> {`around ${absolute(scheduledIso)}`}</> : ' now'}. Once it leaves it cannot be recalled.
            </p>
            <p className="text-slate-600">
              It counts against that mailbox's daily allowance and joins the thread, exactly like an email the agent sent.
            </p>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-[13px]">{body}</div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={send} disabled={busy}>
                {busy ? 'Sending…' : sendLater ? 'Yes, queue it' : 'Yes, send it'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- sms reply --

// A text is a text: no subject, no copies, no scheduling. Same endpoint as the
// email reply — the server routes by the thread's channel — and the same rule:
// nothing sends without an explicit OK naming both numbers.
export function SmsReplyComposer({ thread, onSent }) {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const lead = thread.lead
  const from = thread.smsAccount?.phoneNumber || ''
  const to = thread.threadKey?.startsWith('sms:')
    ? thread.threadKey.split(':')[2]
    : thread.messages?.findLast?.((m) => m.direction === 'in')?.from_email || ''

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post(`/api/inbox/threads/${thread.id}/reply`, { body, confirm: true })
      setConfirming(false)
      setBody('')
      onSent(result)
    } catch (err) {
      setError(err)
      setConfirming(false)
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Write a text reply" className="space-y-2">
      <label className="block text-xs text-slate-600" htmlFor="sms-reply-body">Your text reply</label>
      <textarea
        id="sms-reply-body"
        className="input min-h-20"
        maxLength={1600}
        placeholder={`Reply by SMS${from ? ` — it sends from ${from}` : ''} and joins this conversation…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-500" aria-live="polite">
          {body.length}/1600{body.length > 160 ? ` · ~${Math.ceil(body.length / 153)} SMS segments` : ''}
        </span>
        <button type="button" className="btn-primary" disabled={!body.trim() || busy} onClick={() => setConfirming(true)}>
          Send text…
        </button>
      </div>

      <Banner error={error} handled={[]} />

      {confirming && (
        <Modal title="Send this text?" onClose={() => setConfirming(false)}>
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              This sends a real text message{from ? <> from <span className="text-ink-950">{from}</span></> : null} to{' '}
              <span className="text-ink-950">{to || leadName(lead)}</span> now. Once it leaves it cannot be recalled.
            </p>
            <p className="text-slate-600">
              It counts against that number's daily SMS allowance and joins the conversation, exactly like a text the agent sent.
            </p>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-[13px]">{body}</div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={send} disabled={busy}>
                {busy ? 'Sending…' : 'Yes, send it'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

// ----------------------------------------------------------------- forward ---

export function ForwardDialog({ thread, message, onClose, onSent }) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [subject, setSubject] = useState(`Fwd: ${message.subject || ''}`.trim())
  const [note, setNote] = useState('')
  const [includeThread, setIncludeThread] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const ccList = splitAddresses(cc)
  const bccList = splitAddresses(bcc)
  const recipients = [to.trim(), ...ccList, ...bccList].filter(Boolean)
  const mailbox = thread.messages?.find((m) => m.direction === 'out')?.from_email || ''
  const chain = includeThread ? thread.messages : [message]

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post(`/api/threads/${message.id}/forward`, {
        to: to.trim(),
        cc: ccList,
        bcc: bccList,
        subject,
        note,
        includeThread,
        confirm: true,
      })
      onSent(result)
    } catch (err) {
      setError(err)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <Modal title="Forward this conversation?" onClose={() => setConfirming(false)}>
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            This puts a real email on the wire{mailbox ? <> from <span className="text-ink-950">{mailbox}</span></> : null}. Once it
            leaves it cannot be recalled.
          </p>
          <ul className="space-y-1 rounded-lg border border-slate-200 bg-white p-3 text-[13px]">
            <li><span className="text-slate-500">To</span> {to.trim()}</li>
            {ccList.length > 0 && <li><span className="text-slate-500">Cc</span> {ccList.join(', ')}</li>}
            {bccList.length > 0 && <li><span className="text-slate-500">Bcc</span> {bccList.join(', ')}</li>}
            <li><span className="text-slate-500">Subject</span> {subject}</li>
          </ul>
          <p className="text-slate-600">
            {includeThread ? 'The whole conversation is quoted' : 'Only this message is quoted'} — rebuilt from what is stored, with
            tracking pixels and click wrappers stripped out. It counts against that mailbox's daily allowance.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
            <button type="button" className="btn-primary" onClick={send} disabled={busy}>{busy ? 'Forwarding…' : 'Yes, forward it'}</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Forward" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setConfirming(true) }}>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="fwd-to">To</label>
          <input id="fwd-to" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} placeholder="colleague@example.com" autoFocus />
          <FieldError error={error} field="to" />
        </div>

        <button type="button" className="text-xs text-slate-600 underline cursor-pointer hover:text-ink-900" aria-expanded={showCopies} onClick={() => setShowCopies((v) => !v)}>
          {showCopies ? 'Hide Cc and Bcc' : 'Add Cc/Bcc'}
        </button>
        {showCopies && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-slate-600" htmlFor="fwd-cc">Cc</label>
              <input id="fwd-cc" className="input mt-1" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Separate addresses with commas" />
              <FieldError error={error} field="cc" />
            </div>
            <div>
              <label className="block text-xs text-slate-600" htmlFor="fwd-bcc">Bcc</label>
              <input id="fwd-bcc" className="input mt-1" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="Separate addresses with commas" />
              <FieldError error={error} field="bcc" />
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs text-slate-600" htmlFor="fwd-subject">Subject</label>
          <input id="fwd-subject" className="input mt-1" value={subject} maxLength={500} onChange={(e) => setSubject(e.target.value)} />
          <FieldError error={error} field="subject" />
        </div>

        <div>
          <label className="block text-xs text-slate-600" htmlFor="fwd-note">Note (goes above the quoted conversation)</label>
          <textarea id="fwd-note" className="input mt-1 min-h-20" value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
          <FieldError error={error} field="note" />
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" className="accent-accent-500" checked={includeThread} onChange={(e) => setIncludeThread(e.target.checked)} />
          Include the whole conversation
        </label>

        <div>
          <div className="text-xs text-slate-600">What gets quoted</div>
          <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-[12px] text-slate-600" aria-label="Preview of the forwarded conversation">
            {chain.map((m) => (
              <div key={m.id} className="mb-2 whitespace-pre-wrap">
                <div className="text-slate-500">
                  {m.direction === 'in' ? `From ${m.from_email}` : `To ${m.to_email}`} ({absolute(m.created_at)})
                </div>
                {m.body}
              </div>
            ))}
          </div>
        </div>

        <Banner error={error} handled={['to', 'cc', 'bcc', 'subject', 'note']} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={recipients.length === 0}>Forward…</button>
        </div>
      </form>
    </Modal>
  )
}
