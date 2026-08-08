// Orders placed with a sending-infrastructure supplier, and the one-time codes
// that let a person sign in to what they bought.
//
// Two rules shape everything here. A pending order is settled by *looking it
// up* — never by posting it again, because a re-posted purchase is a second
// charge — so there is no retry control anywhere in this file. And a sign-in
// code is read once and shown once: it lives in this component's state for as
// long as it is on screen, is cleared the moment it expires or the modal
// closes, and is never written anywhere.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Confirm, Drawer, ErrorState, LiveRegion, Modal, useToast } from '../parity-ui.jsx'
import { clockTime } from '../ui.jsx'
import { Section, Skeleton, money, plural, retryAfter, useAnnounce } from './common.jsx'

const STORE_KEY = 'harry.senderOrderRefs'

function readRefs() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string') : []
  } catch {
    return []
  }
}

// The API has no "list my orders" route — an order is addressed by its
// reference. So a reference is remembered the moment one is placed, and the
// purchased-domain list contributes the rest.
export function rememberOrder(ref) {
  if (!ref) return
  try {
    const next = [...new Set([ref, ...readRefs()])].slice(0, 50)
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch { /* private mode: the domain list still finds placed orders */ }
}

function forgetOrder(ref) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(readRefs().filter((r) => r !== ref)))
  } catch { /* nothing to clean up */ }
}

const STATUS_WORDS = {
  pending: 'Waiting on the supplier',
  placed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export default function Orders({ domains, onConnect }) {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)
  const [openRef, setOpenRef] = useState(null)
  const [manualRef, setManualRef] = useState('')

  const refs = [...new Set([
    ...readRefs(),
    ...(domains || []).map((d) => d.order_ref).filter(Boolean),
  ])]
  const refsKey = refs.join(',')

  const load = useCallback(async () => {
    setError(null)
    const list = refsKey ? refsKey.split(',') : []
    if (!list.length) { setOrders([]); return }
    try {
      const settled = await Promise.all(list.map(async (ref) => {
        try {
          const res = await api.get(`/api/senders/orders/${encodeURIComponent(ref)}`)
          return res.data
        } catch (err) {
          // A reference this workspace does not own is indistinguishable from
          // one that never existed, and neither belongs in the list.
          if (err.status === 404) forgetOrder(ref)
          return null
        }
      }))
      setOrders(settled.filter(Boolean))
    } catch (err) {
      setError(err)
    }
  }, [refsKey])

  useEffect(() => { load() }, [load])

  const lookUp = (e) => {
    e.preventDefault()
    const ref = manualRef.trim()
    if (!ref) return
    rememberOrder(ref)
    setManualRef('')
    setOpenRef(ref)
    load()
  }

  // order-details.md: the list is absent until an order exists — except for the
  // lookup, which is how someone recovers a reference from another browser.
  return (
    <Section
      id="sender-orders"
      title="Orders"
      hint="An order is settled by looking it up. Harry never re-sends one, because re-sending a purchase is how a domain gets bought twice."
      action={(
        <form onSubmit={lookUp} className="flex items-end gap-2">
          <label className="text-xs text-slate-600">
            <span className="sr-only">Look up an order reference</span>
            <input
              className="input w-44 py-1.5 text-xs font-mono"
              placeholder="HTM-ORD-…"
              value={manualRef}
              onChange={(e) => setManualRef(e.target.value)}
              aria-label="Order reference"
            />
          </label>
          <button className="btn-ghost px-2 py-1.5 text-xs cursor-pointer">Look up</button>
        </form>
      )}
    >
      {error && <ErrorState error={error} onRetry={load} />}
      {!orders && !error && <Skeleton rows={2} className="h-10" />}

      {orders && orders.length === 0 && (
        <p className="text-xs text-slate-500">
          No orders yet. One appears here the moment you place it — and if you placed one in another
          browser, its reference finds it.
        </p>
      )}

      {orders && orders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <caption className="sr-only">Sending-infrastructure orders placed by this workspace</caption>
            <thead className="text-slate-500">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Reference</th>
                <th scope="col" className="py-1 pr-3 font-medium">Domains</th>
                <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                <th scope="col" className="py-1 pr-3 font-medium">Total</th>
                <th scope="col" className="py-1 font-medium"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {orders.map((o) => (
                <tr key={o.order_ref} className="border-t border-slate-200">
                  <th scope="row" className="py-2 pr-3 font-mono font-normal text-ink-900">{o.order_ref}</th>
                  <td className="py-2 pr-3">{(o.domains || []).join(', ') || '—'}</td>
                  <td className="py-2 pr-3">
                    <span className="text-ink-900">{STATUS_WORDS[o.status] || o.status}</span>
                  </td>
                  <td className="py-2 pr-3">{money(o.total, o.currency)}</td>
                  <td className="py-2">
                    <button
                      className="btn-ghost px-2 py-1 text-xs cursor-pointer"
                      onClick={() => setOpenRef(o.order_ref)}
                      aria-label={`Open order ${o.order_ref}`}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openRef && (
        <OrderDetail
          orderRef={openRef}
          onClose={() => { setOpenRef(null); load() }}
          onConnect={onConnect}
        />
      )}
    </Section>
  )
}

function OrderDetail({ orderRef, onClose, onConnect }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [checkedAt, setCheckedAt] = useState(null)
  const [revealing, setRevealing] = useState(false)
  const [credentials, setCredentials] = useState(null)
  const [codeFor, setCodeFor] = useState('')
  const [announcement, say] = useAnnounce()

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/senders/orders/${encodeURIComponent(orderRef)}`)
      setData(res)
      setCheckedAt(new Date().toISOString())
    } catch (err) {
      setError(err)
    }
  }, [orderRef])

  useEffect(() => { load() }, [load])

  // A pending order settles itself by being read. Polling stops while the tab
  // is hidden, and the last-checked time says when the answer is from.
  const pending = data?.data?.status === 'pending'
  useEffect(() => {
    if (!pending) return undefined
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const id = setInterval(tick, 20000)
    return () => clearInterval(id)
  }, [pending, load])

  const reveal = async () => {
    try {
      const res = await api.get(`/api/senders/orders/${encodeURIComponent(orderRef)}?reveal=1`)
      setCredentials(res.credentials || [])
      say(res.credential_notice || 'No credential was returned for this order.')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setRevealing(false)
    }
  }

  const order = data?.data
  const mailboxes = order?.mailboxes || []

  return (
    <Drawer title={`Order ${orderRef}`} onClose={onClose}>
      <LiveRegion message={announcement} />
      {error && <ErrorState error={error} onRetry={load} />}
      {!order && !error && <Skeleton rows={3} className="h-14" />}

      {order && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-500">Status</dt>
              <dd className="text-ink-950">{STATUS_WORDS[order.status] || order.status}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Total</dt>
              <dd className="text-ink-950">{money(order.total, order.currency)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Domains</dt>
              <dd className="text-ink-950">{(order.domains || []).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Forwarding domain</dt>
              <dd className="text-ink-950">{order.forwarding_domain || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Placed</dt>
              <dd className="text-ink-950">{order.created_at || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Last checked</dt>
              <dd className="text-ink-950">{checkedAt ? clockTime(checkedAt) : '—'}</dd>
            </div>
          </dl>

          {order.status === 'pending' && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This order is waiting on the supplier. Harry checks its status by reading it and will never
              send it again — re-sending could buy the same domain twice. Quote{' '}
              <span className="font-mono">{order.order_ref}</span> if you contact the supplier.
            </p>
          )}
          {order.status === 'failed' && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              The supplier reported this order as failed. Nothing was provisioned. Start a new order rather
              than re-sending this one.
            </p>
          )}

          <Section id="order-mailboxes" title="Mailboxes on this order">
            {mailboxes.length === 0 ? (
              <p className="text-xs text-slate-500">The supplier has not returned any addresses for this order yet.</p>
            ) : (
              <ul className="space-y-2">
                {mailboxes.map((m) => (
                  <li key={m.address || m.mailbox} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2 last:border-0">
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-ink-900">{m.address || m.mailbox}</span>
                      <span className="block text-[11px] text-slate-500">
                        {[m.first_name, m.last_name].filter(Boolean).join(' ') || 'No name given'}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-2">
                      {order.status === 'placed' && (
                        <button
                          className="btn-ghost px-2 py-1 text-xs cursor-pointer"
                          onClick={() => setCodeFor(m.address || m.mailbox)}
                          aria-label={`Get a sign-in code for ${m.address || m.mailbox}`}
                        >
                          Get sign-in code
                        </button>
                      )}
                      <button
                        className="btn-ghost px-2 py-1 text-xs cursor-pointer"
                        onClick={() => onConnect?.(m.address || m.mailbox)}
                        aria-label={`Add ${m.address || m.mailbox} to Mailboxes`}
                      >
                        Add to Mailboxes
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="order-credentials"
            title="Supplier credentials"
            hint="Harry is an OAuth product; a supplier password is a foreign object in it. If the supplier returns one it passes through once and is stored nowhere."
          >
            {credentials === null ? (
              <button className="btn-ghost text-xs cursor-pointer" onClick={() => setRevealing(true)}>
                Reveal once
              </button>
            ) : credentials.length === 0 ? (
              <p className="text-xs text-slate-500">The supplier returned no credential for this order.</p>
            ) : (
              <div className="space-y-2">
                {credentials.map((c) => (
                  <div key={c.address} className="rounded-lg border border-slate-300 bg-white/60 px-3 py-2">
                    <p className="text-[11px] text-slate-500">{c.address}</p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-950">{c.credential}</p>
                  </div>
                ))}
                <p className="text-[11px] text-amber-800">
                  {data?.credential_notice || 'Harry does not store this and will not show it again.'}
                </p>
              </div>
            )}
          </Section>
        </div>
      )}

      {revealing && (
        <Confirm
          title="Reveal supplier credentials?"
          confirmLabel="Reveal once"
          onClose={() => setRevealing(false)}
          onConfirm={reveal}
          body={
            <span className="block">
              This shows the credential the supplier issued, once. Harry does not store it and cannot show
              it again, and it will never enter a sign-in form on your behalf. The request is written to the
              activity trail; the value is not.
            </span>
          }
        />
      )}

      {codeFor && <CodeModal address={codeFor} onClose={() => setCodeFor('')} />}
    </Drawer>
  )
}

// A one-time code: shown, counted down, and gone. It exists in this component's
// state and nowhere else — not in localStorage, not in a log, not in a URL.
function CodeModal({ address, onClose }) {
  const [state, setState] = useState('loading')
  const [code, setCode] = useState(null)
  const [left, setLeft] = useState(0)
  const [notice, setNotice] = useState('')
  const [recent, setRecent] = useState(0)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [announcement, say] = useAnnounce()
  const timer = useRef(null)

  const fetchCode = useCallback(async () => {
    setState('loading')
    setError(null)
    setCopied(false)
    try {
      const res = await api.get(`/api/senders/mailboxes/${encodeURIComponent(address)}/code`)
      setNotice(res.notice || '')
      setRecent(Number(res.recent_requests) || 0)
      if (res.data?.otp) {
        setCode(String(res.data.otp))
        setLeft(Number(res.data.expires_in) || 300)
        setState('shown')
        say('A sign-in code is on screen. Type it into the supplier’s own sign-in.')
      } else {
        setCode(null)
        setState('none')
        say(res.notice || 'No code is available right now.')
      }
    } catch (err) {
      setError(err)
      setState('error')
      say(err.message)
    }
  }, [address, say])

  useEffect(() => { fetchCode() }, [fetchCode])

  useEffect(() => {
    if (state !== 'shown') return undefined
    timer.current = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          // Expired: the value leaves state immediately rather than sitting
          // there greyed out.
          setCode(null)
          setState('expired')
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(timer.current)
  }, [state])

  useEffect(() => () => { setCode(null); clearInterval(timer.current) }, [])

  const wait = retryAfter(error)

  return (
    <Modal title={`Sign-in code for ${address}`} onClose={onClose}>
      <LiveRegion message={announcement} />

      {state === 'loading' && <p className="py-6 text-center text-sm text-slate-600">Asking the supplier…</p>}

      {state === 'shown' && code && (
        <div className="text-center">
          <p className="font-mono text-3xl tracking-[0.3em] text-ink-950 break-all" aria-label={`Code ${code.split('').join(' ')}`}>
            {code.replace(/(.{3})/g, '$1 ').trim()}
          </p>
          <p className="mt-2 text-xs text-slate-600">
            Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </p>
          <button
            className="btn-ghost mt-3 cursor-pointer"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code)
                setCopied(true)
                say('Code copied to the clipboard')
              } catch {
                setCopied(false)
                say('Copying is not available here — type the code instead')
              }
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
      )}

      {state === 'expired' && (
        <div className="text-center">
          <p className="text-sm text-slate-700">That code has expired.</p>
          <button className="btn-primary mt-3 cursor-pointer" onClick={fetchCode}>Get another code</button>
        </div>
      )}

      {state === 'none' && (
        <div className="text-center">
          <p className="text-sm text-slate-700">{notice || 'No code is available right now.'}</p>
          <button className="btn-ghost mt-3 cursor-pointer" onClick={fetchCode}>Ask again</button>
        </div>
      )}

      {state === 'error' && (
        <div className="text-center">
          <p role="alert" className="text-sm text-red-700">{error?.message}</p>
          {wait > 0 && <p className="mt-1 text-xs text-slate-600">Try again in about {plural(wait, 'second')}.</p>}
          <button className="btn-ghost mt-3 cursor-pointer" onClick={fetchCode}>Try again</button>
        </div>
      )}

      {(state === 'shown' || state === 'none') && notice && (
        <p className="mt-4 text-[11px] text-slate-500">{notice}</p>
      )}
      {recent > 1 && (
        <p className="mt-1 text-[11px] text-slate-500">{recent} code requests for this address in the last five minutes.</p>
      )}

      <div className="mt-5 flex justify-end">
        <button className="btn-ghost cursor-pointer" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

export { STATUS_WORDS }
