// Adding a mailbox. Three paths, and only two of them can finish here.
//
// Gmail is OAuth and always will be: consent happens on Google's screen and the
// callback writes the row, which is why nothing in this form accepts a token.
// Sandbox is local and instant. SMTP is validated by the server and then
// deliberately not stored — this build has no SMTP/IMAP client and the
// mailboxes table accepts gmail and sandbox only — so that path says so before
// a single field is typed, not after the password has been sent.

import { useState } from 'react'
import { api } from '../api.js'
import { LiveRegion, Modal } from '../parity-ui.jsx'
import { Field, fieldError, useAnnounce } from './common.jsx'

const PRESETS = {
  none: { label: 'Type them myself', smtpHost: '', smtpPort: 587, imapHost: '', imapPort: 993 },
  gmail: { label: 'Gmail / Google Workspace', smtpHost: 'smtp.gmail.com', smtpPort: 587, imapHost: 'imap.gmail.com', imapPort: 993 },
  outlook: { label: 'Outlook / Microsoft 365', smtpHost: 'smtp.office365.com', smtpPort: 587, imapHost: 'outlook.office365.com', imapPort: 993 },
}

// A 422 may name either spelling depending on which one was sent.
const err2 = (err, a, b) => fieldError(err, a) || fieldError(err, b)

export default function AddMailbox({ googleConfigured, onClose, onAdded }) {
  const [path, setPath] = useState('gmail')
  const [announcement, say] = useAnnounce()

  return (
    <Modal title="Add a mailbox" onClose={onClose} wide>
      <LiveRegion message={announcement} />

      <div className="flex gap-1 border-b border-slate-200 mb-4" role="tablist" aria-label="How to add a mailbox">
        {[
          ['gmail', 'Connect Gmail'],
          ['sandbox', 'Sandbox'],
          ['smtp', 'SMTP details'],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`add-mailbox-tab-${id}`}
            aria-controls={`add-mailbox-panel-${id}`}
            aria-selected={path === id}
            className={`cursor-pointer border-b-2 px-3 py-2 text-sm ${
              path === id ? 'border-accent-500 text-accent-700 font-medium' : 'border-transparent text-slate-600 hover:text-ink-900'
            }`}
            onClick={() => setPath(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Each pane is a real tabpanel tied back to its tab, so the chosen path
          is announced as one rather than as loose content below a button. */}
      <div role="tabpanel" id={`add-mailbox-panel-${path}`} aria-labelledby={`add-mailbox-tab-${path}`}>
        {path === 'gmail' && <GmailPath googleConfigured={googleConfigured} say={say} />}
        {path === 'sandbox' && <SandboxPath onAdded={onAdded} onClose={onClose} say={say} />}
        {path === 'smtp' && <SmtpPath say={say} />}
      </div>
    </Modal>
  )
}

function GmailPath({ googleConfigured, say }) {
  const [email, setEmail] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const check = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.post('/api/mailboxes', { type: 'GMAIL', fromEmail: email })
      setResult(res)
      say(res.message)
    } catch (err) {
      setError(err)
      say(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!googleConfigured) {
    return (
      <div className="card border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
        <p className="font-medium">Google OAuth is not connected.</p>
        <p className="mt-0.5 text-amber-700">
          Set <span className="font-mono">GOOGLE_CLIENT_ID</span> and <span className="font-mono">GOOGLE_CLIENT_SECRET</span>{' '}
          in your environment to connect a real Gmail account. Sandbox mailboxes still work, and everything
          already connected keeps sending.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={check} className="space-y-3">
      <p className="text-xs text-slate-600">
        Consent happens on Google's own screen. Harry never accepts a password or a token here — it
        receives a refresh token from Google and nothing else.
      </p>
      <Field
        id="gmail-address"
        label="Gmail address (optional)"
        help="Only used to tell you whether this address is already connected. Leave it empty to just start consent."
        error={fieldError(error, 'fromEmail')}
      >
        {({ id, describedBy }) => (
          <input id={id} type="email" className="input" value={email} aria-describedby={describedBy}
            autoComplete="off" placeholder="you@yourdomain.com" onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>

      {result && (
        <p className="text-xs text-slate-700 rounded-lg border border-slate-200 bg-white/40 px-3 py-2">{result.message}</p>
      )}
      {error && !error.payload?.field && (
        <p role="alert" className="text-xs text-red-700">{error.message}</p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="submit" className="btn-ghost" disabled={busy}>{busy ? 'Checking…' : 'Check this address'}</button>
        <a className="btn-primary" href="/api/google/connect">Continue to Google</a>
      </div>
    </form>
  )
}

function SandboxPath({ onAdded, onClose, say }) {
  const [name, setName] = useState('Sandbox Sender')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/api/mailboxes', { type: 'SANDBOX', fromName: name })
      say(`Sandbox mailbox ${res.data?.fromEmail || ''} added`)
      onAdded?.(res.data)
      onClose()
    } catch (err) {
      setError(err)
      say(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-slate-600">
        A sandbox mailbox records sends locally and lets you simulate replies, so a playbook can be run
        end to end without connecting anything. It skips the clock and the gap — the daily limit still applies.
      </p>
      <Field id="sandbox-name" label="Sender name" error={fieldError(error, 'fromName')}>
        {({ id, describedBy }) => (
          <input id={id} className="input" value={name} autoFocus aria-describedby={describedBy}
            onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      {error && !error.payload?.field && <p role="alert" className="text-xs text-red-700">{error.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add sandbox mailbox'}</button>
      </div>
    </form>
  )
}

function SmtpPath({ say }) {
  const [preset, setPreset] = useState('none')
  const [form, setForm] = useState({
    fromName: '', fromEmail: '', userName: '', password: '',
    smtpHost: '', smtpPort: 587, imapHost: '', imapPort: 993,
  })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [refusal, setRefusal] = useState(null)

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const usePreset = (id) => {
    setPreset(id)
    const p = PRESETS[id]
    set({ smtpHost: p.smtpHost, smtpPort: p.smtpPort, imapHost: p.imapHost, imapPort: p.imapPort })
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setRefusal(null)
    try {
      await api.post('/api/mailboxes', {
        type: 'SMTP',
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        userName: form.userName,
        password: form.password,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort),
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort),
      })
    } catch (err) {
      if (err.status === 501) {
        setRefusal(err.payload || { message: err.message })
        say('Details are valid, but this build cannot send over SMTP. Nothing was saved.')
      } else {
        setError(err)
        say(err.message)
      }
    } finally {
      // The password exists in this component for exactly one request.
      set({ password: '' })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Stated before the form, not after the password has been typed. */}
      <div className="card border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
        <p className="font-medium">This build cannot send over SMTP.</p>
        <p className="mt-0.5 text-amber-700">
          Harry has no SMTP or IMAP client and its mailboxes table accepts Gmail and sandbox only. The server
          will check these details and answer 501: <span className="font-medium">nothing is saved, and the
          password is not stored, logged or echoed back</span>. Use it to verify a server's settings, not to
          connect a mailbox.
        </p>
      </div>

      <button type="button" className="btn-ghost cursor-pointer" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide the checker' : 'Check my server details anyway'}
      </button>

      {open && (
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          <Field id="smtp-preset" label="Known provider">
            {({ id }) => (
              <select id={id} className="input cursor-pointer" value={preset} onChange={(e) => usePreset(e.target.value)}>
                {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
              </select>
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="smtp-name" label="Display name" error={err2(error, 'fromName', 'from_name')}>
              {({ id, describedBy }) => (
                <input id={id} className="input" value={form.fromName} aria-describedby={describedBy}
                  onChange={(e) => set({ fromName: e.target.value })} />
              )}
            </Field>
            <Field id="smtp-email" label="Address" error={err2(error, 'fromEmail', 'from_email')}>
              {({ id, describedBy }) => (
                <input id={id} type="email" className="input" value={form.fromEmail} aria-describedby={describedBy}
                  onChange={(e) => set({ fromEmail: e.target.value })} />
              )}
            </Field>
            <Field id="smtp-user" label="Username" error={err2(error, 'userName', 'user_name')}>
              {({ id, describedBy }) => (
                <input id={id} className="input" value={form.userName} autoComplete="off" aria-describedby={describedBy}
                  onChange={(e) => set({ userName: e.target.value })} />
              )}
            </Field>
            <Field
              id="smtp-pass" label="Password"
              help="Required by the validator. It is sent once, discarded by the server, and cleared from this form the moment you submit."
              error={fieldError(error, 'password')}
            >
              {({ id, describedBy }) => (
                <input id={id} type="password" className="input" value={form.password} autoComplete="new-password"
                  aria-describedby={describedBy} onChange={(e) => set({ password: e.target.value })} />
              )}
            </Field>
            <Field id="smtp-host" label="SMTP host" error={err2(error, 'smtpHost', 'smtp_host')}>
              {({ id, describedBy }) => (
                <input id={id} className="input" value={form.smtpHost} aria-describedby={describedBy}
                  placeholder="smtp.example.com" onChange={(e) => set({ smtpHost: e.target.value })} />
              )}
            </Field>
            <Field id="smtp-port" label="SMTP port" error={err2(error, 'smtpPort', 'smtp_port')}>
              {({ id, describedBy }) => (
                <input id={id} type="number" className="input" value={form.smtpPort} min={1} max={65535}
                  aria-describedby={describedBy} onChange={(e) => set({ smtpPort: e.target.value })} />
              )}
            </Field>
            <Field id="imap-host" label="IMAP host" error={err2(error, 'imapHost', 'imap_host')}>
              {({ id, describedBy }) => (
                <input id={id} className="input" value={form.imapHost} aria-describedby={describedBy}
                  placeholder="imap.example.com" onChange={(e) => set({ imapHost: e.target.value })} />
              )}
            </Field>
            <Field id="imap-port" label="IMAP port" error={err2(error, 'imapPort', 'imap_port')}>
              {({ id, describedBy }) => (
                <input id={id} type="number" className="input" value={form.imapPort} min={1} max={65535}
                  aria-describedby={describedBy} onChange={(e) => set({ imapPort: e.target.value })} />
              )}
            </Field>
          </div>

          {error && !error.payload?.field && <p role="alert" className="text-xs text-red-700">{error.message}</p>}

          {refusal && (
            <div className="card border-slate-300 px-4 py-3 text-xs text-slate-700" role="status">
              <p className="font-medium text-ink-950">
                Details check out — but nothing was saved ({refusal.errorCode || 'SMTP_PROVIDER_UNAVAILABLE'})
              </p>
              <p className="mt-1">{refusal.message}</p>
            </div>
          )}

          <div className="flex justify-end">
            <button className="btn-ghost" disabled={busy}>{busy ? 'Checking…' : 'Check details'}</button>
          </div>
        </form>
      )}
    </div>
  )
}
