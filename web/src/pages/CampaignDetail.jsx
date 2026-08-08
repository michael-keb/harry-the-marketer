// One campaign.
//
// The playbook IS the campaign: a Mermaid flowchart, edited as text, executed
// per lead. SmartLead's "sequences" are these nodes, which is why the whole
// step-editing surface here is one textarea and a live render, and why the
// Steps view beside it is deliberately read-only. There is no drag-and-drop
// sequence builder, and there is not going to be one.
//
// The page reads two endpoints for the campaign itself: `GET /api/campaigns/:id`
// (the engine's own view — node stats, holding reason, linked goal) and
// `GET /api/campaigns/:id/detail` (the parity assembly — settings, schedule,
// mailboxes, launch blockers, the START/PAUSED/STOPPED state). Everything else
// is fetched by the panel that needs it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import mermaid from 'mermaid'
import { api } from '../api.js'
import { applyInstructions } from '../../../shared/playbook-edit.js'
import { Spinner, ErrorState, Modal, Badge, useToast, clockTime } from '../ui.jsx'
import { Tabs, Confirm, LiveRegion } from '../parity-ui.jsx'
import StatusControl, { LaunchChecklist } from '../campaigns/StatusControl.jsx'
import MetricsStrip from '../campaigns/MetricsStrip.jsx'
import { BehaviourPanel, SchedulePanel } from '../campaigns/SettingsPanel.jsx'
import MailboxesPanel from '../campaigns/MailboxesPanel.jsx'
import LeadsPanel from '../campaigns/LeadsPanel.jsx'
import SubsequencesPanel from '../campaigns/SubsequencesPanel.jsx'
import ManagePanel, { ActivityPanel } from '../campaigns/ManagePanel.jsx'
import { StepsList, NodePerformance, EmailsTable } from '../campaigns/StepsPanel.jsx'
import { TestSendDialog } from '../campaigns/SendDialogs.jsx'
import { StateChip, codeOf, fieldOf, messageOf, nfmt } from '../campaigns/shared.jsx'
import { MERMAID_BRAND_CONFIG } from '../mermaid-theme.js'

mermaid.initialize(MERMAID_BRAND_CONFIG)

const CHEATSHEET = `S([Start])                     one Start node
A[Send: <what to say>]         the agent writes & sends this email
A -- reply: interested --> B   branch on the reply's classified intent
A -- reply --> B               any reply (catch-all)
A -- no reply 3d --> C         timeout if they never answer
W2[Wait: 30d]                  pause, then continue
D{Reply?}                      optional decision diamond
Won([Won: call booked])        terminal — also Lost / Unsubscribed`

const TABS = [
  { id: 'playbook', label: 'Playbook' },
  { id: 'leads', label: 'Leads' },
  { id: 'mailboxes', label: 'Sending from' },
  { id: 'settings', label: 'Settings' },
  { id: 'followons', label: 'Follow-ons' },
  { id: 'activity', label: 'Activity' },
  { id: 'manage', label: 'Manage' },
]

function MermaidPreview({ code }) {
  const [svg, setSvg] = useState('')
  const [renderError, setRenderError] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    let cancelled = false
    const id = ++seq.current
    const timer = setTimeout(async () => {
      try {
        const { svg } = await mermaid.render(`playbook-${id}`, code)
        if (!cancelled) { setSvg(svg); setRenderError('') }
      } catch (err) {
        if (!cancelled) setRenderError(String(err.message || err).split('\n')[0])
        document.getElementById(`dplaybook-${id}`)?.remove() // mermaid leaves an orphan on error
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [code])

  return (
    <div className="relative">
      {renderError && (
        <div className="absolute top-2 right-2 z-10 max-w-[60%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 shadow-sm">
          Diagram syntax: {renderError}
        </div>
      )}
      {/* The canvas scrolls inside itself so a wide diagram never scrolls the page. */}
      <div
        className="mermaid-canvas flex min-h-64 items-center justify-center overflow-x-auto p-4"
        role="img"
        aria-label="Rendered playbook diagram. The Steps view lists the same nodes and edges as text."
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

export default function CampaignDetail({ user }) {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()

  const [legacy, setLegacy] = useState(null)   // engine view
  const [detail, setDetail] = useState(null)   // parity view
  const [steps, setSteps] = useState([])
  const [mailboxes, setMailboxes] = useState([])
  const [poolMailboxes, setPoolMailboxes] = useState([])
  const [goals, setGoals] = useState([])
  const [error, setError] = useState(null)

  const [code, setCode] = useState(null)       // editor buffer; null until first load
  const [validation, setValidation] = useState(null)
  const [pendingCopy, setPendingCopy] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [runningConflict, setRunningConflict] = useState(false)
  const [affected, setAffected] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const [generating, setGenerating] = useState(false)
  const [genBrief, setGenBrief] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genWithSamples, setGenWithSamples] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [showCheatsheet, setShowCheatsheet] = useState(false)
  const [testSendNode, setTestSendNode] = useState(null)   // '' means "no node chosen yet"
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [selectedNode, setSelectedNode] = useState('')
  const [emailStep, setEmailStep] = useState('')

  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'playbook'
  const setTab = (next) => setParams((prev) => {
    const p = new URLSearchParams(prev)
    p.set('tab', next)
    return p
  }, { replace: true })

  const dirty = legacy && code !== null && (code !== legacy.mermaid || pendingCopy !== null)

  const load = useCallback(async (opts = {}) => {
    try {
      const [c, d, mb, gs] = await Promise.all([
        api.get(`/api/campaigns/${id}`),
        api.get(`/api/campaigns/${id}/detail`),
        api.get('/api/mailboxes'),
        api.get('/api/goals'),
      ])
      setLegacy(c)
      setDetail(d)
      setMailboxes(mb.mailboxes || [])
      setPoolMailboxes(d.mailboxes || [])
      setGoals(gs)
      setError(null)
      setCode((prev) => (opts.resetEditor || prev === null ? c.mermaid : prev))
      if (opts.resetEditor) setValidation(c.validation)
    } catch (err) { setError(err) }
  }, [id])

  useEffect(() => { load({ resetEditor: true }) }, [load])

  // The step projection feeds the test-send picker, the follow-on trigger list,
  // the intent preview in the lead drawer and the emails filter. One fetch, not
  // four.
  const loadSteps = useCallback(async () => {
    try {
      const res = await api.get(`/api/campaigns/${id}/steps`)
      setSteps(res.steps || [])
    } catch { /* an invalid diagram simply has no steps yet */ }
  }, [id])
  useEffect(() => { loadSteps() }, [loadSteps])

  // ?preview=1 — how a campaign built from a goal hands you straight to the
  // emails it will send. Consumed once so a refresh doesn't rewrite them all.
  useEffect(() => {
    if (code === null || !params.get('preview')) return
    setPreviewing(true)
    setParams((p) => { const next = new URLSearchParams(p); next.delete('preview'); return next }, { replace: true })
  }, [code, params, setParams])

  // Poll for engine progress while running (without clobbering the editor).
  useEffect(() => {
    const timer = setInterval(() => load(), 8000)
    return () => clearInterval(timer)
  }, [load])

  // Live server-side validation as the user edits.
  useEffect(() => {
    if (code === null) return
    const timer = setTimeout(async () => {
      try { setValidation(await api.post('/api/playbook/validate', { mermaid: code })) } catch { /* server offline; keep last */ }
    }, 500)
    return () => clearTimeout(timer)
  }, [code])

  // Which steps leads are standing on that the new diagram no longer mentions.
  // The server is the authority — it parks those leads as "needs attention" —
  // but the warning belongs before the save, not after it.
  const strandedNodes = useMemo(() => {
    if (!legacy || code === null) return []
    const live = (legacy.leads || []).filter((l) => !['finished', 'stopped'].includes(l.state) && l.node_id)
    const out = new Map()
    for (const l of live) {
      const present = new RegExp(`(^|[^A-Za-z0-9_])${l.node_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'm').test(code)
      if (!present) out.set(l.node_id, (out.get(l.node_id) || 0) + 1)
    }
    return [...out.entries()].map(([node, count]) => ({ node, count }))
  }, [legacy, code])

  if (error) return <ErrorState error={error} onRetry={() => load({ resetEditor: true })} />
  if (!legacy || !detail || code === null) return <Spinner label="Loading campaign…" />

  const campaign = { ...detail, name: detail.name }
  const sandbox = poolMailboxes.some((m) => m.provider === 'sandbox')
    || mailboxes.some((m) => m.id === legacy.mailboxId && m.provider === 'sandbox')

  const refresh = async () => { await load(); await loadSteps() }

  const rename = async (value) => {
    try {
      await api.put(`/api/campaigns/${id}/settings`, { name: value })
      setNote('Renamed')
      toast('Renamed')
      await load()
    } catch (err) { toast(messageOf(err), 'error') }
  }

  // The diagram, and any copy approved alongside it, are one edit. The sequence
  // route validates and remaps; the approved copy rides in immediately after so
  // a step and the email it sends never land apart.
  const writePlaybook = async () => {
    setBusy('save')
    setSaveError(null)
    setRunningConflict(false)
    try {
      const res = await api.put(`/api/campaigns/${id}/sequence`, { mermaid: code })
      if (pendingCopy) {
        await api.put(`/api/campaigns/${id}`, { approvedCopy: pendingCopy })
        setPendingCopy(null)
      }
      const parts = [`${res.steps} step${res.steps === 1 ? '' : 's'} saved`]
      if (res.remapped) parts.push(`${res.remapped} lead${res.remapped === 1 ? '' : 's'} moved to needs attention`)
      if (res.droppedCopy) parts.push(`${res.droppedCopy} piece${res.droppedCopy === 1 ? '' : 's'} of approved copy dropped with their steps`)
      setNote(parts.join(' — '))
      toast(parts.join(' — '))
      await refresh()
      await load({ resetEditor: true })
      return true
    } catch (err) {
      if (codeOf(err) === 'campaign_running') setRunningConflict(true)
      else if (fieldOf(err) === 'mermaid') setSaveError(err)
      else toast(messageOf(err), 'error')
      return false
    } finally { setBusy(''); setAffected(null) }
  }

  const savePlaybook = () => {
    if (strandedNodes.length) { setAffected(strandedNodes); return }
    writePlaybook()
  }

  const pauseThenSave = async () => {
    setBusy('save')
    try {
      await api.put(`/api/campaigns/${id}/status`, { status: 'PAUSED' })
      setRunningConflict(false)
      await writePlaybook()
    } catch (err) { toast(messageOf(err), 'error'); setBusy('') }
  }

  const runEngine = async () => {
    setBusy('tick')
    try {
      await api.post('/api/engine/tick')
      toast('Engine ran — statuses updated')
      await refresh()
    } catch (err) { toast(messageOf(err), 'error') } finally { setBusy('') }
  }

  const goTo = (field) => {
    if (field === 'mailboxes') setTab('mailboxes')
    else if (field === 'leads') setTab('leads')
    else setTab('playbook')
  }

  return (
    <div className="space-y-5">
      <LiveRegion message={note} />

      {/* Header — breadcrumb, the name (editable in place), what state it is in,
          and the moves that apply to the whole campaign. */}
      <div>
        <nav className="mb-3 text-sm text-slate-500" aria-label="Breadcrumb">
          <Link to="/app/campaigns" className="hover:text-ink-900">Campaigns</Link>
          <span className="mx-2" aria-hidden>›</span>
          <span className="text-slate-400">{detail.name}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-x-7 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-80 items-center gap-3">
            <input
              className="-mx-2 min-w-0 flex-1 rounded-md bg-transparent px-2 py-0.5 text-3xl font-semibold text-ink-900 hover:bg-slate-100 focus:bg-white focus:outline-2 focus:outline-accent-500"
              defaultValue={detail.name}
              key={detail.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== detail.name) rename(v) }}
              aria-label="Campaign name"
            />
            <StateChip state={detail.state} />
          </div>
          <StatusControl
            campaign={campaign}
            onChanged={refresh}
            onDuplicate={() => { setTab('manage'); setDuplicateOpen(true) }}
            onGoTo={goTo}
            showChip={false}
            actions={
              <>
                <button className="btn-ghost" onClick={() => setTestSendNode('')}>Send me a test</button>
                <button className="btn-primary" disabled={Boolean(busy)} onClick={runEngine}
                  title="The engine also runs automatically every 20s">
                  {busy === 'tick' ? 'Running…' : 'Run engine now'}
                </button>
              </>
            }
          />
        </div>

        {/* The linked goal reads as a fact with a way to change it, not as a
            form control that happens to be sitting under the title. */}
        <div className="mt-4 inline-flex max-w-full items-center gap-2.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm">
          <span className="shrink-0 text-slate-500">Goal</span>
          <span className="min-w-0 truncate font-medium text-ink-900">{legacy.goal?.name || 'Not linked'}</span>
          {/* The picker is a real <select>, laid transparently over the word
              "Change" — so the goal is read once as a fact and the control that
              changes it is still a native listbox for keyboard and AT. */}
          <span className="relative shrink-0">
            <span aria-hidden className="text-accent-700">Change</span>
            <select
              className="absolute inset-0 w-full cursor-pointer opacity-0"
              value={legacy.goal?.id || ''}
              onChange={async (e) => {
                try {
                  await api.put(`/api/campaigns/${id}/goal`, { goalId: e.target.value ? Number(e.target.value) : null })
                  toast(e.target.value ? 'Goal linked — AI generation and progress now use it' : 'Goal unlinked')
                  load()
                } catch (err) { toast(messageOf(err), 'error') }
              }}
              aria-label="Linked goal"
            >
              <option value="">No linked goal</option>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name.slice(0, 60)}</option>)}
            </select>
          </span>
        </div>
      </div>

      {detail.parent && (
        <p className="text-sm text-slate-500">
          Leads arrive from{' '}
          <Link className="text-accent-700 hover:underline" to={`/app/campaigns/${detail.parent.id}`}>{detail.parent.name}</Link>.
        </p>
      )}

      {mailboxes.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          You have no mailboxes yet — <Link className="underline" to="/app/mailboxes">connect Gmail or add a sandbox mailbox</Link> before launching.
        </div>
      )}

      {/* Why a running campaign is quiet right now. Without this, waiting for a
          sending window looks identical to being broken.
          Shown for every gate, not only the clock: a plan stopped by a hold, a
          bounce brake or a frequency cap is exactly as quiet, and guessing
          which one it is was the old version of this box. */}
      {detail.state === 'START' && !legacy.sending?.ok && legacy.sending?.reason && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600" role="status">
          Holding — <span className="text-ink-900">{legacy.sending.reason}</span>.
          {legacy.sending.until
            ? <> Next email around <span className="text-ink-900">{clockTime(legacy.sending.until)}</span>.</>
            : <> Nothing clears this on its own.</>}
          {' '}
          {legacy.sending.needs === 'reconnect'
            ? <Link className="underline hover:text-slate-700" to="/app/mailboxes">Reconnect the mailbox</Link>
            : <Link className="underline hover:text-slate-700" to="/app/settings/sending">Change the send controls</Link>}
        </div>
      )}

      <LaunchChecklist blockers={detail.blockers} onGoTo={goTo} />

      <MetricsStrip campaignId={id} onOpenSetting={() => setTab('settings')} />

      <Tabs tabs={TABS.map((t) => (
        t.id === 'leads' ? { ...t, count: detail.counts?.total }
          : t.id === 'followons' ? { ...t, count: detail.children?.length }
            : t
      ))} active={tab} onChange={setTab} ariaLabel="Campaign sections" />

      {tab === 'playbook' && (
        <div className="space-y-4">
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="card flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-slate-700">
                  Playbook <span className="font-normal text-slate-500">(Mermaid — this diagram IS the campaign)</span>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="cursor-pointer text-xs text-slate-600 hover:text-accent-700" onClick={() => setShowCheatsheet(true)}>Syntax help</button>
                  <button
                    className="btn-ghost cursor-pointer px-3 py-1 text-xs"
                    disabled={validation ? !validation.valid : false}
                    title={validation && !validation.valid ? 'Fix the playbook errors first' : 'See the actual emails this diagram would send'}
                    onClick={() => setPreviewing(true)}
                  >
                    Preview emails
                  </button>
                  <button className="btn-ghost cursor-pointer px-3 py-1 text-xs" onClick={() => setGenerating(true)}>Generate with AI</button>
                  <button className="btn-primary cursor-pointer px-3 py-1 text-xs" disabled={!dirty || Boolean(busy)} onClick={savePlaybook}>
                    {busy === 'save' ? 'Saving…' : dirty ? 'Save playbook' : 'Saved'}
                  </button>
                </div>
              </div>
              <textarea
                className="min-h-105 w-full flex-1 resize-y rounded-b-xl bg-white p-4 font-mono text-[13px] leading-relaxed text-ink-900 focus:outline-none"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-label="Playbook mermaid source"
                aria-describedby={saveError ? 'playbook-save-error' : undefined}
              />
            </div>
            <div className="space-y-3">
              <div className="card">
                <div className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700">Live preview</div>
                <MermaidPreview code={code} />
              </div>

              {runningConflict && (
                <div className="card border-amber-200 bg-amber-50 p-4" role="alert">
                  <p className="text-sm text-amber-800">
                    This campaign is running, so its sequence cannot be changed underneath the leads walking through it.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button className="btn-primary cursor-pointer" disabled={Boolean(busy)} onClick={pauseThenSave}>
                      Pause and save
                    </button>
                    <button className="btn-ghost cursor-pointer" onClick={() => setRunningConflict(false)}>Cancel</button>
                  </div>
                </div>
              )}

              {saveError && (
                <div id="playbook-save-error" className="card border-red-200 p-4" role="alert">
                  <p className="text-sm font-semibold text-red-700">The server refused this diagram</p>
                  <p className="mt-1 text-sm text-red-700">{messageOf(saveError)}</p>
                  {saveError.payload?.errors?.length > 1 && (
                    <ul className="mt-2 space-y-1 text-xs text-red-700">
                      {saveError.payload.errors.map((e, i) => (
                        <li key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <ValidationPanel validation={validation} />

              {strandedNodes.length > 0 && (
                <div className="card border-amber-200 bg-amber-50 p-4" role="status">
                  <p className="text-sm text-amber-800">
                    {nfmt(strandedNodes.reduce((a, s) => a + s.count, 0))} lead
                    {strandedNodes.reduce((a, s) => a + s.count, 0) === 1 ? ' is' : 's are'} standing on a step this
                    draft no longer mentions.
                  </p>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-amber-700">
                    {strandedNodes.map((s) => (
                      <li key={s.node}><span className="font-mono">{s.node}</span> — {nfmt(s.count)} lead{s.count === 1 ? '' : 's'}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-amber-700">
                    Saving parks them as “needs attention” rather than restarting them. Nothing is resent.
                  </p>
                </div>
              )}
            </div>
          </section>

          <StepsList
            campaignId={id}
            onTestSend={(nodeId) => setTestSendNode(nodeId)}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
          <NodePerformance nodeStats={legacy.nodeStats} selectedNode={selectedNode} onSelectNode={setSelectedNode} />
          <EmailsTable campaignId={id} steps={steps} step={emailStep} onStepChange={setEmailStep} />
        </div>
      )}

      {tab === 'leads' && (
        <LeadsPanel
          campaign={campaign}
          steps={steps}
          poolMailboxes={poolMailboxes}
          sandbox={sandbox}
          onChanged={refresh}
        />
      )}

      {tab === 'mailboxes' && <MailboxesPanel campaign={campaign} onChanged={refresh} />}

      {tab === 'settings' && (
        <div className="space-y-4">
          <BehaviourPanel campaign={campaign} onSaved={refresh} />
          <SchedulePanel campaign={campaign} onSaved={refresh} />
        </div>
      )}

      {tab === 'followons' && <SubsequencesPanel campaign={campaign} steps={steps} onChanged={refresh} />}

      {tab === 'activity' && <ActivityPanel campaignId={id} />}

      {tab === 'manage' && (
        <ManagePanel
          campaign={campaign}
          onChanged={refresh}
          onDuplicateRequest={() => setDuplicateOpen(true)}
          duplicateOpen={duplicateOpen}
          onCloseDuplicate={() => setDuplicateOpen(false)}
        />
      )}

      {affected && (
        <Confirm
          title="Some leads are standing on steps you removed"
          confirmLabel="Save anyway"
          body={
            `${affected.reduce((a, s) => a + s.count, 0)} lead(s) are currently at ${affected.map((s) => s.node).join(', ')}, `
            + 'which this version of the diagram no longer contains. Saving parks them as "needs attention" so you can '
            + 'decide what happens to each one. They are never silently restarted, and nothing is resent.'
          }
          onConfirm={writePlaybook}
          onClose={() => setAffected(null)}
        />
      )}

      {showCheatsheet && (
        <Modal title="Playbook syntax" onClose={() => setShowCheatsheet(false)} wide>
          <p className="mb-3 text-sm text-slate-600">
            The playbook is a standard Mermaid flowchart. The agent composes each <span className="font-mono text-accent-700">Send:</span> email
            from your instruction, the lead's data, your business context, and the thread so far — then waits, classifies replies, and follows the matching edge.
          </p>
          <pre className="overflow-x-auto whitespace-pre rounded-lg bg-white p-4 font-mono text-[13px] text-slate-700">{CHEATSHEET}</pre>
          <p className="mt-3 text-xs text-slate-500">
            Intents can be anything — the classifier picks the best match from your edge labels (plus built-ins: interested, not interested,
            not now, question, unsubscribe, out of office). Replies with no matching edge flag the lead for your attention in the Inbox.
          </p>
        </Modal>
      )}

      {generating && (
        <Modal title="Generate playbook with AI" onClose={() => setGenerating(false)}>
          <p className="mb-3 text-sm text-slate-600">
            The agent designs the full diagram from your brief
            {legacy.goal ? <> and the linked goal <span className="text-ink-900">"{legacy.goal.name}"</span></> : null}, plus your
            business context. The result lands in the editor for review — nothing is saved until you save.
          </p>
          <textarea
            className="input min-h-24"
            placeholder={'Optional brief, e.g. "Aggressive 5-touch sequence over 2 weeks; lead with the reporting-time proof point; escalate to a call offer fast."'}
            value={genBrief}
            onChange={(e) => setGenBrief(e.target.value)}
            aria-label="Brief for the AI"
          />
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="accent-accent-500" checked={genWithSamples} onChange={(e) => setGenWithSamples(e.target.checked)} />
            Also write a sample email for every step, so I can read what it sends
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost cursor-pointer" onClick={() => setGenerating(false)}>Cancel</button>
            <button className="btn-primary cursor-pointer" disabled={genBusy} onClick={async () => {
              setGenBusy(true)
              try {
                const result = await api.post(`/api/campaigns/${id}/generate-playbook`, { brief: genBrief })
                setCode(result.mermaid)
                setGenerating(false)
                toast(result.via === 'ai'
                  ? 'Playbook generated — review the diagram, then save'
                  : 'Generated from planned angles (AI draft failed validation) — review, then save')
                if (genWithSamples) setPreviewing(true) // same render as setCode — the modal reads the new diagram
              } catch (err) { toast(messageOf(err), 'error') } finally { setGenBusy(false) }
            }}>
              {genBusy ? 'Designing…' : 'Generate'}
            </button>
          </div>
        </Modal>
      )}

      {previewing && (
        <SampleEmailsModal
          campaignId={id}
          mermaid={code}
          leads={legacy.leads}
          pendingCopy={pendingCopy}
          onApply={({ instructions, approvedCopy }) => {
            setCode((prev) => applyInstructions(prev, instructions))
            setPendingCopy(approvedCopy)
            setPreviewing(false)
            toast('Applied to the editor — save the playbook to keep it')
          }}
          onClose={() => setPreviewing(false)}
        />
      )}

      {testSendNode !== null && (
        <TestSendDialog
          campaignId={id}
          steps={steps}
          mailboxes={poolMailboxes}
          leads={(legacy.leads || []).filter((l) => l.lead_id).map((l) => ({
            leadId: l.lead_id, email: l.email, firstName: l.first_name, lastName: l.last_name,
          }))}
          defaultNodeId={testSendNode}
          userEmail={user?.email || ''}
          onClose={() => setTestSendNode(null)}
        />
      )}
    </div>
  )
}

function ValidationPanel({ validation }) {
  if (!validation) return null
  const { valid, errors = [], warnings = [] } = validation
  return (
    <div className={`card p-4 ${valid ? '' : 'border-red-200'}`}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        {valid
          ? <span className="text-accent-600">Playbook is valid</span>
          : <span className="text-red-600">{errors.length} error{errors.length === 1 ? '' : 's'} — fix before launch</span>}
      </div>
      {errors.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-red-700">
          {errors.map((e, i) => <li key={i}>• {e.line ? <span className="font-mono text-xs text-red-600">L{e.line} </span> : null}{e.message}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-amber-700">
          {warnings.map((w, i) => <li key={i}>Warning: {w.message}</li>)}
        </ul>
      )}
    </div>
  )
}

// The diagram says what happens; this says what it actually writes — and this
// is where you change it. One sample per Send step, composed by the same agent
// that does the live sending, then editable three ways:
//
//   the instruction  — what this email should do. It belongs to the diagram, so
//                      it is written back into the node it came from.
//   a note           — "shorter, drop the case study". Rewrites this one email,
//                      once, and is not kept.
//   the copy itself  — edit it, tick "use this copy", and every lead's version
//                      is written to match it instead of starting from the
//                      instruction alone.
//
// Nothing here saves on its own: edits land in the playbook editor behind the
// modal and go in with the same Save as the diagram they belong to.
function SampleEmailsModal({ campaignId, mermaid: source, leads, pendingCopy, onApply, onClose }) {
  const [leadId, setLeadId] = useState('')
  const [meta, setMeta] = useState(null)
  const [order, setOrder] = useState([])   // nodeIds, in the order the graph reads
  const [steps, setSteps] = useState({})   // nodeId -> the card's whole state
  const [truncation, setTruncation] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(true)
  const abort = useRef(null)

  const patch = (nodeId, fields) =>
    setSteps((prev) => (prev[nodeId] ? { ...prev, [nodeId]: { ...prev[nodeId], ...fields } } : prev))

  const run = useCallback(async (asLeadId) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setErr(null)
    setMeta(null)
    setOrder([])
    setSteps({})
    setTruncation(null)
    try {
      await api.stream(
        `/api/campaigns/${campaignId}/preview-messages`,
        // The unsaved diagram and the unsaved copy both travel with the request:
        // previewing edits you have not committed yet is the point of this screen.
        { mermaid: source, leadId: asLeadId ? Number(asLeadId) : null, approvedCopy: pendingCopy || [] },
        (line) => {
          if (line.type === 'meta') setMeta(line)
          else if (line.type === 'plan') {
            setOrder(line.steps.map((s) => s.nodeId))
            setTruncation({ shown: line.steps.length, total: line.totalSendSteps, truncated: line.truncated })
            setSteps(Object.fromEntries(line.steps.map((s) => [s.nodeId, {
              ...s,
              baseInstruction: s.instruction,
              subject: '', body: '', via: '',
              writing: !s.saved,
              approved: Boolean(s.saved), wasApproved: Boolean(s.saved),
              note: '', edited: false, stale: false,
            }])))
          } else if (line.type === 'sample') {
            patch(line.sample.nodeId, { ...line.sample, writing: false, edited: false, stale: false })
          } else if (line.type === 'error') setErr(new Error(line.error))
        },
        { signal: controller.signal }
      )
    } catch (e) {
      setErr(e)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [campaignId, source, pendingCopy])

  // One preview is one model call per send step, so it runs once on open —
  // without the guard, StrictMode's double-invoke writes (and bills) every
  // sample twice. Closing mid-stream stops the read; the server finishes its
  // in-flight call either way.
  //
  // Those two rules fight in development: StrictMode's simulated unmount would
  // abort the stream, and the guard would then stop it ever restarting.
  // Deferring the abort by a tick tells the two apart — a remount clears it, a
  // real close lets it fire.
  const started = useRef(false)
  const closing = useRef(null)
  useEffect(() => {
    clearTimeout(closing.current)
    if (!started.current) {
      started.current = true
      run(leadId)
    }
    return () => { closing.current = setTimeout(() => abort.current?.abort(), 0) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const list = order.map((id) => steps[id]).filter(Boolean)
  const attached = leads.filter((l) => l.lead_id)
  const doneCount = list.filter((s) => !s.writing).length
  const pending = list.some((s) =>
    s.instruction !== s.baseInstruction || s.approved !== s.wasApproved || (s.approved && s.edited))

  // Rewrite one step. With a note, the note revises the copy on screen; without
  // one, the step is written again from its instruction — so "I want this
  // changed" and "give me a different one" are the same button, told apart by
  // whether you said what you wanted.
  const rewriteStep = async (nodeId) => {
    const step = steps[nodeId]
    if (!step) return
    const noteText = step.note.trim()
    patch(nodeId, { writing: true })
    try {
      const prior = {}
      for (const nid of step.dependsOn || []) {
        if (steps[nid]?.body) prior[nid] = { subject: steps[nid].subject, body: steps[nid].body }
      }
      const { sample } = await api.post(`/api/campaigns/${campaignId}/preview-messages/${nodeId}`, {
        mermaid: source,
        leadId: leadId ? Number(leadId) : null,
        instruction: step.instruction,
        refine: noteText,
        basedOn: noteText ? { subject: step.subject, body: step.body } : null,
        priorSamples: prior,
      })
      setSteps((prev) => {
        const next = { ...prev }
        // Everything downstream quoted the old version of this email. Say so
        // rather than leaving a thread that silently disagrees with itself.
        for (const [nid, st] of Object.entries(next)) {
          if (nid !== nodeId && st.body && st.dependsOn?.includes(nodeId)) next[nid] = { ...st, stale: true }
        }
        next[nodeId] = { ...next[nodeId], ...sample, writing: false, edited: false, stale: false, note: '' }
        return next
      })
    } catch (e) {
      patch(nodeId, { writing: false })
      setErr(e)
    }
  }

  const apply = () => {
    onApply({
      instructions: list
        .filter((s) => s.instruction.trim() && s.instruction !== s.baseInstruction)
        .map((s) => ({ nodeId: s.nodeId, instruction: s.instruction })),
      // An empty body clears whatever was saved for that step — unticking the
      // box has to be able to undo ticking it.
      approvedCopy: list
        .filter((s) => s.approved || s.wasApproved)
        .map((s) => ({ nodeId: s.nodeId, subject: s.subject, body: s.approved ? s.body : '' })),
    })
  }

  return (
    <Modal title="What the AI will send" onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-lg text-sm text-slate-600">
          One sample per <span className="font-mono text-accent-700">Send</span> step, written by the same agent that does the live sending.
          Change what a step should do, ask for a rewrite, or edit the email and keep it as the copy every lead's version is written to match.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <select className="input w-auto" value={leadId} disabled={busy}
            onChange={(e) => { setLeadId(e.target.value); run(e.target.value) }} aria-label="Preview as lead">
            <option value="">Example lead</option>
            {attached.map((l) => (
              <option key={l.lead_id} value={l.lead_id}>
                {[l.first_name, l.last_name].filter(Boolean).join(' ') || l.email}
              </option>
            ))}
          </select>
          <button className="btn-ghost cursor-pointer py-1.5" disabled={busy} title="Write every step again from scratch — unapproved edits on this screen are lost"
            onClick={() => run(leadId)}>{busy ? 'Writing…' : 'Rewrite all'}</button>
        </div>
      </div>

      {err && <ErrorState error={err} onRetry={() => run(leadId)} />}
      {busy && !order.length && !err && <Spinner label="Reading the diagram…" />}

      {meta && (
        <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-500">
          <span>
            Written to <span className="text-slate-700">{meta.lead.name || meta.lead.email}</span>
            {meta.lead.title || meta.lead.company ? ` — ${[meta.lead.title, meta.lead.company].filter(Boolean).join(', ')}` : ''}
            {meta.isExample && <span className="text-slate-500"> (stand-in — attach leads to preview against a real one)</span>}
          </span>
          {meta.lead.researched && <span className="text-accent-600">Personalised from this lead's research profile</span>}
        </div>
      )}

      {meta && !meta.hasBusinessContext && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          No business context set — the agent is writing blind. <Link className="underline" to="/app/settings/briefing">Tell it who you are and what you sell</Link> and these get much sharper.
        </div>
      )}
      {meta?.ai?.provider === 'none' && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          No AI provider is configured, so these are the plain template fallbacks — the same ones the live campaign would send.
          Copy you approve here needs a provider to be adapted per lead, so it will not be used until one is set.
        </div>
      )}
      {truncation && (truncation.truncated > 0 || busy) && (
        <div className="mb-3 text-xs text-slate-500">
          {busy ? `Written ${doneCount} of ${truncation.shown}…` : null}
          {truncation.truncated > 0 && (
            <span>{busy ? ' · ' : ''}Showing the first {truncation.shown} of {truncation.total} send steps.</span>
          )}
        </div>
      )}

      {list.length > 0 && (
        <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
          {list.map((s, i) => (
            <article key={s.nodeId} className={`rounded-lg border bg-white transition-colors ${s.writing ? 'border-slate-200' : 'border-slate-200'}`}>
              <header className="border-b border-slate-200 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">Step {i + 1}</span>
                  <span className="font-mono text-xs text-accent-700">{s.nodeId}</span>
                  {s.writing
                    ? <span className="text-[11px] text-slate-400">writing…</span>
                    : <Badge value={s.approved ? 'your copy' : s.via === 'ai' ? 'ai' : 'template'} />}
                  {s.carriesAgreementLink && <span className="text-[11px] text-slate-500">+ agreement link (they said yes)</span>}
                  {s.stale && <span className="text-[11px] text-amber-700">answers an earlier version of the email above — rewrite to refresh</span>}
                </div>
                <div className="mt-1 text-xs text-slate-500">{s.trigger}</div>
              </header>

              <div className="space-y-3 px-4 py-3">
                <label className="block">
                  <span className="text-xs text-slate-500">What this email should do</span>
                  <textarea
                    className="input mt-1 min-h-14 text-[13px]"
                    value={s.instruction}
                    disabled={s.writing}
                    onChange={(e) => patch(s.nodeId, { instruction: e.target.value })}
                    aria-label={`Instruction for step ${s.nodeId}`}
                  />
                </label>

                {s.writing ? (
                  // Placeholder lines, sized like an email, so the list does not
                  // jump as each one lands.
                  <div className="animate-pulse space-y-2" aria-hidden>
                    <div className="h-3.5 w-2/5 rounded bg-slate-100" />
                    <div className="h-3 w-full rounded bg-slate-100/70" />
                    <div className="h-3 w-11/12 rounded bg-slate-100/70" />
                    <div className="h-3 w-4/5 rounded bg-slate-100/70" />
                    <div className="h-3 w-1/3 rounded bg-slate-100/70" />
                  </div>
                ) : (
                  <>
                    <input
                      className="input text-sm font-medium"
                      value={s.subject}
                      onChange={(e) => patch(s.nodeId, { subject: e.target.value, edited: true, approved: true })}
                      aria-label={`Subject for step ${s.nodeId}`}
                    />
                    <textarea
                      className="input min-h-40 text-sm leading-relaxed"
                      value={s.body}
                      onChange={(e) => patch(s.nodeId, { body: e.target.value, edited: true, approved: true })}
                      aria-label={`Email body for step ${s.nodeId}`}
                    />
                    <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600">
                      <input type="checkbox" className="mt-0.5 accent-accent-500" checked={s.approved}
                        onChange={(e) => patch(s.nodeId, { approved: e.target.checked })} />
                      <span>
                        Use this copy for this step — every lead gets their own version of it, personalised, rather than a fresh email from the instruction.
                      </span>
                    </label>
                  </>
                )}

                <div className="flex items-center gap-2">
                  <input
                    className="input text-[13px]"
                    placeholder="What should be different? e.g. shorter, lead with the reporting-time number, no case study"
                    value={s.note}
                    disabled={s.writing}
                    onChange={(e) => patch(s.nodeId, { note: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rewriteStep(s.nodeId) } }}
                    aria-label={`Rewrite note for step ${s.nodeId}`}
                  />
                  <button className="btn-ghost shrink-0 cursor-pointer whitespace-nowrap py-1.5" disabled={s.writing} onClick={() => rewriteStep(s.nodeId)}
                    title={s.note.trim() ? 'Rewrite this email with your note applied' : 'Write this email again from its instruction'}>
                    {s.note.trim() ? 'Apply note' : 'Rewrite'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {pending ? 'Changes go into the playbook editor — save the playbook to keep them.' : ''}
        </span>
        <div className="flex gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose}>{pending ? 'Discard' : 'Close'}</button>
          <button className="btn-primary cursor-pointer" disabled={!pending} onClick={apply}>Apply changes</button>
        </div>
      </div>
    </Modal>
  )
}
