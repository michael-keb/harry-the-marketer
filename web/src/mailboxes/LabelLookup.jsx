// "Paste a column of addresses and tell me what each one is labelled with."
//
// A reconciliation asks three questions, so the results answer three: found and
// labelled, found and unlabelled, and not in this workspace at all. The
// unlabelled group can be labelled without leaving the panel, because sending
// someone back to the list to find the rows they just identified is the part
// that makes reconciliation tedious.

import { useState } from 'react'
import { api } from '../api.js'
import { LiveRegion, Modal, TagChip } from '../parity-ui.jsx'
import BulkLabels from './BulkLabels.jsx'
import { chunk, plural, useAnnounce } from './common.jsx'

const LOOKUP_BATCH = 200

export default function LabelLookup({ onClose, onChanged }) {
  const [text, setText] = useState('')
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [picked, setPicked] = useState([])
  const [tagging, setTagging] = useState(false)
  const [announcement, say] = useAnnounce()

  const addresses = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)

  const run = async () => {
    setState('looking')
    setError(null)
    setResult(null)
    try {
      const found = []
      const missing = []
      // Chunked because the endpoint caps a request at 200 addresses. The cap
      // is never surfaced — it is not the user's problem.
      for (const batch of chunk([...new Set(addresses.map((a) => a.toLowerCase()))], LOOKUP_BATCH)) {
        const res = await api.post('/api/tags/lookup', { appliesTo: 'mailbox', emails: batch })
        found.push(...(res.data || []))
        missing.push(...(res.notFound || []))
      }
      setResult({ found, missing })
      setState('done')
      say(`${found.length} found, ${missing.length} not in this workspace`)
    } catch (err) {
      setError(err)
      setState('idle')
      say(err.message)
    }
  }

  const labelled = (result?.found || []).filter((r) => r.tags?.length)
  const unlabelled = (result?.found || []).filter((r) => !r.tags?.length)

  const rowsForTagging = unlabelled
    .filter((r) => picked.includes(r.mailboxId))
    .map((r) => ({ id: r.mailboxId, fromEmail: r.fromEmail, tags: [] }))

  return (
    <Modal title="Look up mailboxes by address" onClose={onClose} wide>
      <LiveRegion message={announcement} />

      <label className="block text-xs font-medium text-slate-700 mb-1" htmlFor="lookup-box">
        Addresses — one per line, or comma separated
      </label>
      <textarea
        id="lookup-box"
        className="input h-28 font-mono text-xs"
        value={text}
        autoFocus
        placeholder={'sales@acme.com\nhello@acme.com'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-500">{plural(addresses.length, 'address', 'addresses')} to look up</span>
        <button className="btn-primary cursor-pointer" disabled={!addresses.length || state === 'looking'} onClick={run}>
          {state === 'looking' ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-red-700">{error.message}</p>}

      {result && (
        <div className="mt-4 space-y-4">
          <Group
            title={`Found and labelled — ${labelled.length}`}
            empty="None of these addresses carries a label."
            rows={labelled}
          />

          <div>
            <h3 className="text-xs font-semibold text-ink-900">Found and unlabelled — {unlabelled.length}</h3>
            {unlabelled.length === 0 ? (
              <p className="mt-1 text-xs text-slate-500">Every mailbox found already carries at least one label.</p>
            ) : (
              <>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-left text-xs">
                    <caption className="sr-only">Mailboxes found in this workspace with no label</caption>
                    <thead className="text-slate-500">
                      <tr>
                        <th scope="col" className="py-1 pr-3 font-medium w-8"><span className="sr-only">Select</span></th>
                        <th scope="col" className="py-1 font-medium">Address</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-700">
                      {unlabelled.map((r) => (
                        <tr key={r.mailboxId} className="border-t border-slate-200">
                          <td className="py-1 pr-3">
                            <input
                              type="checkbox"
                              className="size-4 accent-emerald-500 cursor-pointer"
                              checked={picked.includes(r.mailboxId)}
                              aria-label={`Select ${r.fromEmail}`}
                              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.mailboxId] : p.filter((id) => id !== r.mailboxId)))}
                            />
                          </td>
                          <td className="py-1">{r.fromEmail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="btn-ghost text-xs cursor-pointer"
                    onClick={() => setPicked(unlabelled.map((r) => r.mailboxId))}
                  >
                    Select all {unlabelled.length}
                  </button>
                  <button
                    className="btn-primary text-xs cursor-pointer"
                    disabled={!picked.length}
                    onClick={() => setTagging(true)}
                  >
                    Add labels to {plural(picked.length, 'mailbox', 'mailboxes')}
                  </button>
                </div>
              </>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold text-ink-900">Not in this workspace — {result.missing.length}</h3>
            {result.missing.length === 0
              ? <p className="mt-1 text-xs text-slate-500">Every address you pasted is a mailbox here.</p>
              : <p className="mt-1 break-words text-xs text-slate-600">{result.missing.join(', ')}</p>}
          </div>
        </div>
      )}

      {tagging && (
        <BulkLabels
          mode="add"
          rows={rowsForTagging}
          onClose={() => { setTagging(false); run() }}
          onDone={onChanged}
        />
      )}
    </Modal>
  )
}

function Group({ title, empty, rows }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-ink-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li key={r.mailboxId} className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
              <span>{r.fromEmail}</span>
              {(r.tags || []).map((t) => <TagChip key={t.id} tag={t} />)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
