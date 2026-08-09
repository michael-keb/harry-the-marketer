// SMS channel accounts (Twilio). Rendered on Connections → Messages.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Spinner, ErrorState } from '../parity-ui.jsx'
import { useToast } from '../ui.jsx'
import { StatusPill } from './common.jsx'

const emptyForm = {
  provider: 'sandbox',
  display_name: '',
  phone_number: '',
  messaging_service_sid: '',
  account_sid: '',
  auth_token: '',
  daily_limit: 50,
}

export default function ChannelsSection() {
  const toast = useToast()
  const [accounts, setAccounts] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  const [testTo, setTestTo] = useState('')

  const load = useCallback(() => {
    setError(null)
    api.get('/api/channel-accounts?channel=sms')
      .then((r) => setAccounts(r.accounts || []))
      .catch(setError)
  }, [])

  useEffect(() => { load() }, [load])

  async function connect(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/api/channel-accounts', {
        channel: 'sms',
        ...form,
        daily_limit: Number(form.daily_limit) || 50,
      })
      toast?.('SMS account connected')
      setForm(emptyForm)
      load()
    } catch (err) {
      toast?.(err.message || 'Could not connect', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function testSend(id) {
    if (!testTo.trim()) {
      toast?.('Enter a phone number to test', 'error')
      return
    }
    setBusy(true)
    try {
      await api.post(`/api/channel-accounts/${id}/test-send`, {
        to: testTo.trim(),
        confirm: true,
        body: 'Harry SMS test — reply STOP to opt out.',
      })
      toast?.('Test SMS sent')
    } catch (err) {
      toast?.(err.message || 'Test send failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    if (!confirm('Remove this SMS account?')) return
    setBusy(true)
    try {
      await api.del(`/api/channel-accounts/${id}`)
      toast?.('SMS account removed')
      load()
    } catch (err) {
      toast?.(err.message || 'Could not remove', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold text-ink-900">SMS</h2>
        <p className="mt-1 text-sm text-slate-600">
          Twilio (or a local sandbox). Used by campaign <code className="text-xs">Send sms:</code> steps.
          Leads need a phone number and an SMS opt-in before anything sends. With{' '}
          <span className="font-mono text-xs">TWILIO_*</span> in .env, Harry connects automatically.
          Point the number’s inbound webhook at the URL on each account.
        </p>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !accounts ? (
        <Spinner label="Loading SMS accounts…" />
      ) : accounts.length === 0 ? (
        <p className="text-sm text-slate-500">No SMS accounts yet. Add a sandbox account to try locally, or Twilio for real sends.</p>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-900">{a.displayName || a.phoneNumber}</span>
                <StatusPill tone={a.status === 'connected' ? 'good' : 'warn'}>{a.status}</StatusPill>
                <span className="text-xs text-slate-500">{a.provider}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                From {a.phoneNumber || a.messagingServiceSid || '—'} · {a.sentToday} of {a.dailyLimit} today
              </p>
              <p className="mt-1 break-all text-xs text-slate-500">Webhook: {a.webhookUrl}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="input max-w-xs text-sm"
                  placeholder="+61…"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
                <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => testSend(a.id)}>
                  Test send
                </button>
                <button type="button" className="btn-ghost text-sm text-rose-700" disabled={busy} onClick={() => remove(a.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={connect} className="space-y-3 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-ink-900">Add SMS account</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-600">
            Provider
            <select
              className="input mt-1 w-full"
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            >
              <option value="sandbox">Sandbox (local / CI)</option>
              <option value="twilio">Twilio</option>
            </select>
          </label>
          <label className="block text-xs text-slate-600">
            Display name
            <input
              className="input mt-1 w-full"
              value={form.display_name}
              onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
            />
          </label>
          <label className="block text-xs text-slate-600">
            From number (E.164)
            <input
              className="input mt-1 w-full"
              placeholder="+614…"
              value={form.phone_number}
              onChange={(e) => setForm((f) => ({ ...f, phone_number: e.target.value }))}
            />
          </label>
          <label className="block text-xs text-slate-600">
            Daily limit
            <input
              type="number"
              min={1}
              className="input mt-1 w-full"
              value={form.daily_limit}
              onChange={(e) => setForm((f) => ({ ...f, daily_limit: e.target.value }))}
            />
          </label>
          {form.provider === 'twilio' && (
            <>
              <label className="block text-xs text-slate-600 sm:col-span-2">
                Messaging Service SID (optional)
                <input
                  className="input mt-1 w-full"
                  value={form.messaging_service_sid}
                  onChange={(e) => setForm((f) => ({ ...f, messaging_service_sid: e.target.value }))}
                />
              </label>
              <label className="block text-xs text-slate-600">
                Account SID
                <input
                  className="input mt-1 w-full"
                  value={form.account_sid}
                  onChange={(e) => setForm((f) => ({ ...f, account_sid: e.target.value }))}
                />
              </label>
              <label className="block text-xs text-slate-600">
                Auth Token
                <input
                  type="password"
                  className="input mt-1 w-full"
                  value={form.auth_token}
                  onChange={(e) => setForm((f) => ({ ...f, auth_token: e.target.value }))}
                />
              </label>
            </>
          )}
        </div>
        <button type="submit" className="btn-primary text-sm" disabled={busy}>
          Connect SMS account
        </button>
      </form>
    </section>
  )
}
