// "Get more mailboxes" — the only flow in Harry that spends money.
//
// Three things make it safe, and all three are visible in this file:
//
//   * No card. There is no payment field anywhere in this flow and there never
//     will be. The supplier's own checkout holds the instrument; Harry keeps a
//     reference.
//   * One idempotency key, minted with crypto.randomUUID() when the summary
//     screen opens — not when the button is clicked — and sent once. It is not
//     regenerated, so the same key can never become a second purchase.
//   * No re-submit. A supplier timeout leaves the order `pending`, to be
//     settled by reading it. Nothing here posts an order twice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import { LiveRegion } from '../parity-ui.jsx'
import { Field, Section, Skeleton, errorUnder, fieldError, money, plural, spokenMoney, useAnnounce } from './common.jsx'
import { rememberOrder } from './Orders.jsx'

const LOCAL_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const MAX_PER_DOMAIN = 10

const STEPS = [
  { id: 'vendor', label: 'Supplier' },
  { id: 'search', label: 'Domains' },
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'summary', label: 'Review and confirm' },
]

// place-order.md AC 3 — the registrant record. `state` and the second address
// line are genuinely optional; the rest is what a registration is made of.
const BILLING = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['company', 'Company'],
  ['country', 'Country'],
  ['city', 'City'],
  ['addressLineOne', 'Address line 1'],
  ['addressLineTwo', 'Address line 2 (optional)'],
  ['state', 'State or region (optional)'],
  ['postalCode', 'Postal code'],
  ['phoneCc', 'Phone country code'],
  ['phone', 'Phone'],
]
const BILLING_OPTIONAL = new Set(['addressLineTwo', 'state'])

export default function SenderFlow({ vendors, billingOnFile, billingStorageAvailable, seedDomain, onClose, onPlaced }) {
  const [step, setStep] = useState('vendor')
  const [vendorId, setVendorId] = useState(vendors[0]?.vendor_id || '')
  const [chosen, setChosen] = useState([])
  const [plan, setPlan] = useState([])
  const [error, setError] = useState(null)
  const [announcement, say] = useAnnounce()

  const vendor = vendors.find((v) => v.vendor_id === vendorId) || null
  const currency = chosen.find((d) => d.currency)?.currency || vendor?.currency || 'USD'
  const total = chosen.reduce((sum, d) => sum + (Number(d.price) || 0), 0)
  const pricesUnknown = chosen.some((d) => d.price === null || d.price === undefined)

  // Keep the naming plan in step with what is actually selected.
  useEffect(() => {
    setPlan((prev) => chosen.map((d) => prev.find((p) => p.domain === d.domain) || { domain: d.domain, rows: [] }))
  }, [chosen])

  const go = (next) => {
    setError(null)
    setStep(next)
    say(`Step ${STEPS.findIndex((s) => s.id === next) + 1} of ${STEPS.length}: ${STEPS.find((s) => s.id === next).label}`)
  }

  return (
    <div className="card p-4 space-y-4">
      <LiveRegion message={announcement} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-950">Get more mailboxes</h3>
          <p className="text-xs text-slate-500">
            {vendor ? `Supplier: ${vendor.name}` : 'Choose a supplier to begin'}
            {chosen.length ? ` · ${plural(chosen.length, 'domain')} selected` : ''}
          </p>
        </div>
        <button className="btn-ghost text-xs cursor-pointer" onClick={onClose}>Close</button>
      </div>

      <ol className="flex flex-wrap gap-2 text-[11px]" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={step === s.id ? 'step' : undefined}
            className={`rounded-full border px-2 py-0.5 ${step === s.id ? 'border-accent-500 text-accent-700' : 'border-slate-300 text-slate-500'}`}
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {/* Stated at every step of the flow, not only at the end. */}
      <p className="rounded-lg border border-slate-200 bg-white/40 px-3 py-2 text-[11px] text-slate-600">
        Harry never asks for card details and has no field for one. Payment happens at the supplier's own
        checkout; Harry keeps the order reference so it can tell you where the order got to.
      </p>

      {step === 'vendor' && (
        <VendorStep vendors={vendors} vendorId={vendorId} onPick={setVendorId} onNext={() => go('search')} />
      )}

      {step === 'search' && (
        <SearchStep
          vendorId={vendorId}
          seedDomain={seedDomain}
          chosen={chosen}
          onChange={setChosen}
          onBack={() => go('vendor')}
          onNext={() => go('mailboxes')}
        />
      )}

      {step === 'mailboxes' && (
        <MailboxStep
          vendorId={vendorId}
          plan={plan}
          onChange={setPlan}
          error={error}
          onBack={() => go('search')}
          onNext={() => go('summary')}
        />
      )}

      {step === 'summary' && (
        <SummaryStep
          vendor={vendor}
          plan={plan}
          chosen={chosen}
          total={total}
          currency={currency}
          pricesUnknown={pricesUnknown}
          billingOnFile={billingOnFile}
          billingStorageAvailable={billingStorageAvailable}
          onFieldError={(err) => {
            setError(err)
            if (String(err?.payload?.field || '').startsWith('domains')) go('mailboxes')
          }}
          onBack={() => go('mailboxes')}
          onPlaced={onPlaced}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ step 1 ---

function VendorStep({ vendors, vendorId, onPick, onNext }) {
  if (!vendors.length) {
    return (
      <p className="text-xs text-slate-600">
        No supplier is available for this workspace. That is usually regional — nothing is wrong with your
        account, and everything else on this page still works.
      </p>
    )
  }
  return (
    <fieldset>
      <legend className="text-xs font-medium text-slate-700 mb-2">Choose a supplier</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {vendors.map((v) => (
          <label
            key={v.vendor_id}
            className={`cursor-pointer rounded-lg border px-3 py-2.5 text-xs ${
              vendorId === v.vendor_id ? 'border-accent-500 bg-accent-500/10' : 'border-slate-300'
            }`}
          >
            <input
              type="radio" name="sender-vendor" className="sr-only"
              checked={vendorId === v.vendor_id}
              onChange={() => onPick(v.vendor_id)}
            />
            <span className="block text-sm font-medium text-ink-950">{v.name}</span>
            <span className="block text-slate-600">
              {v.details?.description || 'The supplier does not publish a description.'}
            </span>
            <span className="mt-1 block text-slate-500">
              Prices quoted in {v.currency || 'USD'} — Harry converts nothing.
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button className="btn-primary cursor-pointer" disabled={!vendorId} onClick={onNext}>Search domains</button>
      </div>
    </fieldset>
  )
}

// ------------------------------------------------------------------ step 2 ---

function SearchStep({ vendorId, seedDomain, chosen, onChange, onBack, onNext }) {
  const [q, setQ] = useState(seedDomain || '')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [announcement, say] = useAnnounce()
  const seq = useRef(0)

  useEffect(() => {
    const term = q.trim()
    if (term.replace(/[^a-z0-9]/gi, '').length < 2) { setRes(null); setError(null); return undefined }
    const mine = seq.current + 1
    seq.current = mine
    setBusy(true)
    const timer = setTimeout(() => {
      api.get(`/api/senders/domains/search${qs({ vendor_id: vendorId, q: term })}`)
        .then((out) => {
          if (seq.current !== mine) return // a later keystroke already won
          setRes(out)
          setError(null)
          say(`${(out.data || []).length} domains available`)
        })
        .catch((err) => { if (seq.current === mine) { setError(err); setRes(null) } })
        .finally(() => { if (seq.current === mine) setBusy(false) })
    }, 400)
    return () => clearTimeout(timer)
  }, [q, vendorId, say])

  const pick = (row) => {
    if (chosen.some((d) => d.domain === row.domain)) return
    onChange([...chosen, row])
    say(`${row.domain} selected`)
  }

  return (
    <div>
      <LiveRegion message={announcement} />
      <Field
        id="domain-search"
        label="Search for a domain"
        help="Type a word — a lookalike of your own domain works best. Nothing is bought at this step and no payment detail is asked for."
      >
        {({ id, describedBy }) => (
          <input id={id} className="input" value={q} aria-describedby={describedBy}
            placeholder="acme" onChange={(e) => setQ(e.target.value)} />
        )}
      </Field>

      <p className="mt-2 text-[11px] text-slate-500">
        Only domains at or under {res?.price_ceiling ?? 15} {res?.data?.[0]?.currency || 'USD'} are shown.
        {res?.currency_note ? ` ${res.currency_note}` : ''}
      </p>

      {busy && <Skeleton rows={3} className="h-9" />}
      {error && <p role="alert" className="mt-3 text-xs text-red-700">{error.message}</p>}

      {res && !busy && (res.data || []).length === 0 && (
        <p className="mt-3 text-xs text-slate-600">
          Nothing available for “{q}”. Try a variation — add a word like <em>hq</em>, <em>mail</em> or{' '}
          <em>go</em>, or a different ending.
        </p>
      )}

      {res && !busy && (res.data || []).length > 0 && (
        <ul className="mt-3 divide-y divide-slate-200">
          {res.data.map((row) => (
            <li key={row.domain} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-xs">
                <span className="text-ink-950">{row.domain}</span>
                <span className="ml-2 text-slate-600">
                  {row.price === null ? 'price shown at the supplier’s checkout' : money(row.price, row.currency)}
                </span>
              </span>
              <button
                className="btn-ghost px-2 py-1 text-xs cursor-pointer"
                onClick={() => pick(row)}
                disabled={chosen.some((d) => d.domain === row.domain)}
                aria-label={`Select ${row.domain}`}
              >
                {chosen.some((d) => d.domain === row.domain) ? 'Selected' : 'Select'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chosen.map((d) => (
            <span key={d.domain} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-ink-900">
              {d.domain}
              <button
                type="button" className="cursor-pointer text-slate-500 hover:text-red-600"
                aria-label={`Remove ${d.domain} from this order`}
                onClick={() => onChange(chosen.filter((x) => x.domain !== d.domain))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-between">
        <button className="btn-ghost cursor-pointer" onClick={onBack}>Back</button>
        <button className="btn-primary cursor-pointer" disabled={!chosen.length} onClick={onNext}>
          Name the mailboxes
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ step 3 ---

function MailboxStep({ vendorId, plan, onChange, error, onBack, onNext }) {
  const [count, setCount] = useState(2)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [announcement, say] = useAnnounce()

  const allAddresses = plan.flatMap((p) => p.rows.map((r) => `${r.local}@${p.domain}`.toLowerCase()))
  const duplicate = (address) => allAddresses.filter((a) => a === address).length > 1

  const rowProblem = (p, r) => {
    const address = `${r.local}@${p.domain}`.toLowerCase()
    if (!r.local.trim()) return 'An address is required'
    if (!LOCAL_RE.test(r.local.trim().toLowerCase())) return 'Letters, numbers, dots, plus and dashes only'
    if (duplicate(address)) return `${address} appears twice in this order`
    if (!r.first_name.trim()) return 'A first name is required'
    if (!r.last_name.trim()) return 'A last name is required'
    return ''
  }

  const problems = plan.flatMap((p) => p.rows.map((r) => rowProblem(p, r))).filter(Boolean)
  const empty = plan.some((p) => p.rows.length === 0)

  const suggest = async () => {
    setBusy(true)
    setNote('')
    try {
      const res = await api.post('/api/senders/mailboxes/suggest', {
        vendor_id: vendorId,
        domains: plan.map((p) => ({ domain_name: p.domain, count })),
      })
      const byDomain = new Map((res.data || []).map((d) => [d.domain, d]))
      onChange(plan.map((p) => {
        const got = byDomain.get(p.domain)
        if (!got) return p
        return {
          ...p,
          rows: (got.suggestions || []).map((s) => ({
            local: String(s.mailbox || '').split('@')[0],
            first_name: s.first_name || '',
            last_name: s.last_name || '',
          })),
        }
      }))
      setNote(`${res.note} Names come from ${res.data?.[0]?.source === 'vendor' ? 'the supplier' : `your workspace (${res.identity?.source || 'workspace owner'})`}.`)
      say(`${(res.data || []).reduce((n, d) => n + d.suggestions.length, 0)} suggestions ready — every one is editable.`)
    } catch (err) {
      setNote(`Suggestions are unavailable (${err.message}). Type the addresses yourself — the flow works without them.`)
      say('Suggestions are unavailable. Type the addresses yourself.')
    } finally {
      setBusy(false)
    }
  }

  const setRow = (domain, index, patch) => {
    onChange(plan.map((p) => (p.domain !== domain ? p : {
      ...p,
      rows: p.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    })))
  }

  const addRow = (domain) => {
    onChange(plan.map((p) => (p.domain !== domain ? p : { ...p, rows: [...p.rows, { local: '', first_name: '', last_name: '' }] })))
  }

  return (
    <div>
      <LiveRegion message={announcement} />

      <div className="flex flex-wrap items-end gap-3">
        <Field id="suggest-count" label="Mailboxes per domain" className="w-40"
          help={`At most ${MAX_PER_DOMAIN}. Fewer, well-warmed mailboxes beat many cold ones.`}>
          {({ id, describedBy }) => (
            <input id={id} type="number" className="input" min={1} max={MAX_PER_DOMAIN} value={count}
              aria-describedby={describedBy} onChange={(e) => setCount(Number(e.target.value))} />
          )}
        </Field>
        <button className="btn-ghost cursor-pointer" onClick={suggest} disabled={busy}>
          {busy ? 'Suggesting…' : 'Suggest addresses'}
        </button>
      </div>
      {note && <p className="mt-2 text-[11px] text-slate-600">{note}</p>}

      {plan.map((p, di) => (
        <div key={p.domain} className="mt-4">
          <h4 className="text-xs font-semibold text-ink-900">{p.domain}</h4>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-xs">
              <caption className="sr-only">Mailboxes to create on {p.domain}</caption>
              <thead className="text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">Address</th>
                  <th scope="col" className="py-1 pr-2 font-medium">First name</th>
                  <th scope="col" className="py-1 pr-2 font-medium">Last name</th>
                  <th scope="col" className="py-1 font-medium"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r, ri) => {
                  const problem = rowProblem(p, r)
                  const serverProblem = errorUnder(error, `domains[${di}].mailbox_details[${ri}]`)
                  const bad = problem || serverProblem
                  return (
                    <tr key={ri} className={bad ? 'bg-red-50' : ''}>
                      <td className="py-1 pr-2">
                        <span className="flex items-center gap-1">
                          <input
                            className="input py-1 text-xs" value={r.local}
                            aria-label={`Address on ${p.domain}, row ${ri + 1}`}
                            aria-invalid={bad ? 'true' : undefined}
                            onChange={(e) => setRow(p.domain, ri, { local: e.target.value })}
                          />
                          <span className="text-slate-500">@{p.domain}</span>
                        </span>
                      </td>
                      <td className="py-1 pr-2">
                        <input className="input py-1 text-xs" value={r.first_name}
                          aria-label={`First name, row ${ri + 1} on ${p.domain}`}
                          onChange={(e) => setRow(p.domain, ri, { first_name: e.target.value })} />
                      </td>
                      <td className="py-1 pr-2">
                        <input className="input py-1 text-xs" value={r.last_name}
                          aria-label={`Last name, row ${ri + 1} on ${p.domain}`}
                          onChange={(e) => setRow(p.domain, ri, { last_name: e.target.value })} />
                      </td>
                      <td className="py-1">
                        <button
                          type="button" className="cursor-pointer text-slate-500 hover:text-red-600"
                          aria-label={`Remove row ${ri + 1} on ${p.domain}`}
                          onClick={() => onChange(plan.map((x) => (x.domain !== p.domain ? x : { ...x, rows: x.rows.filter((_, i) => i !== ri) })))}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {p.rows.map((r, ri) => {
            const message = rowProblem(p, r) || errorUnder(error, `domains[${di}].mailbox_details[${ri}]`)
            return message ? (
              <p key={`err-${ri}`} role="alert" className="mt-1 text-[11px] text-red-700">
                Row {ri + 1}: {message}
              </p>
            ) : null
          })}
          <button
            type="button" className="btn-ghost mt-2 px-2 py-1 text-xs cursor-pointer"
            disabled={p.rows.length >= MAX_PER_DOMAIN}
            onClick={() => addRow(p.domain)}
          >
            Add a mailbox on {p.domain}
          </button>
        </div>
      ))}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button className="btn-ghost cursor-pointer" onClick={onBack}>Back</button>
        <span className="flex items-center gap-3">
          {(problems.length > 0 || empty) && (
            <span className="text-[11px] text-red-700">
              {empty ? 'Every domain needs at least one mailbox.' : `${plural(problems.length, 'row')} need fixing.`}
            </span>
          )}
          <button className="btn-primary cursor-pointer" disabled={problems.length > 0 || empty} onClick={onNext}>
            Review the order
          </button>
        </span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ step 4 ---

function SummaryStep({
  vendor, plan, chosen, total, currency, pricesUnknown,
  billingOnFile, billingStorageAvailable, onFieldError, onBack, onPlaced,
}) {
  // Minted when this screen OPENS, sent once, never regenerated — including on
  // anything the user might think of as a retry.
  const [idempotencyKey] = useState(() => (
    globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `htm-${Date.now()}-${performance.now()}`
  ))

  const [forwarding, setForwarding] = useState('')
  const [useStored, setUseStored] = useState(Boolean(billingOnFile))
  const [billing, setBilling] = useState(() => Object.fromEntries(BILLING.map(([k]) => [k, ''])))
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const [placed, setPlaced] = useState(null)
  const [unknown, setUnknown] = useState('')
  const [announcement, say] = useAnnounce()

  const missing = useStored ? [] : BILLING.filter(([k]) => !BILLING_OPTIONAL.has(k) && !billing[k].trim()).map(([, l]) => l)
  const forwardingOk = DOMAIN_RE.test(forwarding.trim().toLowerCase())
  const canConfirm = state === 'idle' && forwardingOk && missing.length === 0

  const body = useMemo(() => ({
    idempotency_key: idempotencyKey,
    vendor_id: vendor?.vendor_id,
    forwarding_domain: forwarding.trim().toLowerCase(),
    total,
    currency,
    domains: plan.map((p) => ({
      domain_name: p.domain,
      mailbox_details: p.rows.map((r) => ({
        mailbox: `${r.local.trim().toLowerCase()}@${p.domain}`,
        first_name: r.first_name.trim(),
        last_name: r.last_name.trim(),
      })),
    })),
    ...(useStored ? {} : { user_details: billing }),
  }), [idempotencyKey, vendor, forwarding, total, currency, plan, useStored, billing])

  const confirm = async () => {
    setState('placing')
    setError(null)
    setUnknown('')
    try {
      const res = await api.post('/api/senders/orders', body)
      rememberOrder(res.data?.order_ref)
      setPlaced(res)
      setState('placed')
      say(`Order ${res.data?.order_ref} recorded. ${res.pending_reason || ''}`)
      onPlaced?.(res.data?.order_ref)
    } catch (err) {
      if (err.status === 0) {
        // The request never came back. The order may or may not exist, and
        // posting it again could buy the same domain twice — so it is not
        // posted again. The reference, if one was minted, appears in Orders.
        setUnknown(
          'Harry could not reach the server, so it does not know whether this order was recorded. It has ' +
          'NOT been sent again — re-sending a purchase can buy the same domain twice. Check the Orders list ' +
          'in a moment; if an order appears there, it exists. This screen will not send it again.'
        )
        setState('unknown')
        say('The order could not be confirmed and has not been re-sent.')
        return
      }
      setError(err)
      setState('idle')
      onFieldError?.(err)
      say(err.message)
    }
  }

  if (placed) {
    const order = placed.data || {}
    return (
      <div>
        <LiveRegion message={announcement} />
        <Section id="order-placed" title="Order recorded">
          <p className="text-sm text-ink-900">
            Reference <span className="font-mono text-accent-700">{order.order_ref}</span>
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {placed.pending_reason
              || 'The supplier accepted the order. New mailboxes appear in the fleet as ordinary rows once they are provisioned.'}
          </p>
          <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
            <li>{placed.registrant_notice}</li>
            {placed.billing_notice && <li>{placed.billing_notice}</li>}
            <li>Harry does not retry an order automatically, and never re-sends one.</li>
          </ul>
          <div className="mt-4 flex gap-2">
            <button className="btn-primary cursor-pointer" onClick={onBack}>Back to the flow</button>
          </div>
        </Section>
      </div>
    )
  }

  return (
    <div>
      <LiveRegion message={announcement} />

      {/* The summary is a definition list, read in order. */}
      <Section id="order-summary" title="What you are buying">
        <dl className="space-y-2 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Supplier</dt>
            <dd className="text-ink-950">{vendor?.name || '—'}</dd>
          </div>
          {plan.map((p) => {
            const priced = chosen.find((c) => c.domain === p.domain)
            return (
              <div key={p.domain} className="border-t border-slate-200 pt-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-900">{p.domain}</dt>
                  <dd className="text-ink-950">
                    {priced?.price === null || priced?.price === undefined
                      ? 'price at the supplier’s checkout'
                      : money(priced.price, priced.currency || currency)}
                  </dd>
                </div>
                <dd className="mt-1 text-slate-600">
                  {p.rows.map((r) => `${r.local}@${p.domain}`).join(', ')}
                </dd>
              </div>
            )
          })}
          <div className="flex justify-between gap-3 border-t border-slate-200 pt-2">
            <dt className="text-slate-700">Total</dt>
            <dd className="text-ink-950 font-medium">
              {pricesUnknown ? `${money(total, currency)} for the priced domains` : money(total, currency)}
            </dd>
          </div>
        </dl>
      </Section>

      <div className="mt-4">
        <Field
          id="forwarding-domain"
          label="Forwarding domain"
          help="Where mail to these new addresses should forward. A domain you already own, such as yourcompany.com."
          error={fieldError(error, 'forwarding_domain') || (forwarding && !forwardingOk ? 'That does not look like a domain — try example.com' : '')}
        >
          {({ id, describedBy }) => (
            <input id={id} className="input" value={forwarding} aria-describedby={describedBy}
              placeholder="yourcompany.com" onChange={(e) => setForwarding(e.target.value)} />
          )}
        </Field>
      </div>

      {/* Disclosure before the form is filled in, not after. */}
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
        These contact details are passed to the supplier as the domain registrant and may appear in public
        registration records. {billingStorageAvailable
          ? 'Harry stores them encrypted so the next order does not ask again.'
          : 'Harry will not store them — storing them unencrypted is not an option it offers — so the next order will ask again.'}
      </p>

      {billingOnFile && (
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
          <input type="checkbox" className="size-4 accent-emerald-500 cursor-pointer"
            checked={useStored} onChange={(e) => setUseStored(e.target.checked)} />
          Reuse the contact details already on file
        </label>
      )}

      {!useStored && (
        <fieldset className="mt-3 grid gap-3 sm:grid-cols-2">
          <legend className="text-xs font-medium text-slate-700 mb-1">Registrant contact details</legend>
          {BILLING.map(([key, label]) => (
            <Field
              key={key}
              id={`billing-${key}`}
              label={label}
              error={fieldError(error, `user_details.${key}`)}
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className="input"
                  type={key === 'email' ? 'email' : 'text'}
                  value={billing[key]}
                  autoComplete="off"
                  aria-describedby={describedBy}
                  onChange={(e) => setBilling((b) => ({ ...b, [key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </fieldset>
      )}

      {error && !error.payload?.field && (
        <p role="alert" className="mt-3 text-xs text-red-700">{error.message}</p>
      )}
      {unknown && (
        <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {unknown}
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-3 text-[11px] text-slate-500">Still needed: {missing.join(', ')}.</p>
      )}

      {/* Pinned on narrow screens so the total and the action stay together. */}
      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-2 bg-white/95 py-3">
        <button className="btn-ghost cursor-pointer" onClick={onBack} disabled={state === 'placing'}>Back</button>
        <button
          className="btn-primary cursor-pointer"
          disabled={!canConfirm}
          onClick={confirm}
          aria-label={`Confirm order, ${spokenMoney(total, currency)}`}
        >
          {state === 'placing' ? 'Placing the order…'
            : state === 'unknown' ? 'Not confirmed — check Orders'
            : `Confirm order — ${money(total, currency)}`}
        </button>
      </div>
    </div>
  )
}
