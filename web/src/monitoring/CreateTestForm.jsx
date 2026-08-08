// Create a placement test — manual or automated, one form.
//
// Both create routes publish their request body as an empty object upstream
// (server/parity/deliverability.js, UPSTREAM.createManual / createAutomated),
// so every field below is Harry's best reading of a documented *response*.
// The form says so plainly rather than presenting a confident schema.

import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal, useToast } from '../parity-ui.jsx'
import { FieldNote, Unverified, fieldError, formError } from './delivery-kit.jsx'

const MIN_TIME_UNITS = ['seconds', 'minutes', 'hours']

const EMPTY = {
  name: '',
  description: '',
  folderId: '',
  campaignId: '',
  sequenceStepId: '',
  providerId: '',
  mailboxIds: [],
  spamFilters: '',
  linkChecker: false,
  isWarmup: false,
  testWithSlAccount: false,
  allEmailSentWithoutTimeGap: false,
  minTimeBtwnEmails: 0,
  minTimeUnit: 'minutes',
  scheduleStartTime: '',
  testEndDate: '',
  everyDays: 7,
}

function toIso(local) {
  if (!local) return ''
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export default function CreateTestForm({ folders, providers, onClose, onCreated, announce }) {
  const toast = useToast()
  const [mode, setMode] = useState('manual')
  const [form, setForm] = useState(EMPTY)
  const [mailboxes, setMailboxes] = useState(null)
  const [campaigns, setCampaigns] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [localErr, setLocalErr] = useState({})

  useEffect(() => {
    api.get('/api/mailboxes').then((r) => setMailboxes(r.mailboxes || []), () => setMailboxes([]))
    api.get('/api/campaigns').then((r) => setCampaigns(Array.isArray(r) ? r : []), () => setCampaigns([]))
  }, [])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const noMailboxes = mailboxes !== null && mailboxes.length === 0
  const automated = mode === 'automated'

  function validate() {
    const next = {}
    if (automated && !form.name.trim()) next.name = 'Give the schedule a name so it can be told apart in the list.'
    if (automated && !form.scheduleStartTime) next.scheduleStartTime = 'A schedule needs a start time.'
    if (automated && form.testEndDate && form.scheduleStartTime && new Date(form.testEndDate) <= new Date(form.scheduleStartTime)) {
      next.testEndDate = 'The end must be after the start — a schedule that ends before it starts never runs.'
    }
    if (!automated && form.mailboxIds.length === 0) {
      next.mailboxIds = 'Choose at least one mailbox to send the seed emails from.'
    }
    if (form.sequenceStepId && !form.campaignId) {
      next.campaignId = 'Pick the campaign the Send: step belongs to.'
    }
    setLocalErr(next)
    return Object.keys(next).length === 0
  }

  async function submit(e) {
    e.preventDefault()
    setErr(null)
    if (!validate()) return
    setBusy(true)
    const body = {
      name: form.name.trim() || undefined,
      description: form.description.trim() || undefined,
      folderId: form.folderId || undefined,
      campaignId: form.campaignId || undefined,
      sequenceStepId: form.sequenceStepId.trim() || undefined,
      providerId: form.providerId || undefined,
      mailboxIds: form.mailboxIds,
      spamFilters: form.spamFilters.split(',').map((s) => s.trim()).filter(Boolean),
      linkChecker: form.linkChecker,
      isWarmup: form.isWarmup,
      testWithSlAccount: form.testWithSlAccount,
      allEmailSentWithoutTimeGap: form.allEmailSentWithoutTimeGap,
      minTimeBtwnEmails: Number(form.minTimeBtwnEmails) || 0,
      minTimeUnit: form.minTimeUnit,
    }
    if (automated) {
      body.scheduleStartTime = toIso(form.scheduleStartTime)
      body.testEndDate = toIso(form.testEndDate) || undefined
      body.everyDays = Number(form.everyDays) || 1
    }
    try {
      const res = await api.post(automated ? '/api/deliverability/tests/schedule' : '/api/deliverability/tests/manual', body)
      const message = res.message || (automated ? 'Schedule created.' : 'Test created.')
      announce?.(message)
      toast?.(message)
      onCreated(res)
    } catch (error) {
      setErr(error)
    } finally {
      setBusy(false)
    }
  }

  const groups = (providers?.regions || []).flatMap((r) => r.groups.map((g) => ({ ...g, regionName: r.regionName })))
  const errOf = (field) => localErr[field] || fieldError(err, field)

  return (
    <Modal title="Run a placement test" onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        {/* mode */}
        <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist" aria-label="Test kind">
          {[{ id: 'manual', label: 'Run once (manual)' }, { id: 'automated', label: 'On a schedule (automated)' }].map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => { setMode(m.id); setLocalErr({}); setErr(null) }}
              className={`cursor-pointer border-b-2 px-3 py-2 text-sm ${mode === m.id ? 'border-accent-500 font-medium text-accent-700' : 'border-transparent text-slate-600 hover:text-ink-900'}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* the honest bit: this request shape is not published */}
        <Unverified contract={automated ? 'createAutomated' : 'createManual'} className="mb-4" />

        {formError(err) && (
          <p className="mb-3 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700" role="alert">{formError(err)}</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-600">Test name{automated ? '' : ' (optional)'}</span>
            <input className="input mt-1" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={200}
              aria-invalid={Boolean(errOf('name'))} />
            <FieldNote error={errOf('name')} />
          </label>

          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-600">What this test is for (optional)</span>
            <input className="input mt-1" value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />
            <FieldNote error={errOf('description')} />
          </label>

          <label className="block text-sm">
            <span className="text-slate-600">Folder</span>
            <select className="input mt-1" value={form.folderId} onChange={(e) => set({ folderId: e.target.value })}>
              <option value="">Not filed</option>
              {(folders || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <FieldNote error={errOf('folderId')} />
          </label>

          <label className="block text-sm">
            <span className="text-slate-600">Campaign (optional)</span>
            <select className="input mt-1" value={form.campaignId} onChange={(e) => set({ campaignId: e.target.value })} aria-invalid={Boolean(errOf('campaignId'))}>
              <option value="">Not tied to a campaign</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <FieldNote error={errOf('campaignId')} />
          </label>

          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-600">Send: step in that campaign&apos;s playbook (optional)</span>
            <input
              className="input mt-1" value={form.sequenceStepId} disabled={!form.campaignId}
              onChange={(e) => set({ sequenceStepId: e.target.value })}
              placeholder={form.campaignId ? 'The node id of the Send: step' : 'Pick a campaign first'}
              aria-invalid={Boolean(errOf('sequenceStepId'))}
            />
            <FieldNote error={errOf('sequenceStepId')} />
          </label>

          {/* Seed provider group — ids never reach the screen. */}
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-600">Seed inboxes</span>
            <select
              className="input mt-1" value={form.providerId}
              onChange={(e) => set({ providerId: e.target.value })}
              disabled={groups.length === 0}
              aria-invalid={Boolean(errOf('providerId'))}
            >
              <option value="">No seed provider group</option>
              {(providers?.regions || []).map((r) => (
                <optgroup key={r.regionId || r.regionName} label={r.regionName || 'Region not named'}>
                  {r.groups.map((g) => (
                    <option key={g.groupId} value={g.groupId}>
                      {g.groupName} — {g.providerCount} inbox{g.providerCount === 1 ? '' : 'es'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {groups.length === 0 && (
              <p className="mt-1 text-xs text-slate-500">{providers?.message || 'No seed provider groups are listed. The test can still be created and stored without one.'}</p>
            )}
            <FieldNote error={errOf('providerId')} />
          </label>
        </div>

        {/* mailboxes */}
        <fieldset className="mt-4">
          <legend className="text-sm text-slate-600">
            Send seed emails from{automated ? ' (optional)' : ''}
          </legend>
          {mailboxes === null && <p className="mt-1 text-xs text-slate-500">Loading mailboxes…</p>}
          {noMailboxes && (
            <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              No mailbox is connected to this workspace, so there is nothing to send seed emails from. Connect one on the Mailboxes page first — a manual test cannot be created without one.
            </p>
          )}
          {mailboxes && mailboxes.length > 0 && (
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded border border-slate-200 p-2">
              {mailboxes.map((m) => {
                const on = form.mailboxIds.includes(m.id)
                return (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox" checked={on}
                      onChange={() => set({ mailboxIds: on ? form.mailboxIds.filter((x) => x !== m.id) : [...form.mailboxIds, m.id] })}
                    />
                    <span className="break-all">{m.email}</span>
                    <span className="text-[11px] text-slate-500">{m.provider} · {m.status}</span>
                  </label>
                )
              })}
            </div>
          )}
          <FieldNote error={errOf('mailboxIds')} />
        </fieldset>

        {/* schedule — automated only */}
        {automated && (
          <fieldset className="mt-4 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm text-slate-600">Schedule</legend>
            <p className="mb-2 text-[11px] text-slate-500">Times are read and shown in this browser&apos;s timezone.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm">
                <span className="text-slate-600">Starts</span>
                <input type="datetime-local" className="input mt-1" value={form.scheduleStartTime}
                  onChange={(e) => set({ scheduleStartTime: e.target.value })} aria-invalid={Boolean(errOf('scheduleStartTime'))} />
                <FieldNote error={errOf('scheduleStartTime')} />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Ends (optional)</span>
                <input type="datetime-local" className="input mt-1" value={form.testEndDate}
                  onChange={(e) => set({ testEndDate: e.target.value })} aria-invalid={Boolean(errOf('testEndDate'))} />
                <FieldNote error={errOf('testEndDate')} />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Runs every … days</span>
                <input type="number" min={1} max={365} className="input mt-1" value={form.everyDays}
                  onChange={(e) => set({ everyDays: e.target.value })} aria-invalid={Boolean(errOf('everyDays'))} />
                <FieldNote error={errOf('everyDays')} />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              {form.scheduleStartTime
                ? `Runs ${Number(form.everyDays) === 1 ? 'every day' : `every ${form.everyDays} days`} from ${new Date(form.scheduleStartTime).toLocaleString()}${form.testEndDate ? `, until ${new Date(form.testEndDate).toLocaleString()}` : ', with no end date'}.`
                : 'Pick a start time to see the cadence in words.'}
            </p>
          </fieldset>
        )}

        {/* gap, warm-up, filters */}
        <fieldset className="mt-4 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm text-slate-600">Pacing and options</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.allEmailSentWithoutTimeGap}
              onChange={(e) => set({ allEmailSentWithoutTimeGap: e.target.checked })} />
            Send every seed email at once, with no gap between them
          </label>
          {!form.allEmailSentWithoutTimeGap && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-600">Minimum gap between seed emails</span>
                <input type="number" min={0} max={1440} className="input mt-1" value={form.minTimeBtwnEmails}
                  onChange={(e) => set({ minTimeBtwnEmails: e.target.value })} aria-invalid={Boolean(errOf('minTimeBtwnEmails'))} />
                <FieldNote error={errOf('minTimeBtwnEmails')} />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Measured in</span>
                <select className="input mt-1" value={form.minTimeUnit} onChange={(e) => set({ minTimeUnit: e.target.value })}>
                  {MIN_TIME_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <FieldNote error={errOf('minTimeUnit')} />
              </label>
            </div>
          )}

          <div className="mt-3 space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.isWarmup} onChange={(e) => set({ isWarmup: e.target.checked })} />
              Count these sends as mailbox warm-up
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.linkChecker} onChange={(e) => set({ linkChecker: e.target.checked })} />
              Check the links in the message
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.testWithSlAccount} onChange={(e) => set({ testWithSlAccount: e.target.checked })} />
              Also seed the deliverability provider&apos;s own account
            </label>
          </div>

          <label className="mt-3 block text-sm">
            <span className="text-slate-600">Spam filters to check (comma separated, up to 20)</span>
            <input className="input mt-1" value={form.spamFilters} onChange={(e) => set({ spamFilters: e.target.value })}
              placeholder="SpamAssassin, Barracuda" aria-invalid={Boolean(errOf('spamFilters'))} />
            <FieldNote error={errOf('spamFilters')} />
          </label>
        </fieldset>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary cursor-pointer" disabled={busy || (!automated && noMailboxes)}>
            {busy ? 'Creating…' : automated ? 'Create schedule' : 'Run test now'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
