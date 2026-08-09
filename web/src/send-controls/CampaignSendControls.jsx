// Per-campaign send controls — narrows the workspace ceiling, never widens it.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast } from '../ui.jsx'
import {
  SendStatus, HoursGroup, VolumeGroup, SchedulePreview, dayLabel,
} from './shared.jsx'

export default function CampaignSendControls({ campaignId, campaignState, onSaved }) {
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

      <section className="card p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-ink-900">Sending</h2>
          <p className="mt-1 text-sm text-slate-600">
            When this campaign may send. It can only narrow your workspace limits — never looser.
            Currently: {summary}.
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
