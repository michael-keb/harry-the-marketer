// Send controls — workspace outer limits. Per-campaign narrowing lives on each
// campaign's Settings tab (see send-controls/CampaignSendControls.jsx).
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useToast, Modal } from '../ui.jsx'
import {
  SendStatus, HoursGroup, PeopleGroup, VolumeGroup, BrakesGroup,
  AutomationDefaultsGroup, SchedulePreview,
} from '../send-controls/shared.jsx'

export default function SendControlsSection() {
  const toast = useToast()
  const [rules, setRules] = useState(null)
  const [effective, setEffective] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // When the workspace gates automation-default edits behind approval, the
  // server answers 409 approval_required. We hold the pending change here and
  // only re-submit with confirmed: true once the operator confirms in the modal.
  const [confirm, setConfirm] = useState(null)

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

  // The actual write. `confirmed` is sent only after the operator has agreed to
  // it in the modal — never blanket-hardcoded, or the approval gate protects
  // nothing.
  const put = async (patch, message, confirmed) => {
    const res = await api.put('/api/send-rules', {
      scope: 'workspace',
      rules: patch,
      ...(confirmed ? { confirmed: true } : {}),
    })
    setEffective(res.effective)
    setRules((r) => ({ ...r, ...patch }))
    if (res.warning) toast(res.warning, 'error')
    else if (message) toast(message)
    await load()
  }

  const save = async (patch, message) => {
    setBusy(true)
    try {
      await put(patch, message, false)
      setBusy(false)
      return true
    } catch (err) {
      // Workspace requires sign-off before changing shared automation defaults:
      // surface a confirmation the operator has to accept, then retry.
      if (err?.status === 409 && err?.payload?.error === 'approval_required') {
        setBusy(false)
        return await new Promise((resolve) => setConfirm({ patch, message, note: err.message, resolve }))
      }
      toast(err.message, 'error')
      setBusy(false)
      return false
    }
  }

  const confirmSave = async () => {
    const pending = confirm
    setConfirm(null)
    setBusy(true)
    try {
      await put(pending.patch, pending.message, true)
      pending.resolve(true)
    } catch (err) {
      toast(err.message, 'error')
      pending.resolve(false)
    } finally { setBusy(false) }
  }

  const cancelConfirm = () => {
    confirm?.resolve(false)
    setConfirm(null)
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
        <AutomationDefaultsGroup rules={rules} set={set} save={save} cancel={load} busy={busy} />
      </section>

      <SchedulePreview />

      {confirm && (
        <Modal
          title="Confirm change to shared defaults"
          lead={confirm.note}
          onClose={cancelConfirm}
        >
          <p className="text-sm text-slate-600">
            This edit changes the automation defaults every new campaign inherits. Your workspace requires
            confirmation before it takes effect.
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button type="button" className="btn-ghost" disabled={busy} onClick={cancelConfirm}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={confirmSave}>
              {busy ? 'Saving…' : 'Confirm and save'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
