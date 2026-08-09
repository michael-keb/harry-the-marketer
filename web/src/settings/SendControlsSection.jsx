// Send controls — workspace outer limits. Per-campaign narrowing lives on each
// campaign's Settings tab (see send-controls/CampaignSendControls.jsx).
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast } from '../ui.jsx'
import {
  SendStatus, HoursGroup, PeopleGroup, VolumeGroup, BrakesGroup, SchedulePreview,
} from '../send-controls/shared.jsx'

export default function SendControlsSection() {
  const toast = useToast()
  const [rules, setRules] = useState(null)
  const [effective, setEffective] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [view, live] = await Promise.all([
        api.get('/api/send-rules?scope=workspace'),
        api.get('/api/send-status'),
      ])
      setRules({ ...view.effective, ...view.stored })
      setEffective(view.effective)
      setStatus(live)
      setError(null)
    } catch (err) { setError(err) }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (patch, message) => {
    setBusy(true)
    try {
      const res = await api.put('/api/send-rules', { scope: 'workspace', rules: patch })
      setEffective(res.effective)
      setRules((r) => ({ ...r, ...patch }))
      if (res.warning) toast(res.warning, 'error')
      else if (message) toast(message)
      await load()
      return true
    } catch (err) {
      toast(err.message, 'error')
      return false
    } finally { setBusy(false) }
  }

  if (error) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold text-ink-900">Send controls</h2>
        <p className="mt-2 text-sm text-red-700">{error.message}</p>
      </section>
    )
  }
  if (!rules) return <section className="card p-5 text-sm text-slate-600">Loading the send controls…</section>

  const set = (patch) => setRules((r) => ({ ...r, ...patch }))

  return (
    <>
      <SendStatus status={status} onChanged={load} />

      <section className="card p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-ink-900">Send controls</h2>
          <p className="mt-1 text-sm text-slate-600">
            The outer limits for this workspace. Each campaign narrows these in its own Sending settings —
            never looser — so whatever you set here is the ceiling everywhere.
          </p>
        </div>

        <HoursGroup rules={rules} effective={effective} set={set} save={save} cancel={load} busy={busy} />
        <PeopleGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
        <VolumeGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
        <BrakesGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
      </section>

      <SchedulePreview />
    </>
  )
}
