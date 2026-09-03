// Per-campaign send controls — the one place sending is decided. Whether each
// email waits for a human, when the campaign may send, and how much. Quiet
// hours and the bounce brakes sit underneath and are not a setting here.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast } from '../ui.jsx'
import {
  SendStatus, HoursGroup, VolumeGroup, SchedulePreview, Toggle, dayLabel,
} from './shared.jsx'

// `campaign` is the engine view of the campaign (GET /api/campaigns/:id), which
// carries requireApproval (in force) and requireApprovalOverride (this
// campaign's own answer, or null when it follows the workspace default).
function ApprovalCard({ campaignId, campaign, onSaved }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!campaign || campaign.requireApproval === undefined) return null
  const on = Boolean(campaign.requireApproval)
  const inherited = campaign.requireApprovalOverride === null || campaign.requireApprovalOverride === undefined

  const toggle = async () => {
    if (on && !confirm('Let the agent send this campaign\'s emails without showing them to you first?')) return
    setBusy(true)
    try {
      await api.put(`/api/campaigns/${campaignId}`, { requireApproval: !on })
      toast(on ? 'This campaign now sends without asking you' : 'Nothing from this campaign sends without your OK')
      await onSaved?.()
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }

  return (
    <section className={`card p-5 space-y-2 ${busy ? 'opacity-70' : ''}`}>
      <Toggle
        on={on}
        onChange={toggle}
        label="Show me every email before it sends"
        hint={on
          ? 'The agent researches, writes and times each email, then waits in your Inbox under "Needs your OK". Your name is on it, so you send it.'
          : 'The agent sends on its own. Faster, but you find out what went out afterwards — and unattended sending is what makes outreach feel like spam.'}
      />
      {inherited && (
        <p className="text-xs text-slate-400">
          Following the workspace default. Flip the switch and this campaign decides for itself.
        </p>
      )}
    </section>
  )
}

export default function CampaignSendControls({ campaignId, campaignState, campaign, onSaved }) {
  const toast = useToast()
  const [rules, setRules] = useState(null)
  const [effective, setEffective] = useState(null)
  const [inherited, setInherited] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [view, live] = await Promise.all([
        api.get(`/api/send-rules?scope=campaign&id=${campaignId}`),
        api.get(`/api/send-status?campaignId=${campaignId}`),
      ])
      setRules({ ...view.effective, ...view.stored })
      setEffective(view.effective)
      setInherited(view.inherited)
      setStatus(live)
      setError(null)
    } catch (err) { setError(err) }
  }, [campaignId])

  useEffect(() => { load() }, [load])

  const save = async (patch, message) => {
    setBusy(true)
    try {
      const res = await api.put('/api/send-rules', { scope: 'campaign', id: campaignId, rules: patch })
      setEffective(res.effective)
      setRules((r) => ({ ...r, ...patch }))
      if (res.warning) toast(res.warning, 'error')
      else if (message) toast(message)
      await load()
      await onSaved?.()
      return true
    } catch (err) {
      toast(err.message, 'error')
      return false
    } finally { setBusy(false) }
  }

  if (error) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold text-ink-900">Sending</h2>
        <p className="mt-2 text-sm text-red-700">{error.message}</p>
      </section>
    )
  }
  if (!rules) return <section className="card p-5 text-sm text-slate-600">Loading send controls…</section>

  const set = (patch) => setRules((r) => ({ ...r, ...patch }))
  const summary = effective?.windows?.length
    ? effective.windows.map((w) => `${dayLabel(w.days)} ${w.from}–${w.to}`).join(', ')
    : 'No sending window — nothing can go out'

  return (
    <>
      <SendStatus
        status={status}
        scope="campaign"
        scopeId={campaignId}
        onChanged={load}
      />

      <ApprovalCard campaignId={campaignId} campaign={campaign} onSaved={onSaved} />

      <section className="card p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-ink-900">Sending</h2>
          <p className="mt-1 text-sm text-slate-600">
            When this campaign may send, and how much. Quiet hours
            {effective?.quietHours ? ` (before ${effective.quietHours.from} or after ${effective.quietHours.to} where they are)` : ''}
            {' '}always hold. Currently: {summary}.
          </p>
          {campaignState === 'START' && (
            <p className="mt-2 text-xs text-amber-700">
              This campaign is running — changes apply from the next send onwards.
            </p>
          )}
        </div>

        <HoursGroup
          rules={rules}
          effective={effective}
          inherited={inherited}
          set={set}
          save={save}
          cancel={load}
          busy={busy}
          variant="campaign"
        />
        <VolumeGroup
          rules={rules}
          set={set}
          save={save}
          cancel={load}
          busy={busy}
          variant="campaign"
        />
      </section>

      <SchedulePreview campaignId={campaignId} limit={8} />
    </>
  )
}
