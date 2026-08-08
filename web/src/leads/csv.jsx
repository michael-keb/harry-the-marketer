// The one CSV importer, used twice.
//
// Docs/lead-lists/import-leads.md is explicit that importing into a segment
// must be "the existing one, not a second implementation", so the parser, the
// column guess and the mapping table live here and both the workspace importer
// and the segment importer render them.

// RFC 4180-ish: quoted fields, doubled quotes, CR/LF or LF line endings.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

// What POST /api/leads/import accepts.
export const LEAD_FIELDS = [
  { key: 'email', label: 'Email', required: true, match: ['email', 'emailaddress'] },
  { key: 'firstName', label: 'First name', match: ['firstname', 'first', 'givenname'] },
  { key: 'lastName', label: 'Last name', match: ['lastname', 'last', 'surname', 'familyname'] },
  { key: 'company', label: 'Company', match: ['company', 'organisation', 'organization', 'account'] },
  { key: 'title', label: 'Title', match: ['jobtitle', 'title', 'role', 'position'] },
  { key: 'notes', label: 'Notes', match: ['note'] },
]

// What POST /api/lead-lists/:id/import accepts — the same five, plus the
// extended contact fields the segment importer writes straight onto the lead.
export const SEGMENT_FIELDS = [
  ...LEAD_FIELDS.filter((f) => f.key !== 'notes'),
  { key: 'phone', label: 'Phone', match: ['phone', 'mobile', 'telephone', 'tel'] },
  { key: 'website', label: 'Website', match: ['website', 'url', 'domain', 'site'] },
  { key: 'linkedin', label: 'LinkedIn', match: ['linkedin', 'li'] },
  { key: 'location', label: 'Location', match: ['location', 'city', 'country', 'region'] },
]

const normalise = (header) => String(header || '').toLowerCase().replace(/[^a-z]/g, '')

// First unassigned field whose name the header contains. Longest match keys are
// listed first inside each field so "jobtitle" cannot be read as a first name.
export function guessMapping(headers, fields) {
  const mapping = {}
  const taken = new Set()
  headers.forEach((header, index) => {
    const key = normalise(header)
    if (!key) return
    for (const field of fields) {
      if (taken.has(field.key)) continue
      if (field.match.some((m) => key.includes(m))) {
        mapping[field.key] = index
        taken.add(field.key)
        return
      }
    }
  })
  return mapping
}

// A real table with header associations, as the accessibility note asks.
export function ColumnMapper({ headers, fields, mapping, onChange }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Match each lead field to a column in your file</caption>
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
          <th scope="col" className="py-2 pr-3 font-medium">Lead field</th>
          <th scope="col" className="py-2 font-medium">Column in your file</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key} className="border-b border-slate-200 last:border-0">
            <th scope="row" className="py-2 pr-3 text-left font-normal text-slate-700">
              {field.label}{field.required && <span className="text-accent-700"> (required)</span>}
            </th>
            <td className="py-2">
              <label className="sr-only" htmlFor={`map-${field.key}`}>Column holding {field.label}</label>
              <select
                id={`map-${field.key}`}
                className="input"
                value={mapping[field.key] ?? ''}
                onChange={(e) => onChange({
                  ...mapping,
                  [field.key]: e.target.value === '' ? undefined : Number(e.target.value),
                })}
              >
                <option value="">— not mapped —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Turn the parsed rows plus a mapping into the objects a route accepts.
export function mapRows(rows, mapping) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(mapping)
      .filter(([, index]) => index !== undefined)
      .map(([key, index]) => [key, row[index] ?? ''])
  ))
}

// The four-way summary, with a row number on every error. Shown before the
// segment import commits and again with the real counts afterwards.
export function ImportSummary({ result, title = 'Import result' }) {
  if (!result) return null
  const rows = [
    ['Added', result.imported, 'new people written to your leads'],
    ['Already known', result.duplicates, 'details refreshed, no duplicate created'],
    ['Blocked by suppression', result.blocked, 'unsubscribed or on the blocked-domain list'],
    ['Malformed', result.invalid, 'missing or unusable email address'],
  ]
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <h4 className="text-sm font-semibold text-ink-950">{title}</h4>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <dt className="text-[11px] text-slate-600">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink-950">{Number(value || 0).toLocaleString()}</dd>
            <dd className="mt-0.5 text-[11px] text-slate-500">{hint}</dd>
          </div>
        ))}
      </dl>
      {result.suppression && (result.suppression.unsubscribed || result.suppression.blockedDomain) ? (
        <p className="text-xs text-slate-600">
          Of the blocked rows, {Number(result.suppression.unsubscribed || 0).toLocaleString()} had unsubscribed and{' '}
          {Number(result.suppression.blockedDomain || 0).toLocaleString()} were on a blocked domain. Harry offers no way
          to override either.
        </p>
      ) : null}
      {Array.isArray(result.errors) && result.errors.length > 0 && (
        <details className="rounded-lg border border-slate-200">
          <summary className="cursor-pointer px-3 py-2 text-xs text-slate-700">
            {result.errors.length.toLocaleString()} row{result.errors.length === 1 ? '' : 's'} were not imported — show them
          </summary>
          <div className="max-h-48 overflow-y-auto border-t border-slate-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th scope="col" className="px-3 py-1.5 font-medium">Row</th>
                  <th scope="col" className="px-3 py-1.5 font-medium">Email</th>
                  <th scope="col" className="px-3 py-1.5 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.errors.map((e, i) => (
                  <tr key={i} className="border-t border-slate-200">
                    <td className="px-3 py-1.5 tabular-nums text-slate-600">{e.row}</td>
                    <td className="px-3 py-1.5 text-slate-700">{e.email || '—'}</td>
                    <td className="px-3 py-1.5 text-slate-600">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
