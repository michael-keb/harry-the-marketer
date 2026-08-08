import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Spinner, EmptyState, ErrorState, Modal, Badge, Icon, PageHeader, useToast, timeAgo } from '../ui.jsx'

export default function Goals() {
  const toast = useToast()
  const [goals, setGoals] = useState(null)
  const [error, setError] = useState(null)
  const [description, setDescription] = useState('')
  const [autopilot, setAutopilot] = useState(true)
  const [building, setBuilding] = useState(false)
  const [lastSteps, setLastSteps] = useState(null)
  const [qualifying, setQualifying] = useState(null) // goal object

  const load = useCallback(async () => {
    try { setGoals(await api.get('/api/goals')); setError(null) } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!goals) return <Spinner label="Loading goals…" />

  const build = async (e) => {
    e.preventDefault()
    setBuilding(true)
    setLastSteps(null)
    try {
      const result = await api.post('/api/goals', { description, autopilot })
      setLastSteps({ name: result.name, steps: result.steps, plannedVia: result.plannedVia })
      setDescription('')
      toast(autopilot ? 'Goal built and autopilot engaged' : 'Goal and campaign created')
      load()
    } catch (err) { toast(err.message, 'error') } finally { setBuilding(false) }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Revenue goals" lead="State the outcome; the AI builds the go-to-market workflow." />

      {/* The "don't make me think" surface */}
      <form onSubmit={build} className="card p-5 space-y-3 border-accent-600/40">
        <label className="block text-sm text-slate-700 font-medium" htmlFor="goal-input">What outcome do you want?</label>
        <textarea
          id="goal-input"
          className="input min-h-20 text-[15px]"
          placeholder={'Example: Generate 20 qualified meetings with Australian SaaS companies (20-150 staff) that use Jira and might need business analysts.'}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} className="accent-accent-500" />
            Autopilot: qualify leads, attach the fits, launch, and write the first emails
          </label>
          <button className="btn-primary" disabled={building || description.trim().length < 10}>
            {building ? 'Planning with the agent…' : 'Build it for me'}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          The agent extracts the target and ideal customer profile, writes a playbook diagram, creates the campaign,
          and scores every lead against the profile with reasons. You stay in control: everything it builds is editable,
          and nothing reaches a prospect until you approve it in the Inbox.
        </p>
      </form>

      {lastSteps && (
        <div className="card p-4 border-accent-600/40">
          <div className="text-sm font-semibold text-ink-900 mb-2">What the agent just did for "{lastSteps.name}"</div>
          <ol className="space-y-1 text-sm text-slate-700 list-decimal list-inside">
            {lastSteps.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>
      )}

      {goals.length === 0 ? (
        <EmptyState icon="goal" title="No revenue goals yet"
          hint="Type the outcome you want above. The AI plans the ICP, target, and playbook, then runs the campaign toward it." />
      ) : (
        <div className="space-y-3">
          {goals.map((g) => <GoalCard key={g.id} goal={g} onQualify={() => setQualifying(g)} onChanged={load} />)}
        </div>
      )}

      {qualifying && (
        <QualifyModal goal={qualifying} onClose={() => setQualifying(null)} onChanged={() => { setQualifying(null); load() }} />
      )}
    </div>
  )
}

function GoalCard({ goal, onQualify, onChanged }) {
  const toast = useToast()
  const progress = Math.min(100, Math.round((goal.won / goal.target) * 100))
  const icpBits = [
    ...(goal.icp.industries || []), ...(goal.icp.locations || []),
    ...(goal.icp.titles || []).slice(0, 3), ...(goal.icp.keywords || []).slice(0, 5),
  ].slice(0, 10)

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-ink-950">{goal.name}</h2>
            <Badge value={goal.status === 'achieved' ? 'won' : goal.status} />
          </div>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">{goal.description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="btn-ghost py-1.5 text-xs" onClick={onQualify}>Qualified leads</button>
          {goal.campaignId && (
            <>
              <Link to={`/app/campaigns/${goal.campaignId}?preview=1`} className="btn-ghost py-1.5 text-xs"
                title="Read the emails the AI wrote for this goal's playbook, step by step">
                See the emails
              </Link>
              <Link to={`/app/campaigns/${goal.campaignId}`} className="btn-ghost py-1.5 text-xs">
                Campaign{goal.campaignStatus ? ` (${goal.campaignStatus})` : ''}
              </Link>
            </>
          )}
          <button className="btn-danger py-1.5 text-xs" onClick={async () => {
            if (!confirm('Archive this goal? The campaign stays as-is.')) return
            try { await api.del(`/api/goals/${goal.id}`); toast('Goal archived'); onChanged() } catch (err) { toast(err.message, 'error') }
          }}>Archive</button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${goal.status === 'achieved' ? 'bg-accent-400' : 'bg-accent-500'}`} style={{ width: `${Math.max(progress, 2)}%` }} />
        </div>
        <div className="text-sm tabular-nums text-ink-900 shrink-0">
          {goal.won}/{goal.target} {goal.metric === 'won' ? 'won' : goal.metric}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        {[['Scored', goal.scored], ['Qualified (60+)', goal.qualified], ['In campaign', goal.attached], ['Contacted', goal.contacted]].map(([label, n]) => (
          <div key={label} className="rounded-lg bg-slate-100 py-2">
            <div className="text-base font-semibold text-ink-950 tabular-nums">{n}</div>
            <div className="text-[11px] text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      {icpBits.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] text-slate-500">ICP:</span>
          {icpBits.map((b, i) => (
            <span key={i} className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">{b}</span>
          ))}
        </div>
      )}
      <div className="mt-2 text-[11px] text-slate-400">Created {timeAgo(goal.createdAt)}</div>
    </div>
  )
}

function QualifyModal({ goal, onClose, onChanged }) {
  const toast = useToast()
  const [scores, setScores] = useState(null)
  const [err, setErr] = useState(null)
  const [minFit, setMinFit] = useState(60)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (rescore = false) => {
    setBusy(true)
    try { setScores(await api.post(`/api/goals/${goal.id}/qualify`, { rescore })); setErr(null) } catch (e) { setErr(e) } finally { setBusy(false) }
  }, [goal.id])
  useEffect(() => { run(false) }, [run])

  const attach = async () => {
    try {
      const result = await api.post(`/api/goals/${goal.id}/attach`, { minFit })
      toast(`Attached ${result.added} of ${result.total} qualified leads to the campaign`)
      onChanged()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <Modal title={`AI qualification — ${goal.name}`} onClose={onClose} wide>
      {err ? <ErrorState error={err} onRetry={() => run(false)} /> : !scores ? <Spinner label="Scoring leads against the ICP…" /> : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="text-xs text-slate-600">
              Every active lead scored against the ideal customer profile, with reasons. Unknown data lowers confidence; it never fabricates.
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost py-1 text-xs" disabled={busy} onClick={() => run(true)}>{busy ? 'Scoring…' : 'Re-score all'}</button>
            </div>
          </div>
          {scores.length === 0 ? (
            <EmptyState icon="leads" title="No leads to score" hint="Add leads first, then qualify them here." />
          ) : (
            <div className="max-h-96 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-200">
              {scores.map((s) => (
                <div key={s.lead_id} className="px-3 py-2.5 flex items-start gap-3">
                  <div className={`shrink-0 w-12 text-center rounded-lg py-1 text-sm font-semibold tabular-nums ${
                    s.fit >= 60 ? 'bg-accent-500/15 text-accent-700' : 'bg-slate-100 text-slate-500'
                  }`}>{s.fit}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink-900">
                      {[s.first_name, s.last_name].filter(Boolean).join(' ') || s.email}
                      <span className="text-slate-500"> · {s.company || 'company unknown'}{s.title ? ` · ${s.title}` : ''}</span>
                      {s.attached ? <span className="ml-2 text-[11px] text-accent-700">in campaign</span> : null}
                    </div>
                    <ul className="text-xs text-slate-500 mt-0.5">
                      {s.reasons.map((r, i) => <li key={i}>- {r}</li>)}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 mt-4">
            <label className="text-xs text-slate-600 flex items-center gap-2">
              Attach leads with fit at least
              <input type="number" min="0" max="100" value={minFit} onChange={(e) => setMinFit(Number(e.target.value))} className="input w-18 py-1 text-xs" />
            </label>
            <button className="btn-primary" onClick={attach}>Attach to campaign</button>
          </div>
        </>
      )}
    </Modal>
  )
}
