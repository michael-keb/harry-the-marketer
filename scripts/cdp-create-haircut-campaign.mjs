#!/usr/bin/env node
// Creates and starts "Operation Fresh Cut" in production through the app's own
// API, from inside the user's authenticated tab (CDP on 127.0.0.1:9333).
// Same-origin fetches carry the session cookie; nothing here handles credentials.

const CDP = 'http://127.0.0.1:9333'

const MERMAID = `flowchart TD
    S([Start]) --> A[Send: curiosity hook — open with the 11-second first impression stat, tease that one small change this week beats any productivity hack, ask when the current haircut last earned a compliment]
    A -- reply: interested --> B[Send: close — propose booking the haircut this week, offer two concrete windows, keep it under four sentences]
    A -- reply: question --> Q[Send: answer the question directly, then social proof — people who keep a standing monthly cut say it pays for itself in first impressions — and suggest booking this week]
    A -- reply: not now --> N[Wait: 7d]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 1d --> F[Send: loss-aversion hook — every meeting this week is a first impression that cannot be re-run, and hair is half the frame; one line, end with a yes or no question]
    F -- reply: interested --> B
    F -- reply: question --> Q
    F -- no reply 2d --> G[Send: scarcity and identity hook — good barbers book out by Thursday, and the professional clients trust starts at the mirror; last friendly check-in, close politely]
    G -- reply: interested --> B
    G -- no reply 3d --> L([Lost: the haircut did not happen])
    N --> A2[Send: re-engage — reference the earlier not-now, note a fresh week is the cheapest rebrand on the market, one line, one question]
    A2 -- reply: interested --> B
    A2 -- no reply 3d --> L
    B -- reply --> W([Won: haircut booked])
    B -- no reply 2d --> G
    Q -- reply: interested --> B
    Q -- no reply 2d --> F
`

const targets = await (await fetch(`${CDP}/json`)).json()
const tab = targets.find((t) => t.type === 'page' && t.url.startsWith('https://harrythemarketer.com'))
if (!tab) { console.error('No harrythemarketer.com tab found'); process.exit(1) }

const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

// The whole flow runs as one in-page async expression returning a JSON log.
const flow = `(async () => {
  const out = []
  const j = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    out.push({ step: method + ' ' + path, status: res.status, data })
    if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ': ' + JSON.stringify(data).slice(0, 300))
    return data
  }
  try {
    const me = await j('GET', '/api/auth/me')
    const email = me?.user?.email || me?.email || ''
    if (!/praxis-au\\.com$/.test(email)) throw new Error('Signed in as ' + email + ' — expected michael@praxis-au.com')

    const mailboxes = await j('GET', '/api/mailboxes')
    const list = Array.isArray(mailboxes) ? mailboxes : mailboxes.mailboxes || mailboxes.data || []
    const sender = list.find((m) => (m.email || '').toLowerCase() === 'michael@praxis-au.com')
    if (!sender) throw new Error('mailbox michael@praxis-au.com not found: ' + list.map((m) => m.email).join(', '))

    const campaign = await j('POST', '/api/campaigns', { name: 'Operation Fresh Cut' })
    const id = campaign.id

    await j('PUT', '/api/campaigns/' + id + '/sequence', { mermaid: ${JSON.stringify(MERMAID)} })
    await j('PUT', '/api/campaigns/' + id + '/settings', { purpose: 'commercial', email_subject: 'The 11-second first impression' })
    await j('PUT', '/api/campaigns/' + id, { mailboxId: sender.id, requireApproval: true })

    let leadId = null
    const existing = await j('GET', '/api/leads?q=' + encodeURIComponent('hello@thedigitalba.com.au'))
    const rows = Array.isArray(existing) ? existing : existing.leads || existing.data || []
    const hit = rows.find((l) => (l.email || '').toLowerCase() === 'hello@thedigitalba.com.au')
    if (hit) leadId = hit.id
    else {
      const lead = await j('POST', '/api/leads', {
        email: 'hello@thedigitalba.com.au', firstName: 'Michael', company: 'The Digital BA', title: 'The Customer',
      })
      leadId = lead.id
    }
    await j('POST', '/api/campaigns/' + id + '/leads', { leadIds: [leadId] })

    await j('PUT', '/api/campaigns/' + id + '/status', { status: 'START' })
    const detail = await j('GET', '/api/campaigns/' + id)
    return JSON.stringify({ ok: true, campaignId: id, leadId, status: detail.status, log: out })
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err.message || err), log: out })
  }
})()`

const res = await cdp('Runtime.evaluate', { expression: flow, awaitPromise: true, returnByValue: true })
ws.close()
const value = res?.result?.result?.value
if (!value) { console.error('CDP evaluate failed:', JSON.stringify(res).slice(0, 500)); process.exit(1) }
const report = JSON.parse(value)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
