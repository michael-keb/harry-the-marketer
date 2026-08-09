// Settings — everything the agent needs to know, asked as questions.
//
// The briefing used to be one blank textarea, which is the hardest possible
// thing to fill in well. It is now five questions with examples: the same
// information, but nobody has to invent the structure. What you type is
// composed into the briefing every prompt reads (shared/profile.js).
//
// Two rules shape the page as a whole:
//
//   * It is a set of pages, not one scroll. Seven areas, each its own address
//     under /app/settings/…, so "where do I change that?" is answered by a menu
//     rather than by a search of two thousand pixels — and so a link can point
//     at the thing it means.
//   * Nothing is hidden behind a button. Every value is on screen and readable
//     the moment the area opens; Edit is what makes it typeable, not what makes
//     it visible. A setting you have to click to read is a setting nobody
//     audits.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { Badge, PageHeader, useToast, timeAgo } from '../ui.jsx'
import { PROFILE_FIELDS, VOICES } from '../../../shared/profile.js'
import { EditableSection, Readout } from '../settings/common.jsx'
// The SmartLead-parity backlog adds five things a workspace needs and Harry had
// nowhere to put. All five are areas of this page rather than navigation
// items — the standing rule is that a new feature should not cost a new thing to
// think about, and 203 of the backlog's 210 endpoints keep it.
import BlockListSection from '../settings/BlockListSection.jsx'
import SendControlsSection from '../settings/SendControlsSection.jsx'
import WebhooksSection from '../settings/WebhooksSection.jsx'
import ClientsSection from '../settings/ClientsSection.jsx'
import TeamActivity from '../settings/TeamActivity.jsx'
import IntegrationsSection from '../settings/IntegrationsSection.jsx'
import BillingSection from '../settings/BillingSection.jsx'

// The order is the order someone meets them: who you are, what goes out, who is
// off limits, who gets told, who else is here, what is plugged in, and finally
// the account itself.
const AREAS = [
  { id: 'briefing', label: 'Briefing', blurb: 'What the agent knows about you, and the agreement people sign.' },
  { id: 'sending', label: 'Sending', blurb: 'Whether you see each email first, and every limit on when one may leave.' },
  { id: 'never-contact', label: 'Never contact', blurb: 'Addresses and domains nothing will ever be sent to.' },
  { id: 'alerts', label: 'Alerts', blurb: 'Where Harry tells you something happened — your channel, and your systems.' },
  { id: 'team', label: 'Team & clients', blurb: 'Who shares this workspace, and which brands it is scoped into.' },
  { id: 'connections', label: 'Integrations', blurb: 'Your Google Sheet, and optional providers Harry can reach. Email and SMS live under Connections in the main nav.' },
  { id: 'billing', label: 'Billing', blurb: 'Your plan — subscribe or manage on Stripe’s hosted pages.' },
  { id: 'account', label: 'Account', blurb: 'How you sign in.' },
]

const DEFAULT_AREA = AREAS[0].id

export default function Settings({ user, onSaved }) {
  // Mounted at /app/settings/* — the splat is the area. An unknown or missing
  // one lands on the briefing rather than on an error: a stale bookmark should
  // open Settings, not break it.
  const params = useParams()
  const requested = (params['*'] || '').split('/')[0]
  const areaId = AREAS.some((a) => a.id === requested) ? requested : DEFAULT_AREA
  const area = AREAS.find((a) => a.id === areaId)

  // On a phone the strip is wider than the screen, and landing on Account from
  // a link would otherwise show a menu with the current area scrolled off it.
  const current = useRef(null)
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [areaId])

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Settings" lead="Everything here is readable as it stands. Press Edit on a block to change it." />

      <nav aria-label="Settings areas" className="tab-row">
        {AREAS.map((a) => (
          <Link
            key={a.id}
            to={`/app/settings/${a.id}`}
            ref={a.id === areaId ? current : undefined}
            aria-current={a.id === areaId ? 'page' : undefined}
            className={`tab ${a.id === areaId ? 'is-active' : ''}`}
          >
            {a.label}
          </Link>
        ))}
      </nav>

      <p className="text-md text-slate-500">{area.blurb}</p>

      {areaId === 'briefing' && (
        <>
          <BriefingSection user={user} onSaved={onSaved} />
          <AgreementSection user={user} onSaved={onSaved} />
        </>
      )}

      {areaId === 'sending' && (
        <>
          <SendingSection user={user} onSaved={onSaved} />
          {/* Directly under Sending: the same subject, one level down. Sending
              is the two decisions everyone makes (do I see each email, and do I
              send at a human pace); this is every lever underneath them. */}
          <SendControlsSection />
          <p className="text-sm text-slate-500">
            Addresses nothing is ever sent to live under{' '}
            <Link className="underline hover:text-slate-700" to="/app/settings/never-contact">Never contact</Link> —
            it is the first place to look when an email did not go out.
          </p>
        </>
      )}

      {/* Suppression is its own area rather than a block under Sending: it is a
          searchable list that grows, and it is what someone opens when asking
          "why did this not go out?". */}
      {areaId === 'never-contact' && <BlockListSection />}

      {areaId === 'alerts' && (
        <>
          <AlertsSection user={user} onSaved={onSaved} />
          {/* Directly under the Slack/Teams block: the same idea, one step
              further out — tell my own systems, not just my channel. */}
          <WebhooksSection />
        </>
      )}

      {areaId === 'team' && (
        <>
          <TeamSection />
          {/* Directly under the member list, and deliberately not on Reports.
              Beside campaign performance these figures read as a scoreboard
              ranking colleagues; under the list of who is in the workspace they
              read as context for a conversation about workload. It renders
              nothing at all in a solo workspace. */}
          <TeamActivity />
          {/* Beside Team on purpose: the two are one click apart and mean
              opposite things, so the distinction is drawn where both are
              visible. */}
          <ClientsSection />
        </>
      )}

      {areaId === 'connections' && (
        <>
          <section className="card space-y-2 p-5">
            <h2 className="font-semibold text-ink-900">Email &amp; messaging</h2>
            <p className="text-sm text-slate-600">
              Gmail, Outlook, SMS, WhatsApp and Telegram are managed under{' '}
              <Link className="underline hover:text-slate-700" to="/app/connections">Connections</Link>{' '}
              in the main navigation — Email for mailboxes, Messages for SMS and chat apps.
            </p>
          </section>
          <SheetSection user={user} onSaved={onSaved} />
          <IntegrationsSection />
        </>
      )}

      {areaId === 'billing' && <BillingSection user={user} />}

      {areaId === 'account' && (
        <section className="card p-5 space-y-2">
          <h2 className="font-semibold text-ink-900">Account</h2>
          <div className="text-sm text-slate-600">Signed in as <span className="text-ink-900">{user.email}</span></div>
          <p className="text-xs text-slate-500">
            Sign-in is handled by Auth0 when configured (AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET in .env);
            otherwise local dev login is active. Gmail sending uses Google OAuth per mailbox. Setup steps for both are in the README.
            Plan and payment live under{' '}
            <Link className="underline hover:text-slate-700" to="/app/settings/billing">Billing</Link>.
          </p>
        </section>
      )}
    </div>
  )
}

// ---- the briefing -----------------------------------------------------------

function BriefingSection({ user, onSaved }) {
  const toast = useToast()
  const [profile, setProfile] = useState(() => ({ voice: 'direct', ...(user.profile || {}) }))
  const [meetingLink, setMeetingLink] = useState(user.meetingLink || '')
  const [busy, setBusy] = useState(false)

  const set = (key) => (e) => setProfile((p) => ({ ...p, [key]: e.target.value }))

  const save = async () => {
    setBusy(true)
    try {
      await api.put('/api/settings', { profile, meetingLink })
      toast('Saved — the agent uses this from the next email')
      onSaved()
      return true
    } catch (err) { toast(err.message, 'error'); return false } finally { setBusy(false) }
  }

  // Backing out throws away the draft and shows what is actually stored.
  const revert = () => {
    setProfile({ voice: 'direct', ...(user.profile || {}) })
    setMeetingLink(user.meetingLink || '')
  }

  // Someone who wrote a briefing by hand before the questions existed keeps it
  // until they answer one — we say so rather than silently ignoring their work.
  const legacyContext = Object.keys(user.profile || {}).length === 0 && (user.businessContext || '').trim()

  return (
    <EditableSection
      id="briefing"
      title="What the agent knows about you"
      description="Answered once, and every email is written from them — the more specific you are, the less you'll want to edit. Shared by the whole workspace."
      onSave={save}
      onCancel={revert}
      busy={busy}
    >
      {({ editing }) => (<>
        {legacyContext && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="mb-1.5 text-xs font-medium text-slate-500">Your current briefing (still in use until you answer below)</div>
            <pre className="readout font-mono text-[13px]">{legacyContext}</pre>
          </div>
        )}
        {editing ? (
        <>
          {PROFILE_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="block text-md font-semibold text-ink-900" htmlFor={`profile-${f.key}`}>{f.label}</label>
              <p className="mt-1 mb-2 text-xs text-slate-500">{f.hint}</p>
              <textarea id={`profile-${f.key}`} className="input min-h-24"
                placeholder={f.placeholder} value={profile[f.key] || ''} onChange={set(f.key)} />
            </div>
          ))}

          <div>
            <span className="mb-2 block text-md font-semibold text-ink-900">How it should sound</span>
            <div className="flex flex-wrap gap-2">
              {VOICES.map((v) => (
                <button key={v.key} type="button" onClick={() => setProfile((p) => ({ ...p, voice: v.key }))}
                  aria-pressed={profile.voice === v.key}
                  className={`cursor-pointer rounded-full border px-3.5 py-1.5 text-xs transition-colors disabled:cursor-default ${
                    profile.voice === v.key ? 'border-accent-500 bg-accent-50 text-accent-700 font-medium' : 'border-slate-300 text-slate-600 hover:border-ink-950'
                  }`}>
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-md font-semibold text-ink-900" htmlFor="meeting-link">Booking link</label>
            <p className="mt-1 mb-2 text-xs text-slate-500">Included whenever the agent proposes a call.</p>
            <input id="meeting-link" className="input" type="url" placeholder="https://cal.com/yourname/20min"
              value={meetingLink} onChange={(e) => setMeetingLink(e.target.value)} />
          </div>
        </>
      ) : (
        <>
          {PROFILE_FIELDS.map((f) => (
            <Readout key={f.key} label={f.label} hint={f.hint} value={profile[f.key]} />
          ))}
          <Readout
            label="How it should sound"
            hint="The register every email is written in."
            value={VOICES.find((v) => v.key === profile.voice)?.label}
            placeholder="Not chosen yet"
          />
          <Readout
            label="Booking link"
            hint="Included whenever the agent proposes a call."
            value={meetingLink}
            placeholder="No link yet"
          />
        </>
      )}
      </>)}
    </EditableSection>
  )
}

// ---- team -------------------------------------------------------------------

function TeamSection() {
  const toast = useToast()
  const [team, setTeam] = useState(null)
  const [inviteEmail, setInviteEmail] = useState('')

  const loadTeam = useCallback(async () => {
    try { setTeam(await api.get('/api/team')) } catch { /* surfaced via page errors elsewhere */ }
  }, [])
  useEffect(() => { loadTeam() }, [loadTeam])

  const invite = async (e) => {
    e.preventDefault()
    try {
      await api.post('/api/team/invite', { email: inviteEmail })
      toast(`Invited ${inviteEmail} — they join this workspace the first time they sign in`)
      setInviteEmail('')
      loadTeam()
    } catch (err) { toast(err.message, 'error') }
  }

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold text-ink-900">Team &amp; coach</h2>
      {team === null ? (
        <p className="text-sm text-slate-500">Loading team…</p>
      ) : team.shared ? (
        <p className="text-sm text-slate-600">
          You are a <span className="text-ink-900">{team.role}</span> in <span className="text-ink-900">{team.ownerEmail}</span>'s
          workspace — you share their leads, campaigns, mailboxes, and inbox, and you can approve emails before they send.
          Only the owner manages members.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Invite a teammate — or your coach or assessor — by email. When they sign in with that address they work in
            this workspace and can review and approve every email before it goes out.
          </p>
          <form onSubmit={invite} className="flex gap-2">
            <input className="input flex-1" type="email" required placeholder="coach@company.com"
              aria-label="Teammate's email address"
              value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            <button className="btn-primary shrink-0">Invite</button>
          </form>
          {team.members.length === 0 ? (
            <p className="text-sm text-slate-500">No members yet — it's just you.</p>
          ) : (
            <ul className="divide-y divide-slate-200">
              {team.members.map((m) => (
                <li key={m.id} className="py-2.5 flex items-center gap-3 text-sm">
                  <span className="text-ink-900">{m.email}</span>
                  <Badge value={m.status === 'active' ? 'connected' : 'waiting'} />
                  <span className="text-xs text-slate-500">invited {timeAgo(m.invitedAt)}</span>
                  <button className="ml-auto text-xs text-slate-600 hover:text-red-600 cursor-pointer"
                    onClick={async () => {
                      if (!confirm(`Remove ${m.email} from the workspace?`)) return
                      try { await api.del(`/api/team/${m.id}`); toast('Member removed'); loadTeam() } catch (err) { toast(err.message, 'error') }
                    }}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

// ---- sending ----------------------------------------------------------------

function Switch({ on, onClick, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer ${on ? 'bg-accent-500' : 'bg-slate-300'}`}>
      <span className={`block size-5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

function SendingSection({ user, onSaved }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [mailboxes, setMailboxes] = useState([])
  const on = user.requireApproval
  const sending = user.sending || {}

  useEffect(() => {
    api.get('/api/mailboxes').then((r) => setMailboxes(r.mailboxes)).catch(() => { /* shown on its own page */ })
  }, [user])

  const save = async (patch, message) => {
    setBusy(true)
    try {
      // The timezone rides along with every save: nobody should have to pick
      // their own out of a list of four hundred.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      await api.put('/api/settings', { sending: { ...sending, timezone, ...patch } })
      if (message) toast(message)
      onSaved()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const toggleApproval = async () => {
    if (on && !confirm('Let the agent send emails without showing them to you first?')) return
    setBusy(true)
    try {
      await api.put('/api/settings', { requireApproval: !on })
      toast(on ? 'Emails will now send without asking you' : 'Nothing will send without your OK')
      onSaved()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  const gmail = mailboxes.filter((m) => m.provider === 'gmail')

  return (
    // Every control here commits the moment it is touched — there is nothing to
    // press Save on, so the button says Done. The state is legible either way.
    <EditableSection
      id="sending"
      title="Sending"
      description="Whether each email waits for you, and the pace it goes out at."
      instant
      busy={busy}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-700">Show me every email before it sends</div>
          <p className="text-xs text-slate-500 mt-1">
            {on
              ? 'The agent researches, writes and times each email, then waits in your Inbox under "Needs your OK". Your name is on it, so you send it.'
              : 'The agent sends on its own. Faster, but you find out what went out afterwards — and unattended sending is what makes outreach feel like spam.'}
          </p>
        </div>
        <Switch on={on} onClick={toggleApproval} label="Show me every email before it sends" />
      </div>

      <div className="border-t border-slate-200 pt-5 space-y-3">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-700">Send at a human pace</div>
            <p className="text-xs text-slate-500 mt-1">
              {sending.paced
                ? 'One email at a time per mailbox, with a random gap, only during the hours below. A new mailbox starts at 10 a day and works up. Sandbox mailboxes ignore all of this so you can still test in seconds.'
                : 'Emails go out as fast as the engine can send them. Twenty at once, at 3am, from a week-old mailbox is the pattern spam filters are built to catch.'}
            </p>
          </div>
          <Switch on={Boolean(sending.paced)} label="Send at a human pace"
            onClick={() => save({ paced: !sending.paced }, sending.paced ? 'Pacing off — emails send as soon as they are ready' : 'Pacing on')} />
        </div>

        {sending.paced && (
          <>
            {/* Saved on blur, not per keystroke — a time input fires onChange
                for every digit, and half a time is not a setting. */}
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="block text-xs text-slate-600 mb-1" htmlFor="send-from">Send between</label>
                <input id="send-from" type="time" className="input w-auto" defaultValue={sending.from || '08:30'}
                  onBlur={(e) => e.target.value !== sending.from && save({ from: e.target.value }, 'Sending hours updated')} />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1" htmlFor="send-to">and</label>
                <input id="send-to" type="time" className="input w-auto" defaultValue={sending.to || '17:30'}
                  onBlur={(e) => e.target.value !== sending.to && save({ to: e.target.value }, 'Sending hours updated')} />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1" htmlFor="send-days">on</label>
                <select id="send-days" className="input w-auto" value={sending.days || 'weekdays'}
                  onChange={(e) => save({ days: e.target.value })}>
                  <option value="weekdays">weekdays</option>
                  <option value="everyday">every day</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Times are in {sending.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} — taken from this browser, not asked for.
            </p>
          </>
        )}

        {gmail.length > 0 && (
          <ul className="space-y-1.5 pt-1">
            {gmail.map((m) => (
              <li key={m.id} className="text-xs text-slate-500">
                <span className="text-slate-700">{m.email}</span>
                {' — '}
                {m.sending?.warmingUp
                  ? <span className="text-amber-700">warming up: {m.sending.cap} a day for now (limit {m.dailyLimit})</span>
                  : <>up to {m.dailyLimit} a day</>}
                {', '}{m.remainingToday} left today
              </li>
            ))}
            <li className="text-xs text-slate-400">
              Change a mailbox's daily limit under <a className="underline hover:text-slate-600" href="/app/connections?area=email">Connections → Email</a>.
            </li>
          </ul>
        )}
      </div>
    </EditableSection>
  )
}

// ---- alerts -----------------------------------------------------------------

function AlertsSection({ user, onSaved }) {
  const toast = useToast()
  const [webhook, setWebhook] = useState(user.alertWebhook || '')
  const [busy, setBusy] = useState(false)

  const saveAndTest = async () => {
    setBusy(true)
    try {
      await api.put('/api/settings', { alertWebhook: webhook })
      onSaved()
      if (webhook.trim()) {
        const result = await api.post('/api/settings/alert-test', { webhook })
        toast(`Test message sent to ${result.kind === 'slack' ? 'Slack' : 'Teams'}`)
      } else {
        toast('Alerts turned off')
      }
      return true
    } catch (err) { toast(err.message, 'error'); return false } finally { setBusy(false) }
  }

  return (
    <EditableSection
      id="alert-webhook"
      title="Slack or Teams alerts"
      description="Paste an incoming-webhook URL from the channel you actually watch. You'll get a ping when someone replies, when an email needs your OK, and when a lead needs a decision — so you don't have to keep this open."
      note={user.alertWebhook ? undefined : 'Nothing is set — alerts are off, and everything waits in the Inbox instead.'}
      saveLabel={webhook.trim() ? 'Save & test' : 'Save'}
      onSave={saveAndTest}
      onCancel={() => setWebhook(user.alertWebhook || '')}
      busy={busy}
    >
      <input className="input" type="url" placeholder="https://hooks.slack.com/services/…"
        aria-label="Slack or Teams incoming-webhook URL"
        value={webhook} onChange={(e) => setWebhook(e.target.value)} />
      <p className="text-xs text-slate-500">
        Slack: <span className="text-slate-600">Apps → Incoming Webhooks → Add to a channel</span>. Teams:{' '}
        <span className="text-slate-600">channel → Workflows → "Post to a channel when a webhook request is received"</span>.
      </p>
    </EditableSection>
  )
}

// ---- the agreement ----------------------------------------------------------

function AgreementSection({ user, onSaved }) {
  const toast = useToast()
  const [preview, setPreview] = useState(null)
  const [editing, setEditing] = useState(false)
  const [terms, setTerms] = useState(user.consentTerms || '')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setPreview(await api.get('/api/settings/agreement-preview')) } catch { /* section stays quiet */ }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true)
    try {
      await api.put('/api/settings', { consentTerms: terms })
      toast('Agreement wording saved')
      setEditing(false)
      onSaved()
      load()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink-900">The agreement people sign</h2>
          <p className="mt-1 text-sm text-slate-600">
            Once someone says they're interested, the agent includes a link to this page. They read it, type their
            name, and click agree — one click for them, a dated record for you. It is written for you already.
          </p>
        </div>
        {/* The wording itself is below either way; this only decides whether it
            can be typed over. */}
        <button type="button" className="btn-ghost shrink-0"
          onClick={() => { if (editing) { setTerms(user.consentTerms || ''); setEditing(false) } else setEditing(true) }}>
          {editing ? 'Cancel' : preview?.custom ? 'Edit' : 'Write my own'}
        </button>
      </div>
      {editing ? (
        <>
          <textarea className="input min-h-40 text-[13px]" value={terms} onChange={(e) => setTerms(e.target.value)}
            aria-label="Agreement wording"
            placeholder={preview?.terms} />
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save wording'}</button>
          </div>
        </>
      ) : (
        <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 text-[13px] text-slate-700">
          {preview?.terms || 'Loading…'}
        </pre>
      )}
    </section>
  )
}

// ---- google sheet -----------------------------------------------------------

function SheetSection({ user, onSaved }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const sheet = user.sheet || {}

  const run = async (fn, done) => {
    setBusy(true)
    try { const result = await fn(); toast(done(result)); onSaved() } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold text-ink-900">Google Sheet</h2>
      {sheet.id ? (
        <>
          <p className="text-sm text-slate-600">
            Your prospects and their stage are kept up to date in a Google Sheet — handy for anyone who'd rather
            work in a spreadsheet. It updates on its own; edits you make there are overwritten, not read back.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <a className="btn-primary" href={sheet.url} target="_blank" rel="noreferrer">Open the sheet</a>
            <button className="btn-ghost" disabled={busy}
              onClick={() => run(() => api.post('/api/sheet/sync'), () => 'Sheet updated')}>
              {busy ? 'Working…' : 'Update now'}
            </button>
            <span className="text-xs text-slate-500">
              {sheet.syncedAt ? `last updated ${timeAgo(sheet.syncedAt)}` : 'not synced yet'}
            </span>
            <button className="ml-auto text-xs text-slate-500 hover:text-red-600 cursor-pointer" disabled={busy}
              onClick={() => {
                if (!confirm('Stop updating this sheet? The spreadsheet itself is left alone.')) return
                run(() => api.del('/api/sheet'), () => 'Sheet disconnected — the file is still in your Drive')
              }}>Disconnect</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            One button makes a spreadsheet in your Google Drive and keeps it filled in with every prospect and
            where they've got to. Nothing to name, nothing to paste.
          </p>
          <button className="btn-primary w-fit" disabled={busy}
            onClick={() => run(() => api.post('/api/sheet/create'), () => 'Sheet created and filled in')}>
            {busy ? 'Creating…' : 'Create my Google Sheet'}
          </button>
          <p className="text-xs text-slate-500">
            Needs a connected Gmail account. Harry can only see the file it creates, never the rest of your Drive.
          </p>
        </>
      )}
    </section>
  )
}
