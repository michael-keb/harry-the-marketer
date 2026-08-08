// Mailboxes — the page where sending capacity lives.
//
// Everything about a mailbox belongs here and nothing about one belongs
// anywhere else: the fleet with its health and usage, the labels that segment
// it, warm-up, suspension, and the supplier flow that buys more capacity. Two
// sections, no new navigation item.

import { useEffect, useMemo, useState } from 'react'
import { Tabs, useToast } from '../parity-ui.jsx'
import { Notice, PageHeader } from '../ui.jsx'
import AddMailbox from '../mailboxes/AddMailbox.jsx'
import FleetList from '../mailboxes/FleetList.jsx'
import Senders from '../mailboxes/Senders.jsx'

const OAUTH_NOTICE_KEY = 'harry.mailboxes.oauthNoticeDismissed'

export default function Mailboxes() {
  const toast = useToast()
  const [tab, setTab] = useState('fleet')
  const [meta, setMeta] = useState(null)
  const [adding, setAdding] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Standing advisory, true until Google verifies the app — so it is closable,
  // and stays closed. Nothing depends on it being on screen.
  const [oauthNoticeHidden, setOauthNoticeHidden] = useState(
    () => localStorage.getItem(OAUTH_NOTICE_KEY) === '1'
  )
  const hideOauthNotice = () => {
    localStorage.setItem(OAUTH_NOTICE_KEY, '1')
    setOauthNoticeHidden(true)
  }

  // The OAuth callback comes back with ?connected= or ?error=. Read and removed
  // during the first render, before the fleet writes its own filters into the
  // query string — so a return from consent never eats an active filter.
  const [entry] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const failed = params.get('error')
    if (connected || failed) {
      params.delete('connected')
      params.delete('error')
      const search = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
    }
    return { connected, failed }
  })

  useEffect(() => {
    if (entry.connected) toast('Gmail account connected')
    if (entry.failed) toast(entry.failed, 'error')
  }, [entry]) // eslint-disable-line react-hooks/exhaustive-deps

  const googleConfigured = meta?.googleConfigured !== false

  // The domain search opens on a lookalike of a domain the user already sends
  // from, which is the difference between a good choice being easy and a blank
  // box in the part of outreach where a bad choice costs deliverability.
  const seedDomain = useMemo(() => {
    const gmail = (meta?.data || []).find((m) => m.provider === 'gmail')
    const host = String(gmail?.fromEmail || '').split('@')[1] || ''
    return host.replace(/\.[a-z]+$/i, '')
  }, [meta])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mailboxes"
        lead="One fleet. Health, daily limits and warm-up in one place."
        actions={<button className="btn-primary" onClick={() => setAdding(true)}>Add a mailbox</button>}
      />

      {!googleConfigured && (
        <Notice tone="info" title="Google OAuth isn't configured yet">
          Real Gmail sending is off. Add <span className="font-mono">GOOGLE_CLIENT_ID</span> and{' '}
          <span className="font-mono">GOOGLE_CLIENT_SECRET</span> to .env (setup steps in the README). Meanwhile, sandbox mailboxes let you run
          campaigns end-to-end locally — sends are recorded and replies can be simulated.
        </Notice>
      )}

      {googleConfigured && !oauthNoticeHidden && (
        <Notice
          title="Google OAuth consent is still in Testing"
          onDismiss={() => hideOauthNotice()}
          actions={
            <>
              <a className="text-amber-800 underline hover:text-amber-900" href="/privacy" target="_blank" rel="noreferrer">Privacy /privacy</a>
              <a className="text-amber-800 underline hover:text-amber-900" href="/terms" target="_blank" rel="noreferrer">Terms /terms</a>
              <span className="text-amber-700">Full checklist in <span className="font-mono">GOOGLE-OAUTH-VERIFICATION.md</span></span>
            </>
          }
        >
          Gmail scopes are sensitive, so every Gmail address you connect must be listed under{' '}
          <span className="font-medium">Test users</span> until Google verifies the app — otherwise the connection is blocked with{' '}
          <span className="italic">“Access blocked: … has not completed the Google verification process.”</span>{' '}
          Project branding in the console should read <span className="font-medium">Harry The Marketer</span>.
        </Notice>
      )}

      <Tabs
        ariaLabel="Mailbox sections"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'fleet', label: 'Fleet', count: meta?.total },
          { id: 'senders', label: 'Sending infrastructure' },
        ]}
      />

      {tab === 'fleet' && (
        <FleetList key={reloadKey} onMeta={setMeta} onAdd={() => setAdding(true)} />
      )}

      {tab === 'senders' && (
        <Senders seedDomain={seedDomain} onConnect={() => setAdding(true)} />
      )}

      {adding && (
        <AddMailbox
          googleConfigured={googleConfigured}
          onClose={() => setAdding(false)}
          onAdded={() => { setReloadKey((k) => k + 1); setTab('fleet') }}
        />
      )}
    </div>
  )
}
