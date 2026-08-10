// Connections — every outbound channel in one place.
//
// Two top-level areas:
//   Email     — Gmail / Outlook (and sandbox) fleet + sending infrastructure
//   Messages  — SMS (Twilio), WhatsApp, Telegram
//
// `/app/connections?area=email` still redirects here so old links keep working.

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs, useToast } from '../parity-ui.jsx'
import { Notice, PageHeader } from '../ui.jsx'
import AddMailbox from '../mailboxes/AddMailbox.jsx'
import FleetList from '../mailboxes/FleetList.jsx'
import Senders from '../mailboxes/Senders.jsx'
import ChannelsSection from '../settings/ChannelsSection.jsx'

const OAUTH_NOTICE_KEY = 'harry.mailboxes.oauthNoticeDismissed'

const AREAS = [
  { id: 'email', label: 'Email', hint: 'Gmail and Outlook' },
  { id: 'messages', label: 'Messages', hint: 'SMS, WhatsApp, Telegram' },
]

export default function Connections() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const area = AREAS.some((a) => a.id === params.get('area')) ? params.get('area') : 'email'
  const setArea = (id) => {
    const next = new URLSearchParams(params)
    next.set('area', id)
    setParams(next, { replace: true })
  }

  const [emailTab, setEmailTab] = useState('fleet')
  const [meta, setMeta] = useState(null)
  const [adding, setAdding] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [oauthNoticeHidden, setOauthNoticeHidden] = useState(
    () => localStorage.getItem(OAUTH_NOTICE_KEY) === '1'
  )
  const hideOauthNotice = () => {
    localStorage.setItem(OAUTH_NOTICE_KEY, '1')
    setOauthNoticeHidden(true)
  }

  const [entry] = useState(() => {
    const q = new URLSearchParams(window.location.search)
    const connected = q.get('connected')
    const alreadyConnected = q.get('already_connected')
    const alreadyEmail = q.get('email')
    const failed = q.get('error')
    if (connected || alreadyConnected || failed) {
      q.delete('connected')
      q.delete('already_connected')
      q.delete('email')
      q.delete('error')
      // Keep area=email when returning from OAuth.
      if (!q.get('area')) q.set('area', 'email')
      const search = q.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
    }
    return { connected, alreadyConnected, alreadyEmail, failed }
  })

  useEffect(() => {
    if (entry.connected === 'outlook') toast('Outlook account connected')
    else if (entry.connected) toast('Gmail account connected')
    if (entry.alreadyConnected) {
      toast(
        entry.alreadyEmail
          ? `${entry.alreadyEmail} is already connected`
          : 'That account is already connected',
        'info'
      )
    }
    if (entry.failed) toast(entry.failed, 'error')
  }, [entry]) // eslint-disable-line react-hooks/exhaustive-deps

  const googleConfigured = meta?.googleConfigured !== false
  const googleOAuthVerified = Boolean(meta?.googleOAuthVerified)
  const microsoftConfigured = meta?.microsoftConfigured !== false

  const seedDomain = useMemo(() => {
    const gmail = (meta?.data || []).find((m) => m.provider === 'gmail')
    const host = String(gmail?.fromEmail || '').split('@')[1] || ''
    return host.replace(/\.[a-z]+$/i, '')
  }, [meta])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connections"
        lead="Email and messaging — everything Harry sends from, in one place."
        actions={area === 'email' ? (
          <button className="btn-primary" onClick={() => setAdding(true)}>Add email</button>
        ) : null}
      />

      <Tabs
        ariaLabel="Connection areas"
        active={area}
        onChange={setArea}
        tabs={AREAS.map((a) => ({ id: a.id, label: a.label }))}
      />
      <p className="text-sm text-slate-500 -mt-2">
        {AREAS.find((a) => a.id === area)?.hint}
      </p>

      {area === 'email' && (
        <>
          {!googleConfigured && (
            <Notice tone="info" title="Google OAuth isn't configured yet">
              Real Gmail sending is off. Add <span className="font-mono">GOOGLE_CLIENT_ID</span> and{' '}
              <span className="font-mono">GOOGLE_CLIENT_SECRET</span> to .env (setup steps in the README). Meanwhile, sandbox mailboxes let you run
              campaigns end-to-end locally — sends are recorded and replies can be simulated.
            </Notice>
          )}

          {googleConfigured && !googleOAuthVerified && !oauthNoticeHidden && (
            <Notice
              title="Google OAuth is still in Testing — not publicly verified"
              onDismiss={() => hideOauthNotice()}
              actions={
                <>
                  <a className="underline hover:opacity-80" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Open Audience → Test users</a>
                  <a className="underline hover:opacity-80" href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
                  <a className="underline hover:opacity-80" href="/terms" target="_blank" rel="noreferrer">Terms</a>
                </>
              }
            >
              A connected mailbox does not mean Google has verified the app. Until Publishing status is
              In production, every Gmail that clicks Connect must be on the Test users list or they get
              “Access blocked”. App name in the console must be{' '}
              <span className="font-medium">Harry The Marketer</span>.
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                <li>Google Cloud Console → <span className="font-medium">Audience → Test users</span> — add every Gmail that will click Connect.</li>
                <li><span className="font-medium">Branding</span> — app name exactly <span className="font-medium">Harry The Marketer</span>; Privacy <span className="font-mono">https://harrythemarketer.com/privacy</span>; Terms <span className="font-mono">…/terms</span>.</li>
                <li><span className="font-medium">Clients</span> — redirect URIs include <span className="font-mono">http://localhost:8131/api/google/callback</span> and <span className="font-mono">https://harrythemarketer.com/api/google/callback</span>.</li>
                <li>Then use <span className="font-medium">Add email → Gmail</span> while signed into that test user.</li>
              </ol>
            </Notice>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-ink-900">Gmail &amp; Outlook</h2>
            <p className="mt-1 text-xs text-slate-500">
              Connect the inboxes Harry sends from and reads replies in. Sandbox addresses work without OAuth for local testing.
            </p>
          </div>

          <Tabs
            ariaLabel="Email sections"
            active={emailTab}
            onChange={setEmailTab}
            tabs={[
              { id: 'fleet', label: 'Fleet', count: meta?.total },
              { id: 'senders', label: 'Sending infrastructure' },
            ]}
          />

          {emailTab === 'fleet' && (
            <FleetList key={reloadKey} onMeta={setMeta} onAdd={() => setAdding(true)} />
          )}

          {emailTab === 'senders' && (
            <Senders seedDomain={seedDomain} onConnect={() => setAdding(true)} />
          )}

          {adding && (
            <AddMailbox
              googleConfigured={googleConfigured}
              microsoftConfigured={microsoftConfigured}
              onClose={() => setAdding(false)}
              onAdded={() => { setReloadKey((k) => k + 1); setEmailTab('fleet') }}
            />
          )}
        </>
      )}

      {area === 'messages' && (
        <div className="space-y-5">
          <ChannelsSection />

          <ComingChannel
            name="WhatsApp"
            status="Planned"
            body="WhatsApp Business via Twilio or Meta Cloud API. Template messages outside the 24-hour session window; free-form after the lead replies. Same opt-in and quiet-hour rules as SMS."
          />
          <ComingChannel
            name="Telegram"
            status="Planned"
            body="Telegram Bot API. Leads must start the bot (or share a contact) before Harry can message them. No templates — consent is the /start handshake."
          />
        </div>
      )}
    </div>
  )
}

function ComingChannel({ name, status, body }) {
  return (
    <section className="card space-y-2 p-5 opacity-95">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-ink-900">{name}</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{status}</span>
      </div>
      <p className="text-sm text-slate-600">{body}</p>
      <p className="text-xs text-slate-500">
        Connectable here once Phase 2/3 of messaging lands. SMS is available above now.
      </p>
    </section>
  )
}
