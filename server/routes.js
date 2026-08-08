// REST API for leads, mailboxes, campaigns, inbox, dashboard.
import express from 'express'
import { db, logEvent, touch, kvGet } from './db.js'
import { requireUser, workspace } from './auth.js'
import { googleConfigured, auth0Configured, devLoginEnabled, env } from './env.js'
import { telemetryRecent, telemetryStats, telemetryFailures } from './telemetry.js'
import { parsePlaybook, DEFAULT_PLAYBOOK } from './playbook.js'
import { simulateReply, remainingQuota, sendEmail } from './mailer.js'
import { tick, campaignCtx, routeReply } from './engine.js'
import { aiStatus, CORE_INTENTS, planGoal, goalPlaybook, qualifyLead, researchLead, generatePlaybook, previewPlaybookEmails, composeStepSample, exampleLead } from './ai.js'
import { setSendInstruction, sanitizeInstruction } from '../shared/playbook-edit.js'
import { pendingDrafts, pendingCount, discardStaleDraft } from './drafts.js'
import { leadStages } from './stages.js'
import { consentFor, ensureConsent, consentUrl, ownerTerms } from './consent.js'
import { post as postWebhook, webhookKind } from './alerts.js'
import { createSheet, disconnectSheet, pushSheet } from './sheets.js'
import { dailyCap, isWarmingUp, sendWindow, DEFAULT_WINDOW } from './pacing.js'
import { resolveSend, sendingContext } from './gates.js'
import { registerSendControls } from './send-controls.js'
import { registerParity } from './parity/index.js'
import { suppressionFor } from './suppression.js'

// When may this mailbox send, and if not now, why and when? Shared by the
// mailbox list, the campaign header and the approval queue so they never
// disagree — and answered by the same resolver the engine uses, so none of them
// can disagree with what actually happens either.
function sendingStatus(wsId, mailbox, campaign = null) {
  if (!mailbox) return null
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
  const { rules, holds } = sendingContext({ owner, campaign, mailbox })
  const slot = resolveSend({ owner, campaign, mailbox, rules, holds })
  return {
    ok: slot.ok,
    gate: slot.gate,
    reason: slot.reason || '',
    needs: slot.needs,
    until: slot.until ? new Date(slot.until).toISOString() : null,
    cap: dailyCap(mailbox),
    dailyLimit: mailbox.daily_limit,
    warmingUp: isWarmingUp(mailbox),
    paced: sendWindow(owner).on && mailbox.provider === 'gmail',
  }
}

export const api = express.Router()
api.use(express.json({ limit: '5mb' }))
api.use(requireUser)
api.use(workspace)

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ---- leads ------------------------------------------------------------------

api.get('/leads', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  // The client lens: an agency scopes the whole product to one client, and a
  // lead belongs to at most one. Absent, everything in the workspace shows.
  const clientId = Number(req.query.clientId) || 0
  let rows = clientId
    ? db.prepare('SELECT * FROM leads WHERE user_id = ? AND client_id = ? ORDER BY id DESC').all(req.wsId, clientId)
    : db.prepare('SELECT * FROM leads WHERE user_id = ? ORDER BY id DESC').all(req.wsId)
  if (q) {
    rows = rows.filter((l) =>
      [l.email, l.first_name, l.last_name, l.company, l.title].join(' ').toLowerCase().includes(q)
    )
  }
  // Where each prospect actually is — derived, never stored, so it cannot drift.
  const stages = leadStages(req.wsId)
  const consents = Object.fromEntries(
    db.prepare('SELECT * FROM consents WHERE user_id = ?').all(req.wsId).map((c) => [c.lead_id, c])
  )
  res.json(rows.map((l) => ({
    ...l,
    stage: stages[l.id] || 'not contacted',
    consent: consents[l.id]
      ? { status: consents[l.id].status, signedName: consents[l.id].signed_name, signedAt: consents[l.id].signed_at }
      : null,
  })))
})

api.post('/leads', (req, res) => {
  const { email, firstName = '', lastName = '', company = '', title = '', notes = '' } = req.body || {}
  const cleaned = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(cleaned)) return res.status(400).json({ error: 'A valid email address is required' })
  try {
    const info = db.prepare(
      'INSERT INTO leads (user_id, email, first_name, last_name, company, title, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.wsId, cleaned, firstName.trim(), lastName.trim(), company.trim(), title.trim(), notes.trim())
    logEvent(req.wsId, { leadId: info.lastInsertRowid, type: 'lead_added', detail: cleaned })
    res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid))
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: `${cleaned} is already in your leads` })
    throw err
  }
})

api.put('/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })
  const { firstName, lastName, company, title, notes, status } = req.body || {}
  if (status && !['active', 'unsubscribed', 'bounced'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
  db.prepare(
    `UPDATE leads SET first_name = ?, last_name = ?, company = ?, title = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    firstName ?? lead.first_name, lastName ?? lead.last_name, company ?? lead.company,
    title ?? lead.title, notes ?? lead.notes, status ?? lead.status, lead.id
  )
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id))
})

api.delete('/leads/:id', (req, res) => {
  const info = db.prepare('DELETE FROM leads WHERE id = ? AND user_id = ?').run(req.params.id, req.wsId)
  if (!info.changes) return res.status(404).json({ error: 'Lead not found' })
  res.json({ ok: true })
})

// CSV import: client parses the file, sends rows; server dedupes and validates.
api.post('/leads/import', (req, res) => {
  const rows = req.body?.rows
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows to import' })
  if (rows.length > 10000) return res.status(400).json({ error: 'Max 10,000 rows per import' })
  let added = 0, skipped = 0
  const errors = []
  const insert = db.prepare(
    'INSERT INTO leads (user_id, email, first_name, last_name, company, title, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const importAll = db.transaction(() => {
    for (const row of rows) {
      const email = String(row.email || '').trim().toLowerCase()
      if (!EMAIL_RE.test(email)) { skipped++; if (errors.length < 5) errors.push(`invalid email: "${row.email}"`); continue }
      try {
        insert.run(req.wsId, email, String(row.firstName || '').trim(), String(row.lastName || '').trim(),
          String(row.company || '').trim(), String(row.title || '').trim(), String(row.notes || '').trim())
        added++
      } catch (err) {
        if (String(err).includes('UNIQUE')) skipped++
        else throw err
      }
    }
  })
  importAll()
  logEvent(req.wsId, { type: 'leads_imported', detail: `${added} added, ${skipped} skipped` })
  res.json({ added, skipped, errors })
})

// ---- mailboxes --------------------------------------------------------------

api.get('/mailboxes', (req, res) => {
  const rows = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY id').all(req.wsId)
  res.json({
    googleConfigured: googleConfigured(),
    mailboxes: rows.map((m) => ({
      id: m.id, provider: m.provider, email: m.email, displayName: m.display_name,
      status: m.status, dailyLimit: m.daily_limit, remainingToday: remainingQuota(m),
      lastError: m.last_error, lastSyncAt: m.last_sync_at, createdAt: m.created_at,
      sending: sendingStatus(req.wsId, m),
    })),
  })
})

api.post('/mailboxes/sandbox', (req, res) => {
  const name = String(req.body?.name || 'Sandbox Sender').trim()
  const emailAddr = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@sandbox.local`
  try {
    const info = db.prepare(
      "INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', ?, ?)"
    ).run(req.wsId, emailAddr, name)
    logEvent(req.wsId, { type: 'mailbox_connected', detail: `sandbox:${emailAddr}` })
    res.json(db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(info.lastInsertRowid))
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'A sandbox mailbox with that name already exists' })
    throw err
  }
})

api.put('/mailboxes/:id', (req, res) => {
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' })
  const limit = Number(req.body?.dailyLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return res.status(400).json({ error: 'Daily limit must be 1-2000' })
  db.prepare('UPDATE mailboxes SET daily_limit = ? WHERE id = ?').run(limit, mailbox.id)
  res.json({ ok: true })
})

api.delete('/mailboxes/:id', (req, res) => {
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' })
  const inUse = db.prepare("SELECT COUNT(*) c FROM campaigns WHERE mailbox_id = ? AND status IN ('running','paused')").get(mailbox.id)
  if (inUse.c) return res.status(409).json({ error: `Mailbox is used by ${inUse.c} campaign(s) — archive them first` })
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailbox.id)
  logEvent(req.wsId, { type: 'mailbox_removed', detail: mailbox.email })
  res.json({ ok: true })
})

// ---- campaigns --------------------------------------------------------------

function campaignSummary(c) {
  const counts = db.prepare(
    `SELECT state, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? GROUP BY state`
  ).all(c.id).reduce((acc, r) => ({ ...acc, [r.state]: r.n }), {})
  const sent = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'").get(c.id).n
  const replies = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'in'").get(c.id).n
  const won = db.prepare("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND outcome = 'won'").get(c.id).n
  const opens = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND opened_at != ''").get(c.id).n
  const clicks = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND clicked_at != ''").get(c.id).n
  return { id: c.id, name: c.name, status: c.status, mailboxId: c.mailbox_id, createdAt: c.created_at, updatedAt: c.updated_at, counts, sent, replies, won, opens, clicks }
}

api.get('/campaigns', (req, res) => {
  const rows = db.prepare("SELECT * FROM campaigns WHERE user_id = ? AND status != 'archived' ORDER BY id DESC").all(req.wsId)
  res.json(rows.map(campaignSummary))
})

api.post('/campaigns', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Campaign name is required' })
  const info = db.prepare('INSERT INTO campaigns (user_id, name, mermaid) VALUES (?, ?, ?)')
    .run(req.wsId, name, DEFAULT_PLAYBOOK)
  logEvent(req.wsId, { campaignId: info.lastInsertRowid, type: 'campaign_created', detail: name })
  res.json(campaignSummary(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid)))
})

function getCampaign(req, res) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!c) res.status(404).json({ error: 'Campaign not found' })
  return c
}

api.get('/campaigns/:id', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const graph = parsePlaybook(c.mermaid)
  const leads = db.prepare(
    `SELECT cl.*, l.email, l.first_name, l.last_name, l.company FROM campaign_leads cl
     JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? ORDER BY cl.id`
  ).all(c.id)

  // Node performance: how each step of the diagram is doing.
  const sentPerNode = Object.fromEntries(db.prepare(
    "SELECT node_id, COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out' AND node_id NOT IN ('', 'manual') GROUP BY node_id"
  ).all(c.id).map((r) => [r.node_id, r.n]))
  const leadsPerNode = Object.fromEntries(db.prepare(
    "SELECT node_id, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND state IN ('active','waiting','needs_attention','error') GROUP BY node_id"
  ).all(c.id).map((r) => [r.node_id, r.n]))
  const finishedPerNode = Object.fromEntries(db.prepare(
    "SELECT node_id, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND state = 'finished' GROUP BY node_id"
  ).all(c.id).map((r) => [r.node_id, r.n]))
  const nodeStats = Object.values(graph.nodes)
    .filter((n) => ['send', 'wait', 'decision', 'terminal'].includes(n.type))
    .map((n) => ({
      id: n.id, type: n.type, label: n.label,
      sent: sentPerNode[n.id] || 0,
      leadsHere: (leadsPerNode[n.id] || 0) + (n.type === 'terminal' ? finishedPerNode[n.id] || 0 : 0),
    }))

  const linkedGoal = db.prepare(
    "SELECT id, name, target, description FROM goals WHERE campaign_id = ? AND status != 'archived'"
  ).get(c.id)

  const mailbox = c.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(c.mailbox_id) : null

  res.json({
    ...campaignSummary(c), mermaid: c.mermaid,
    validation: { valid: graph.valid, errors: graph.errors, warnings: graph.warnings },
    leads, nodeStats, goal: linkedGoal || null,
    sending: sendingStatus(req.wsId, mailbox, c),
  })
})

// Link this campaign to a goal (the goal owns the pointer). goalId null unlinks.
api.put('/campaigns/:id/goal', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const goalId = req.body?.goalId
  if (goalId === null || goalId === undefined || goalId === '') {
    db.prepare('UPDATE goals SET campaign_id = NULL WHERE campaign_id = ? AND user_id = ?').run(c.id, req.wsId)
    return res.json({ ok: true, goal: null })
  }
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(goalId, req.wsId)
  if (!goal) return res.status(404).json({ error: 'Goal not found' })
  db.prepare('UPDATE goals SET campaign_id = NULL WHERE campaign_id = ? AND user_id = ?').run(c.id, req.wsId)
  db.prepare('UPDATE goals SET campaign_id = ? WHERE id = ?').run(c.id, goal.id)
  logEvent(req.wsId, { campaignId: c.id, type: 'goal_linked', detail: goal.name })
  res.json({ ok: true, goal: { id: goal.id, name: goal.name, target: goal.target } })
})

// Generate the playbook with AI from a brief + the linked goal + business context.
api.post('/campaigns/:id/generate-playbook', async (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const goal = db.prepare("SELECT * FROM goals WHERE campaign_id = ? AND status != 'archived'").get(c.id)
  const result = await generatePlaybook({
    brief: String(req.body?.brief || '').slice(0, 1000),
    goal: goal ? { name: goal.name, description: goal.description, target: goal.target, icp: goal.icp } : null,
    businessContext: owner.business_context,
  })
  logEvent(req.wsId, { campaignId: c.id, type: 'playbook_generated', detail: `via ${result.via}` })
  res.json(result)
})

// Copy the user has approved for this campaign's Send steps, as a node_id map.
// Copy they have approved in the editor but not saved yet travels with the
// request, the same way the unsaved diagram does — previewing an edit before
// committing it is the whole point of that screen.
function approvedCopy(campaignId, unsaved) {
  const rows = db.prepare('SELECT node_id, subject, body FROM node_examples WHERE campaign_id = ?').all(campaignId)
  const out = Object.fromEntries(rows.map((r) => [r.node_id, { subject: r.subject, body: r.body }]))
  if (!Array.isArray(unsaved)) return out
  for (const item of unsaved.slice(0, 50)) {
    const nodeId = String(item?.nodeId || '').slice(0, 64)
    if (!nodeId) continue
    const body = String(item?.body || '').trim().slice(0, 5000)
    if (!body) delete out[nodeId]
    else out[nodeId] = { subject: String(item?.subject || '').slice(0, 300), body }
  }
  return out
}

// Who the samples are written to: a real attached lead when one is asked for,
// otherwise a stand-in shaped by the linked goal's ICP.
function previewRecipient(req, res, campaign) {
  if (req.body?.leadId) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.body.leadId, req.wsId)
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' })
      return null
    }
    return lead
  }
  const goal = db.prepare("SELECT * FROM goals WHERE campaign_id = ? AND status != 'archived'").get(campaign.id)
  let icp = null
  try { icp = goal?.icp ? JSON.parse(goal.icp) : null } catch { icp = null }
  return exampleLead(icp)
}

// Sample emails for every Send step of a playbook — what the agent would
// actually write, before anything is saved or sent. Works on the editor buffer
// so you can read the emails a diagram produces while you are still editing it.
api.post('/campaigns/:id/preview-messages', async (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const mermaid = req.body?.mermaid ? String(req.body.mermaid).slice(0, 20000) : c.mermaid
  const graph = parsePlaybook(mermaid)
  if (!graph.valid) {
    return res.status(400).json({ error: 'Fix the playbook errors first — the samples follow the diagram', validation: { errors: graph.errors, warnings: graph.warnings } })
  }

  // Preview as a real attached lead when asked, so the personalisation is real.
  const subject = previewRecipient(req, res, c)
  if (!subject) return
  const mailbox = c.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(c.mailbox_id) : null

  // Streamed as newline-delimited JSON. Every sample is its own model call, so
  // holding all of them back until the slowest one lands wastes the wait — the
  // shape of the answer arrives first, then each email as it is written.
  res.locals.skipCompression = true // the gzip middleware buffers to end()
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // proxies must not sit on this
  })
  const send = (line) => {
    res.write(`${JSON.stringify(line)}\n`)
    res.flush?.()
  }

  send({
    type: 'meta',
    isExample: !req.body?.leadId,
    lead: {
      id: subject.id ?? null,
      name: [subject.first_name, subject.last_name].filter(Boolean).join(' '),
      email: subject.email,
      company: subject.company,
      title: subject.title,
      researched: Boolean(subject.research),
    },
    ai: aiStatus(),
    hasBusinessContext: Boolean(owner.business_context?.trim()),
  })

  let written = 0
  try {
    await previewPlaybookEmails({
      graph,
      lead: subject,
      businessContext: owner.business_context,
      senderName: mailbox?.display_name || owner.name || mailbox?.email || owner.email,
      meetingLink: owner.meeting_link,
      examples: approvedCopy(c.id, req.body?.approvedCopy),
      onPlan: (plan) => send({ type: 'plan', ...plan }),
      onSample: (sample) => { written++; send({ type: 'sample', sample }) },
    })
    logEvent(req.wsId, { campaignId: c.id, type: 'messages_previewed', detail: `${written} sample email${written === 1 ? '' : 's'}` })
    send({ type: 'done', written })
  } catch (err) {
    // The status line is long gone by now, so the failure travels in-band and
    // whatever was already written stays on screen.
    console.error('[preview] sample generation failed', err)
    send({ type: 'error', error: String(err.message || err).slice(0, 300) })
  }
  res.end()
})

// Rewrite one Send step's sample. This is the loop that makes the samples worth
// showing: read the email, change what it should do, say what you want
// different, get that one email back — without regenerating the nine around it.
//
// An edited instruction is written into the diagram before anything is composed
// and the updated source comes back in the response, so the prompt behind an
// email and the diagram that documents it can never say different things.
api.post('/campaigns/:id/preview-messages/:nodeId', async (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const nodeId = String(req.params.nodeId)

  let mermaid = req.body?.mermaid ? String(req.body.mermaid).slice(0, 20000) : c.mermaid
  const instruction = sanitizeInstruction(req.body?.instruction || '')
  if (instruction) mermaid = setSendInstruction(mermaid, nodeId, instruction)
  const graph = parsePlaybook(mermaid)
  if (!graph.valid) {
    return res.status(400).json({ error: 'Fix the playbook errors first — the samples follow the diagram', validation: { errors: graph.errors, warnings: graph.warnings } })
  }

  const subject = previewRecipient(req, res, c)
  if (!subject) return
  const mailbox = c.mailbox_id ? db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(c.mailbox_id) : null

  // The samples already on screen above this one, so the rewrite answers what
  // the reader can see rather than a thread only the server remembers.
  const priorSamples = {}
  for (const [id, s] of Object.entries(req.body?.priorSamples || {}).slice(0, 20)) {
    if (!graph.nodes[id] || !s) continue
    priorSamples[id] = { subject: String(s.subject || '').slice(0, 300), body: String(s.body || '').slice(0, 5000) }
  }
  const basedOn = req.body?.basedOn
    ? { subject: String(req.body.basedOn.subject || '').slice(0, 300), body: String(req.body.basedOn.body || '').slice(0, 5000) }
    : null

  try {
    const sample = await composeStepSample({
      graph,
      nodeId,
      lead: subject,
      businessContext: owner.business_context,
      senderName: mailbox?.display_name || owner.name || mailbox?.email || owner.email,
      meetingLink: owner.meeting_link,
      priorSamples,
      refine: String(req.body?.refine || '').slice(0, 600),
      basedOn,
    })
    logEvent(req.wsId, { campaignId: c.id, type: 'message_rewritten', detail: `step ${nodeId}` })
    res.json({ sample, mermaid, ai: aiStatus() })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err).slice(0, 300) })
  }
})

api.put('/campaigns/:id', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const { name, mermaid, mailboxId, status, approvedCopy: copy } = req.body || {}
  if (mailboxId !== undefined && mailboxId !== null) {
    const mb = db.prepare('SELECT id FROM mailboxes WHERE id = ? AND user_id = ?').get(mailboxId, req.wsId)
    if (!mb) return res.status(400).json({ error: 'Mailbox not found' })
  }
  if (status !== undefined) {
    if (!['draft', 'running', 'paused', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    // STOPPED is terminal, and it has to be terminal *here* too. This route
    // predates the parity status endpoint and wrote `status` with no guard,
    // which let a permanently-stopped campaign be set back to `running`. Worse,
    // `status_reason` stayed 'STOPPED', so the campaign was simultaneously
    // running and stopped and the parity endpoint's own guard stopped
    // recognising it. Duplicating is the way forward, as it is on that route.
    if (c.status === 'archived' && c.status_reason === 'STOPPED' && status !== 'archived') {
      return res.status(409).json({
        error: 'This campaign was stopped permanently. Duplicate it to start again.',
        code: 'CAMPAIGN_STOPPED',
      })
    }
    if (status === 'running') {
      const target = mermaid ?? c.mermaid
      const graph = parsePlaybook(target)
      if (!graph.valid) return res.status(400).json({ error: 'Fix playbook errors before launching', validation: { errors: graph.errors, warnings: graph.warnings } })
      const effectiveMailbox = mailboxId ?? c.mailbox_id
      if (!effectiveMailbox) return res.status(400).json({ error: 'Pick a sending mailbox before launching' })
      const leadCount = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(c.id).n
      if (!leadCount) return res.status(400).json({ error: 'Add at least one lead before launching' })
      logEvent(req.wsId, { campaignId: c.id, type: 'campaign_launched', detail: c.name })
    }
  }
  db.prepare('UPDATE campaigns SET name = ?, mermaid = ?, mailbox_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(name ?? c.name, mermaid ?? c.mermaid, mailboxId === undefined ? c.mailbox_id : mailboxId, status ?? c.status, c.id)

  // Copy the user tailored and signed off on, saved in the same click as the
  // diagram it belongs to — an approved email and the step it came from are one
  // edit, and half of it landing would be worse than neither.
  if (Array.isArray(copy)) {
    const upsert = db.prepare(
      `INSERT INTO node_examples (campaign_id, node_id, subject, body, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(campaign_id, node_id) DO UPDATE SET
         subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`
    )
    const drop = db.prepare('DELETE FROM node_examples WHERE campaign_id = ? AND node_id = ?')
    db.transaction(() => {
      for (const item of copy.slice(0, 50)) {
        const nodeId = String(item?.nodeId || '').slice(0, 64)
        if (!nodeId) continue
        const body = String(item?.body || '').trim().slice(0, 5000)
        if (!body) { drop.run(c.id, nodeId); continue }
        upsert.run(c.id, nodeId, String(item?.subject || '').slice(0, 300), body)
      }
    })()
  }

  const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id)
  const graph = parsePlaybook(updated.mermaid)
  res.json({ ...campaignSummary(updated), mermaid: updated.mermaid, validation: { valid: graph.valid, errors: graph.errors, warnings: graph.warnings } })
})

api.delete('/campaigns/:id', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  db.prepare("UPDATE campaigns SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(c.id)
  logEvent(req.wsId, { campaignId: c.id, type: 'campaign_archived', detail: c.name })
  res.json({ ok: true })
})

// Validate playbook text without saving (live editor feedback).
api.post('/playbook/validate', (req, res) => {
  const graph = parsePlaybook(String(req.body?.mermaid || ''))
  res.json({ valid: graph.valid, errors: graph.errors, warnings: graph.warnings, nodes: Object.keys(graph.nodes).length })
})

// Attach / detach leads.
api.post('/campaigns/:id/leads', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const leadIds = req.body?.leadIds
  if (!Array.isArray(leadIds) || !leadIds.length) return res.status(400).json({ error: 'leadIds required' })
  let added = 0
  const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)')
  for (const id of leadIds) {
    const lead = db.prepare("SELECT id FROM leads WHERE id = ? AND user_id = ? AND status = 'active'").get(id, req.wsId)
    if (lead) added += insert.run(c.id, lead.id).changes
  }
  res.json({ added })
})

api.delete('/campaigns/:id/leads/:leadId', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const info = db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').run(c.id, req.params.leadId)
  res.json({ removed: info.changes })
})

// Retry an errored/stuck lead from the start of its current node.
api.post('/campaigns/:id/leads/:leadId/retry', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(c.id, req.params.leadId)
  if (!cl) return res.status(404).json({ error: 'Lead is not in this campaign' })
  db.prepare("UPDATE campaign_leads SET state = 'waiting', error = '', updated_at = datetime('now') WHERE id = ?").run(cl.id)
  res.json({ ok: true })
})

// Sandbox helper: simulate an inbound reply for a lead.
api.post('/campaigns/:id/leads/:leadId/simulate-reply', (req, res) => {
  const c = getCampaign(req, res)
  if (!c) return
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(c.id, req.params.leadId)
  if (!cl) return res.status(404).json({ error: 'Lead is not in this campaign' })
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Reply text required' })
  try {
    simulateReply({ user: { id: req.wsId }, campaignLead: cl, text })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

// Run the engine now (manual tick — also runs on a timer).
api.post('/engine/tick', async (req, res) => {
  const result = await tick()
  res.json(result)
})

// ---- approvals --------------------------------------------------------------
// Nothing sends without a human OK. The agent composes, parks the email here,
// and waits. Approving hands it straight to the engine.

api.get('/drafts', (req, res) => {
  const owner = db.prepare('SELECT require_approval FROM users WHERE id = ?').get(req.wsId)
  res.json({ requireApproval: Boolean(owner?.require_approval), drafts: pendingDrafts(req.wsId) })
})

function getDraft(req, res) {
  const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ? AND status = 'pending'")
    .get(req.params.id, req.wsId)
  if (!draft) res.status(404).json({ error: 'That draft has already been dealt with' })
  return draft
}

// Approve (optionally with edits) and send. The engine owns the send itself,
// so an approved email follows exactly the same path as an unattended one.
api.post('/drafts/:id/approve', async (req, res) => {
  const draft = getDraft(req, res)
  if (!draft) return
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(draft.campaign_id)
  if (campaign?.status !== 'running') {
    return res.status(400).json({ error: `"${campaign?.name || 'That campaign'}" is ${campaign?.status || 'gone'} — resume it and the email will go out` })
  }
  // Suppression, before the approval is recorded.
  //
  // A draft is composed *before* anyone blocks the recipient, so the block can
  // arrive between composing and approving — and this route never checked. The
  // transport would refuse the send, but only after the queue had told someone
  // their approval was accepted. Refusing here, and dropping the draft, means
  // the queue stops offering an email that can never go.
  const draftLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(draft.lead_id)
  const suppressed = draftLead && suppressionFor(req.wsId, { address: draftLead.email, lead: draftLead })
  if (suppressed) {
    discardStaleDraft(draft)
    logEvent(req.wsId, {
      campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'send_refused',
      detail: `approval refused — ${suppressed.message}`,
    })
    return res.status(409).json({ error: suppressed.message, code: 'SUPPRESSED', reason: suppressed.reason })
  }

  const subject = req.body?.subject !== undefined ? String(req.body.subject).trim() : draft.subject
  const body = req.body?.body !== undefined ? String(req.body.body).trim() : draft.body
  if (!subject || !body) return res.status(400).json({ error: 'An email needs a subject and a body' })
  const edited = subject !== draft.subject || body !== draft.body ? 1 : 0
  db.prepare(
    "UPDATE drafts SET status = 'approved', subject = ?, body = ?, edited = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(subject, body, edited, req.user.email, draft.id)
  logEvent(req.wsId, {
    campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'approved',
    detail: `${req.user.email} approved${edited ? ' (edited)' : ''}: ${subject}`,
  })
  await tick()
  // Approving means "yes, send this" — the sending rhythm still decides the
  // minute, so say which it will be rather than letting it look stuck.
  const after = db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(campaign.mailbox_id)
  res.json({
    ok: true,
    sent: after?.status === 'sent',
    sending: sendingStatus(req.wsId, mailbox, campaign),
    remaining: pendingCount(req.wsId),
  })
})

// One click for a batch you've already read. Same code path, one at a time.
api.post('/drafts/approve-all', async (req, res) => {
  const running = db.prepare(
    `SELECT d.id FROM drafts d JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.user_id = ? AND d.status = 'pending' AND c.status = 'running' ORDER BY d.id`
  ).all(req.wsId)
  // The same suppression check as the single approve. Without it, "approve all"
  // is a way to approve exactly the emails the single button would refuse.
  let refused = 0
  for (const row of running) {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(row.id)
    const lead = d && db.prepare('SELECT * FROM leads WHERE id = ?').get(d.lead_id)
    const blocked = lead && suppressionFor(req.wsId, { address: lead.email, lead })
    if (blocked) {
      discardStaleDraft(d)
      logEvent(req.wsId, {
        campaignId: d.campaign_id, leadId: d.lead_id, type: 'send_refused',
        detail: `approve-all skipped — ${blocked.message}`,
      })
      refused++
      continue
    }
    db.prepare(
      "UPDATE drafts SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
    ).run(req.user.email, row.id)
  }
  if (running.length) logEvent(req.wsId, { type: 'approved', detail: `${req.user.email} approved ${running.length} email(s)` })
  await tick()
  const sent = db.prepare(
    "SELECT COUNT(*) n FROM drafts WHERE user_id = ? AND status = 'sent' AND reviewed_by = ? AND reviewed_at >= datetime('now', '-1 minute')"
  ).get(req.wsId, req.user.email).n
  res.json({
    approved: running.length,
    sent,
    queued: Math.max(0, running.length - sent),
    remaining: pendingCount(req.wsId),
  })
})

// "Don't send" stops this lead in this campaign. Predictable beats clever:
// declining an email means you don't want the conversation, not that you want
// the agent to try a different angle behind your back.
api.post('/drafts/:id/decline', (req, res) => {
  const draft = getDraft(req, res)
  if (!draft) return
  db.prepare("UPDATE drafts SET status = 'declined', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.user.email, draft.id)
  db.prepare(
    "UPDATE campaign_leads SET state = 'finished', outcome = 'lost', updated_at = datetime('now') WHERE campaign_id = ? AND lead_id = ?"
  ).run(draft.campaign_id, draft.lead_id)
  logEvent(req.wsId, {
    campaignId: draft.campaign_id, leadId: draft.lead_id, type: 'declined',
    detail: `${req.user.email} chose not to send — lead stopped`,
  })
  res.json({ ok: true, remaining: pendingCount(req.wsId) })
})

// ---- the signed yes ---------------------------------------------------------

// Issue (or re-issue) an agreement link for a lead and return it, so it can be
// pasted into a manual reply.
api.post('/leads/:id/agreement', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const campaign = db.prepare('SELECT campaign_id FROM campaign_leads WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id)
  const consent = ensureConsent({ owner, leadId: lead.id, campaignId: campaign?.campaign_id || null })
  res.json({
    url: consentUrl(consent.token), status: consent.status, terms: consent.terms,
    signedName: consent.signed_name, signedAt: consent.signed_at,
  })
})

api.get('/leads/:id/agreement', (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })
  const consent = consentFor(req.wsId, lead.id)
  if (!consent) return res.json(null)
  res.json({
    url: consentUrl(consent.token), status: consent.status, terms: consent.terms,
    signedName: consent.signed_name, signedAt: consent.signed_at,
  })
})

// The default wording, so Settings can show what people will actually see.
api.get('/settings/agreement-preview', (req, res) => {
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  res.json({ terms: ownerTerms(owner), custom: Boolean(owner?.consent_terms?.trim()) })
})

// ---- alerts -----------------------------------------------------------------

api.post('/settings/alert-test', async (req, res) => {
  const url = String(req.body?.webhook || db.prepare('SELECT alert_webhook FROM users WHERE id = ?').get(req.wsId)?.alert_webhook || '')
  const kind = webhookKind(url)
  if (!kind) return res.status(400).json({ error: 'Add a Slack or Teams webhook URL first' })
  try {
    await postWebhook(url, kind, {
      title: 'Harry is connected',
      text: 'This is where replies, approvals and anything that needs you will land.',
      link: '/app',
    })
    res.json({ ok: true, kind })
  } catch (err) {
    res.status(400).json({ error: `${kind === 'slack' ? 'Slack' : 'Teams'} rejected the message: ${String(err.message || err).slice(0, 200)}` })
  }
})

// ---- google sheet -----------------------------------------------------------

api.post('/sheet/create', async (req, res) => {
  try {
    res.json(await createSheet(req.wsId))
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

api.post('/sheet/sync', async (req, res) => {
  try {
    const pushed = await pushSheet(req.wsId, { force: true })
    if (!pushed) return res.status(400).json({ error: 'No sheet connected yet' })
    const owner = db.prepare('SELECT sheet_synced_at FROM users WHERE id = ?').get(req.wsId)
    res.json({ ok: true, syncedAt: owner?.sheet_synced_at || '' })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

api.delete('/sheet', (req, res) => {
  disconnectSheet(req.wsId)
  res.json({ ok: true })
})

// ---- inbox ------------------------------------------------------------------

api.get('/inbox', (req, res) => {
  const intent = String(req.query.intent || '')
  const unreadOnly = req.query.unread === '1'
  let rows = db.prepare(
    `SELECT m.*, l.first_name, l.last_name, l.company, c.name AS campaign_name
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     LEFT JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.user_id = ? AND m.direction = 'in'
     ORDER BY m.id DESC LIMIT 500`
  ).all(req.wsId)
  if (intent) rows = rows.filter((m) => (m.intent || 'unclassified') === intent)
  if (unreadOnly) rows = rows.filter((m) => !m.is_read)
  res.json(rows)
})

api.get('/inbox/thread/:threadId', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY id'
  ).all(req.wsId, req.params.threadId)
  if (!rows.length) return res.status(404).json({ error: 'Thread not found' })
  const first = rows.find((m) => m.campaign_id && m.lead_id)
  const cl = first
    ? db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(first.campaign_id, first.lead_id)
    : null
  res.json({ messages: rows, campaignLead: cl })
})

api.post('/inbox/:messageId/read', (req, res) => {
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.messageId, req.wsId)
  res.json({ ok: true })
})

// Reclassify a reply and reroute the lead through the playbook accordingly.
api.post('/inbox/:messageId/reclassify', async (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND user_id = ? AND direction = 'in'").get(req.params.messageId, req.wsId)
  if (!msg) return res.status(404).json({ error: 'Message not found' })
  const intent = String(req.body?.intent || '').trim().toLowerCase()
  if (!intent) return res.status(400).json({ error: 'intent required' })
  db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(intent, msg.id)
  const cl = msg.campaign_id && msg.lead_id
    ? db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(msg.campaign_id, msg.lead_id)
    : null
  if (cl && ['waiting', 'needs_attention'].includes(cl.state)) {
    const ctx = campaignCtx(msg.campaign_id)
    if (ctx?.graph?.valid) {
      db.prepare("UPDATE campaign_leads SET state = 'waiting' WHERE id = ?").run(cl.id)
      cl.state = 'waiting'
      await routeReply(ctx, cl, intent, null)
    }
  }
  logEvent(req.wsId, { campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'reclassified', detail: intent })
  res.json({ ok: true })
})

// Manual reply from the inbox (sent through the campaign's mailbox).
api.post('/inbox/thread/:threadId/reply', async (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY id').all(req.wsId, req.params.threadId)
  if (!rows.length) return res.status(404).json({ error: 'Thread not found' })
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Reply body required' })
  const anchor = rows.find((m) => m.campaign_id && m.lead_id) || rows[0]
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(anchor.campaign_id)
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(anchor.lead_id)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(anchor.mailbox_id)
  if (!campaign || !lead || !mailbox) return res.status(400).json({ error: 'Thread is missing campaign context' })
  const lastSubject = rows[rows.length - 1].subject || ''
  const subject = lastSubject.startsWith('Re:') ? lastSubject : `Re: ${lastSubject}`
  try {
    await sendEmail({ mailbox, user: { id: req.wsId }, campaign, lead, nodeId: 'manual', subject, body })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

api.get('/inbox/intents', (req, res) => {
  const used = db.prepare(
    "SELECT DISTINCT intent FROM messages WHERE user_id = ? AND direction = 'in' AND intent != ''"
  ).all(req.wsId).map((r) => r.intent)
  res.json([...new Set([...used, ...CORE_INTENTS])])
})

// ---- revenue goals ----------------------------------------------------------
// "Give the AI a revenue outcome" — the AI plans ICP + target + playbook, wires
// a campaign, qualifies leads with reasons, and progress is measured from wins.

function goalProgress(g) {
  const campaign = g.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(g.campaign_id) : null
  const won = g.campaign_id
    ? db.prepare("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND outcome = 'won'").get(g.campaign_id).n : 0
  const contacted = g.campaign_id
    ? db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE campaign_id = ? AND direction = 'out'").get(g.campaign_id).n : 0
  const attached = g.campaign_id
    ? db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(g.campaign_id).n : 0
  const qualified = db.prepare('SELECT COUNT(*) n FROM lead_scores WHERE goal_id = ? AND fit >= 60').get(g.id).n
  const scored = db.prepare('SELECT COUNT(*) n FROM lead_scores WHERE goal_id = ?').get(g.id).n
  if (g.status === 'active' && won >= g.target) {
    db.prepare("UPDATE goals SET status = 'achieved' WHERE id = ?").run(g.id)
    g.status = 'achieved'
    logEvent(g.user_id, { campaignId: g.campaign_id, type: 'goal_achieved', detail: g.name })
  }
  return {
    id: g.id, name: g.name, description: g.description, target: g.target, metric: g.metric,
    status: g.status, createdAt: g.created_at, icp: JSON.parse(g.icp || '{}'),
    campaignId: g.campaign_id, campaignName: campaign?.name || null, campaignStatus: campaign?.status || null,
    won, contacted, attached, qualified, scored,
  }
}

api.get('/goals', (req, res) => {
  const rows = db.prepare("SELECT * FROM goals WHERE user_id = ? AND status != 'archived' ORDER BY id DESC").all(req.wsId)
  res.json(rows.map(goalProgress))
})

api.post('/goals', async (req, res) => {
  const description = String(req.body?.description || '').trim()
  if (description.length < 10) return res.status(400).json({ error: 'Describe the outcome you want, e.g. "Generate 20 qualified meetings with Australian SaaS companies"' })
  const autopilot = Boolean(req.body?.autopilot)
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)

  const plan = await planGoal({ description, businessContext: owner.business_context })
  let mermaid = goalPlaybook(plan)
  if (!parsePlaybook(mermaid).valid) mermaid = DEFAULT_PLAYBOOK // never ship a broken plan

  const campaignInfo = db.prepare('INSERT INTO campaigns (user_id, name, mermaid) VALUES (?, ?, ?)')
    .run(req.wsId, plan.name, mermaid)
  const campaignId = campaignInfo.lastInsertRowid
  const goalInfo = db.prepare(
    'INSERT INTO goals (user_id, description, name, target, icp, campaign_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.wsId, description, plan.name, plan.target, JSON.stringify(plan.icp), campaignId)
  const goalId = goalInfo.lastInsertRowid
  logEvent(req.wsId, { campaignId, type: 'goal_created', detail: `${plan.name} (target ${plan.target}, planned via ${plan.via})` })

  const steps = [`Planned ICP and target (${plan.target}) via ${plan.via === 'ai' ? 'Claude' : 'heuristics'}`, 'Generated playbook and campaign']

  if (autopilot) {
    // Qualify every active lead, attach the fits, pick a mailbox, launch, tick.
    const leads = db.prepare("SELECT * FROM leads WHERE user_id = ? AND status = 'active'").all(req.wsId)
    let attached = 0
    for (const lead of leads) {
      const score = await qualifyLead({ lead, icp: plan.icp, businessContext: owner.business_context })
      db.prepare('INSERT OR REPLACE INTO lead_scores (goal_id, lead_id, fit, reasons) VALUES (?, ?, ?, ?)')
        .run(goalId, lead.id, score.fit, JSON.stringify(score.reasons))
      if (score.fit >= 60) {
        db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, lead.id)
        attached++
      }
    }
    steps.push(`Qualified ${leads.length} leads, attached ${attached} with fit 60 or higher`)
    const mailbox = db.prepare(
      "SELECT * FROM mailboxes WHERE user_id = ? AND status = 'connected' ORDER BY CASE provider WHEN 'gmail' THEN 0 ELSE 1 END, id LIMIT 1"
    ).get(req.wsId)
    if (mailbox && attached > 0) {
      db.prepare("UPDATE campaigns SET mailbox_id = ?, status = 'running', updated_at = datetime('now') WHERE id = ?").run(mailbox.id, campaignId)
      logEvent(req.wsId, { campaignId, type: 'campaign_launched', detail: `${plan.name} (autopilot)` })
      steps.push(`Launched from ${mailbox.email}`)
      tick().catch((err) => console.error('[goals] autopilot tick failed', err))
      steps.push(owner.require_approval
        ? 'Engine started — the first emails are being written and will wait in your Inbox for approval'
        : 'Engine started — first emails are going out')
    } else if (!mailbox) {
      steps.push('Not launched: connect a mailbox first (Mailboxes page), then launch the campaign')
    } else {
      steps.push('Not launched: no leads scored 60 or higher — review the qualification list')
    }
  }

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId)
  res.json({ ...goalProgress(goal), plannedVia: plan.via, steps })
})

// Qualify all leads (or re-qualify) against the goal's ICP.
api.post('/goals/:id/qualify', async (req, res) => {
  const g = db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!g) return res.status(404).json({ error: 'Goal not found' })
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const icp = JSON.parse(g.icp || '{}')
  const rescore = req.body?.rescore === true
  const leads = db.prepare("SELECT * FROM leads WHERE user_id = ? AND status = 'active'").all(req.wsId)
  for (const lead of leads) {
    if (!rescore && db.prepare('SELECT 1 FROM lead_scores WHERE goal_id = ? AND lead_id = ?').get(g.id, lead.id)) continue
    const score = await qualifyLead({ lead, icp, businessContext: owner.business_context })
    db.prepare('INSERT OR REPLACE INTO lead_scores (goal_id, lead_id, fit, reasons) VALUES (?, ?, ?, ?)')
      .run(g.id, lead.id, score.fit, JSON.stringify(score.reasons))
  }
  const scores = db.prepare(
    `SELECT ls.fit, ls.reasons, l.id AS lead_id, l.email, l.first_name, l.last_name, l.company, l.title,
            EXISTS(SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = ? AND cl.lead_id = l.id) AS attached
     FROM lead_scores ls JOIN leads l ON l.id = ls.lead_id
     WHERE ls.goal_id = ? ORDER BY ls.fit DESC`
  ).all(g.campaign_id, g.id)
  res.json(scores.map((s) => ({ ...s, reasons: JSON.parse(s.reasons), attached: Boolean(s.attached) })))
})

// Attach every qualified lead at/above a fit threshold to the goal's campaign.
api.post('/goals/:id/attach', (req, res) => {
  const g = db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!g?.campaign_id) return res.status(404).json({ error: 'Goal or campaign not found' })
  const minFit = Number(req.body?.minFit ?? 60)
  const rows = db.prepare('SELECT lead_id FROM lead_scores WHERE goal_id = ? AND fit >= ?').all(g.id, minFit)
  let added = 0
  const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)')
  for (const r of rows) added += insert.run(g.campaign_id, r.lead_id).changes
  res.json({ added, total: rows.length })
})

api.delete('/goals/:id', (req, res) => {
  const info = db.prepare("UPDATE goals SET status = 'archived' WHERE id = ? AND user_id = ?").run(req.params.id, req.wsId)
  if (!info.changes) return res.status(404).json({ error: 'Goal not found' })
  res.json({ ok: true })
})

// ---- lead research ----------------------------------------------------------

api.post('/leads/:id/research', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(req.params.id, req.wsId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.wsId)
  const profile = await researchLead({ lead, businessContext: owner.business_context })
  if (!profile) {
    return res.status(400).json({ error: 'Research needs the AI agent — set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env (see README)' })
  }
  db.prepare("UPDATE leads SET research = ?, researched_at = datetime('now') WHERE id = ?").run(profile, lead.id)
  logEvent(req.wsId, { leadId: lead.id, type: 'researched', detail: profile.slice(0, 120) })
  res.json({ research: profile })
})

// ---- team -------------------------------------------------------------------

api.get('/team', (req, res) => {
  const members = db.prepare('SELECT * FROM team_members WHERE owner_id = ? ORDER BY id').all(req.wsId)
  const owner = db.prepare('SELECT email, name FROM users WHERE id = ?').get(req.wsId)
  res.json({
    role: req.wsRole,
    ownerEmail: owner?.email || req.wsOwnerEmail,
    shared: req.wsId !== req.user.id,
    members: members.map((m) => ({ id: m.id, email: m.email, role: m.role, status: m.status, invitedAt: m.created_at })),
  })
})

api.post('/team/invite', (req, res) => {
  if (req.wsRole !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can invite members' })
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
  if (email === req.user.email) return res.status(400).json({ error: 'That is your own email — you already own this workspace' })
  try {
    db.prepare("INSERT INTO team_members (owner_id, email) VALUES (?, ?)").run(req.wsId, email)
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: `${email} is already invited` })
    throw err
  }
  logEvent(req.wsId, { type: 'member_invited', detail: email })
  res.json({ ok: true })
})

api.delete('/team/:id', (req, res) => {
  if (req.wsRole !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can remove members' })
  const member = db.prepare('SELECT * FROM team_members WHERE id = ? AND owner_id = ?').get(req.params.id, req.wsId)
  if (!member) return res.status(404).json({ error: 'Member not found' })
  db.prepare('DELETE FROM team_members WHERE id = ?').run(member.id)
  logEvent(req.wsId, { type: 'member_removed', detail: member.email })
  res.json({ ok: true })
})

// ---- analytics --------------------------------------------------------------

api.get('/analytics', (req, res) => {
  const uid = req.wsId
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)

  const campaigns = db.prepare("SELECT * FROM campaigns WHERE user_id = ? AND status != 'archived' ORDER BY id DESC").all(uid)
  const perCampaign = campaigns.map((c) => {
    const s = campaignSummary(c)
    const leadsTotal = Object.values(s.counts).reduce((a, b) => a + b, 0)
    const interested = db.prepare(
      "SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE campaign_id = ? AND direction = 'in' AND intent = 'interested'"
    ).get(c.id).n
    const repliedLeads = db.prepare(
      "SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE campaign_id = ? AND direction = 'in'"
    ).get(c.id).n
    const unsubscribed = db.prepare(
      "SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND outcome = 'unsubscribed'"
    ).get(c.id).n
    const contacted = db.prepare(
      "SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE campaign_id = ? AND direction = 'out'"
    ).get(c.id).n
    return {
      ...s, leadsTotal, contacted, repliedLeads, interested, unsubscribed,
      replyRate: pct(repliedLeads, contacted),
      interestedRate: pct(interested, contacted),
      winRate: pct(s.won, contacted),
      unsubscribeRate: pct(unsubscribed, contacted),
      openRate: pct(s.opens, s.sent),
      clickRate: pct(s.clicks, s.sent),
      needsAttention: s.counts.needs_attention || 0,
    }
  })

  const funnel = {
    leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(uid).n,
    contacted: db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'out'").get(uid).n,
    replied: db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'in'").get(uid).n,
    interested: db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'in' AND intent = 'interested'").get(uid).n,
    won: db.prepare(
      'SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.outcome = ?'
    ).get(uid, 'won').n,
  }

  const intents = db.prepare(
    "SELECT CASE WHEN intent = '' THEN 'unclassified' ELSE intent END AS intent, COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'in' GROUP BY 1 ORDER BY n DESC"
  ).all(uid)

  const series = db.prepare(
    `SELECT date(created_at) day,
            SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) sent,
            SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) replies
     FROM messages WHERE user_id = ? AND created_at >= date('now', '-29 days')
     GROUP BY day ORDER BY day`
  ).all(uid)

  const mailboxes = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY id').all(uid).map((m) => ({
    id: m.id, email: m.email, provider: m.provider, status: m.status,
    dailyLimit: m.daily_limit, remainingToday: remainingQuota(m),
    sentTotal: db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id = ? AND direction = 'out'").get(m.id).n,
  }))

  // Learning: attribute each inbound reply to the outbound node that preceded it,
  // then surface what the data says about which steps convert.
  const learning = []
  for (const c of campaigns) {
    const msgs = db.prepare(
      "SELECT id, lead_id, direction, node_id FROM messages WHERE campaign_id = ? ORDER BY lead_id, id"
    ).all(c.id)
    const perNode = {}
    let lastOutNode = {}
    for (const m of msgs) {
      if (m.direction === 'out' && m.node_id && m.node_id !== 'manual') {
        lastOutNode[m.lead_id] = m.node_id
        perNode[m.node_id] = perNode[m.node_id] || { sent: 0, replies: 0 }
        perNode[m.node_id].sent++
      } else if (m.direction === 'in' && lastOutNode[m.lead_id]) {
        perNode[lastOutNode[m.lead_id]].replies++
      }
    }
    for (const [nodeId, s] of Object.entries(perNode)) {
      if (s.sent >= 1) learning.push({ campaignId: c.id, campaignName: c.name, nodeId, sent: s.sent, replies: s.replies, replyRate: pct(s.replies, s.sent) })
    }
  }
  learning.sort((a, b) => b.replyRate - a.replyRate)
  const insights = []
  const meaningful = learning.filter((l) => l.sent >= 3)
  if (meaningful.length) {
    const best = meaningful[0]
    if (best.replies > 0) insights.push(`Best step: node ${best.nodeId} in "${best.campaignName}" — ${best.replyRate}% reply rate over ${best.sent} sends. Lean into its angle.`)
    const dead = meaningful.filter((l) => l.replies === 0 && l.sent >= 5)
    for (const d of dead.slice(0, 2)) insights.push(`Node ${d.nodeId} in "${d.campaignName}" has ${d.sent} sends and no replies — rewrite its instruction or cut it.`)
  }
  if (!insights.length) insights.push('Not enough sends yet for reliable learning — insights appear once steps reach a few sends each.')

  res.json({ perCampaign, funnel, intents, series, mailboxes, learning, insights })
})

// ---- dashboard --------------------------------------------------------------

api.get('/dashboard', (req, res) => {
  const uid = req.wsId
  const count = (sql, ...args) => db.prepare(sql).get(uid, ...args).n
  const stats = {
    leads: count('SELECT COUNT(*) n FROM leads WHERE user_id = ?'),
    activeCampaigns: count("SELECT COUNT(*) n FROM campaigns WHERE user_id = ? AND status = 'running'"),
    sent: count("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'out'"),
    replies: count("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'in'"),
    interested: count("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'in' AND intent = 'interested'"),
    won: db.prepare(
      "SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.outcome = 'won'"
    ).get(uid).n,
    needsAttention: db.prepare(
      "SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.state = 'needs_attention'"
    ).get(uid).n,
    unread: count("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'in' AND is_read = 0"),
    awaitingApproval: pendingCount(uid),
  }
  const sentByDay = db.prepare(
    `SELECT date(created_at) day,
            SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) sent,
            SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) replies
     FROM messages WHERE user_id = ? AND created_at >= date('now', '-13 days')
     GROUP BY day ORDER BY day`
  ).all(uid)
  const activity = db.prepare(
    `SELECT e.*, l.email AS lead_email, c.name AS campaign_name
     FROM events e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN campaigns c ON c.id = e.campaign_id
     WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 30`
  ).all(uid)
  // Action Center: every lead the engine parked for a human decision.
  const attention = db.prepare(
    `SELECT cl.id, cl.campaign_id, cl.lead_id, cl.node_id, cl.state, cl.intent, cl.error, cl.updated_at,
            l.email AS lead_email, l.first_name, l.last_name, c.name AS campaign_name
     FROM campaign_leads cl
     JOIN campaigns c ON c.id = cl.campaign_id
     JOIN leads l ON l.id = cl.lead_id
     WHERE c.user_id = ? AND cl.state IN ('needs_attention', 'error')
     ORDER BY cl.updated_at DESC LIMIT 50`
  ).all(uid)
  res.json({
    stats, sentByDay, activity, attention, ai: aiStatus(),
    engine: { lastTick: kvGet('engine_last_tick'), intervalMs: env.ENGINE_INTERVAL_MS },
  })
})

// ---- monitoring -------------------------------------------------------------
// One end-to-end view of the whole pipeline: component health checks, success
// factors with thresholds, per-hop telemetry, and an incident feed.

api.get('/monitoring', (req, res) => {
  const uid = req.wsId
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)
  const now = Date.now()

  // --- component health checks (system-wide) ---
  const checks = []
  const check = (id, name, status, detail) => checks.push({ id, name, status, detail })

  const up = process.uptime()
  check('api', 'API server', 'ok',
    `Up ${up >= 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m`} — Node ${process.version}`)

  try {
    const bytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
    check('db', 'Database', 'ok', `SQLite healthy — ${(bytes / 1048576).toFixed(1)} MB, WAL mode`)
  } catch (err) {
    check('db', 'Database', 'down', String(err.message || err))
  }

  const lastTick = kvGet('engine_last_tick')
  const lastTickMs = lastTick ? Date.parse(lastTick) : 0
  const tickAge = lastTickMs ? Math.round((now - lastTickMs) / 1000) : null
  const engineHealthy = lastTickMs && now - lastTickMs < env.ENGINE_INTERVAL_MS * 3
  check('engine', 'Playbook engine',
    engineHealthy ? 'ok' : lastTick ? 'down' : 'warn',
    engineHealthy ? `Ticking every ${env.ENGINE_INTERVAL_MS / 1000}s — last tick ${tickAge}s ago`
      : lastTick ? `Stale — last tick ${tickAge}s ago (expected every ${env.ENGINE_INTERVAL_MS / 1000}s)`
      : 'Waiting for first tick')

  const ai = aiStatus()
  const aiStats = telemetryStats('ai_call', 24)
  check('ai', 'AI agent',
    !ai.configuredKey ? 'warn' : ai.lastError ? 'warn' : 'ok',
    !ai.configuredKey ? 'Template mode — set OPENAI_API_KEY or ANTHROPIC_API_KEY for the full agent'
      : ai.lastError ? `${ai.provider === 'openai' ? 'OpenAI' : 'Claude'} (${ai.model}) — last error: ${ai.lastError.slice(0, 120)}`
      : `${ai.provider === 'openai' ? 'OpenAI' : 'Claude'} (${ai.model}) — ${aiStats.total} call(s) in 24h, ${aiStats.errors} failed`)

  check('auth', 'Authentication',
    auth0Configured() ? 'ok' : 'warn',
    auth0Configured() ? `Auth0 connected${devLoginEnabled() ? ' (dev login also enabled)' : ''}` : 'Dev login only — configure Auth0 for production sign-in')

  const mailboxRows = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY id').all(uid)
  const gmailBoxes = mailboxRows.filter((m) => m.provider === 'gmail')
  const brokenBoxes = mailboxRows.filter((m) => m.status === 'error' || m.last_error)
  const expiredTokens = gmailBoxes.filter((m) => m.token_expiry && m.token_expiry < now && !m.refresh_token)
  check('google', 'Gmail integration',
    !googleConfigured() ? 'warn' : expiredTokens.length ? 'down' : gmailBoxes.length ? 'ok' : 'warn',
    !googleConfigured() ? 'Google OAuth not configured — sandbox mailboxes only'
      : expiredTokens.length ? `${expiredTokens.length} mailbox token(s) expired with no refresh token — reconnect from Mailboxes`
      : gmailBoxes.length ? `${gmailBoxes.length} Gmail mailbox(es) connected` : 'Configured — no Gmail mailbox connected yet')

  const quotaLeft = mailboxRows.reduce((sum, m) => sum + remainingQuota(m), 0)
  check('mailboxes', 'Mailboxes',
    brokenBoxes.length ? 'down' : mailboxRows.length ? 'ok' : 'warn',
    brokenBoxes.length ? `${brokenBoxes.length} mailbox(es) reporting errors — see delivery below`
      : mailboxRows.length ? `${mailboxRows.length} connected — ${quotaLeft} send(s) left in today's quota` : 'No mailboxes connected')

  const running = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE user_id = ? AND status = 'running'").get(uid).n
  const paused = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE user_id = ? AND status = 'paused'").get(uid).n
  check('campaigns', 'Campaigns', paused ? 'warn' : 'ok',
    `${running} running${paused ? `, ${paused} paused — resume or fix from Campaigns` : ''}`)

  const stuck = db.prepare(
    `SELECT SUM(cl.state = 'error') errored, SUM(cl.state = 'needs_attention') attention
     FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ?`
  ).get(uid)
  check('pipeline', 'Lead pipeline',
    stuck.errored ? 'down' : stuck.attention ? 'warn' : 'ok',
    stuck.errored || stuck.attention
      ? `${stuck.errored || 0} errored, ${stuck.attention || 0} need attention — Action Center on the Dashboard`
      : 'All leads flowing — nothing stuck')

  // --- success factors: outcome KPIs judged against cold-outreach thresholds ---
  const m = (sql, ...args) => db.prepare(sql).get(uid, ...args).n
  const contacted = m("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'out'")
  const replied = m("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'in'")
  const interested = m("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE user_id = ? AND direction = 'in' AND intent = 'interested'")
  const sent = m("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'out'")
  const opens = m("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'out' AND opened_at != ''")
  const won = db.prepare(
    "SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.outcome = 'won'"
  ).get(uid).n
  const unsubscribed = db.prepare(
    "SELECT COUNT(*) n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.outcome = 'unsubscribed'"
  ).get(uid).n
  const bounced = m("SELECT COUNT(*) n FROM leads WHERE user_id = ? AND status = 'bounced'")

  // Grade a rate against thresholds; below minimum volume everything is 'pending'.
  const enough = contacted >= 10
  const grade = (value, good, warn, invert = false) => {
    if (!enough) return 'pending'
    if (invert) return value <= good ? 'good' : value <= warn ? 'warn' : 'bad'
    return value >= good ? 'good' : value >= warn ? 'warn' : 'bad'
  }
  const successFactors = [
    { key: 'replyRate', label: 'Reply rate', value: pct(replied, contacted), unit: '%', target: '5% or more',
      status: grade(pct(replied, contacted), 5, 2), hint: `${replied} of ${contacted} contacted leads replied` },
    { key: 'interestedRate', label: 'Interested rate', value: pct(interested, contacted), unit: '%', target: '2% or more',
      status: grade(pct(interested, contacted), 2, 1), hint: `${interested} lead(s) classified interested` },
    { key: 'winRate', label: 'Win rate', value: pct(won, contacted), unit: '%', target: '1% or more',
      status: grade(pct(won, contacted), 1, 0.5), hint: `${won} won of ${contacted} contacted` },
    { key: 'openRate', label: 'Open rate', value: pct(opens, sent), unit: '%', target: '40% or more',
      status: !enough || opens === 0 ? 'pending' : grade(pct(opens, sent), 40, 25),
      hint: opens === 0 ? 'Needs Gmail sends with open tracking' : `${opens} of ${sent} sends opened` },
    { key: 'unsubRate', label: 'Unsubscribe rate', value: pct(unsubscribed, contacted), unit: '%', target: '2% or less',
      status: grade(pct(unsubscribed, contacted), 2, 5, true), hint: `${unsubscribed} unsubscribed` },
    { key: 'bounceRate', label: 'Bounce rate', value: pct(bounced, contacted), unit: '%', target: '2% or less',
      status: grade(pct(bounced, contacted), 2, 5, true), hint: `${bounced} lead(s) marked bounced` },
  ]

  // Volume trend: this 7 days vs the 7 before.
  const win = (dir, from, to) => db.prepare(
    `SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = ? AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)`
  ).get(uid, dir, from, to).n
  const volume = {
    sent7: win('out', '-7 days', '+1 day'), sentPrev7: win('out', '-14 days', '-7 days'),
    replies7: win('in', '-7 days', '+1 day'), repliesPrev7: win('in', '-14 days', '-7 days'),
  }

  const goals = db.prepare("SELECT * FROM goals WHERE user_id = ? AND status = 'active' ORDER BY id DESC").all(uid)
    .map((g) => {
      const gwon = g.campaign_id
        ? db.prepare("SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND outcome = 'won'").get(g.campaign_id).n : 0
      return { id: g.id, name: g.name, target: g.target, won: gwon, pct: Math.min(100, pct(gwon, g.target)) }
    })

  // --- incident feed: engine events + failed telemetry, newest first ---
  const eventIncidents = db.prepare(
    `SELECT e.type, e.detail, e.created_at, l.email AS lead_email, c.name AS campaign_name
     FROM events e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN campaigns c ON c.id = e.campaign_id
     WHERE e.user_id = ? AND e.type IN ('error', 'needs_attention', 'campaign_paused')
     ORDER BY e.id DESC LIMIT 30`
  ).all(uid).map((e) => ({
    at: e.created_at, source: e.type === 'campaign_paused' ? 'campaign' : 'lead',
    label: e.type.replace('_', ' '),
    detail: [e.campaign_name, e.lead_email, e.detail].filter(Boolean).join(' — '),
  }))
  const telemetryIncidents = telemetryFailures(30).map((t) => ({
    at: t.created_at, source: t.kind, label: `${t.kind === 'ai_call' ? 'AI call' : t.kind === 'send' ? 'send' : t.kind.replace('_', ' ')} failed`,
    detail: [t.op, t.detail].filter(Boolean).join(' — '),
  }))
  const incidents = [...eventIncidents, ...telemetryIncidents]
    .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30)

  const status = checks.some((c) => c.status === 'down') ? 'issues'
    : checks.some((c) => c.status === 'warn') ? 'degraded' : 'operational'

  res.json({
    status,
    generatedAt: new Date().toISOString(),
    checks,
    successFactors,
    volume,
    goals,
    engine: {
      lastTick, intervalMs: env.ENGINE_INTERVAL_MS, healthy: Boolean(engineHealthy),
      ticks: telemetryRecent('tick', 40), stats24: telemetryStats('tick', 24),
    },
    ai: { ...ai, stats24: aiStats, recent: telemetryRecent('ai_call', 20) },
    // The parity modules have been writing telemetry under kind 'parity' and
    // 'provider' since they shipped, and nothing read either — so several specs'
    // "visible on the Monitoring page" definitions of done were unmet while the
    // data sat in the table. Surfaced here rather than by rewriting ~30 meter()
    // call sites to pretend to be engine ticks.
    api: {
      stats24: telemetryStats('parity', 24),
      recent: telemetryRecent('parity', 20),
      errors24: telemetryStats('api_error', 24),
      recentErrors: telemetryRecent('api_error', 20),
    },
    providers: {
      stats24: telemetryStats('provider', 24),
      recent: telemetryRecent('provider', 20),
      upkeep24: telemetryStats('upkeep', 24),
      recentUpkeep: telemetryRecent('upkeep', 20),
    },
    delivery: {
      sends24: telemetryStats('send', 24),
      syncs24: telemetryStats('inbound_sync', 24),
      mailboxes: mailboxRows.map((mb) => ({
        id: mb.id, email: mb.email, provider: mb.provider, status: mb.status,
        lastError: mb.last_error, lastSyncAt: mb.last_sync_at,
        remainingToday: remainingQuota(mb), dailyLimit: mb.daily_limit,
      })),
    },
    incidents,
  })
})

// ---- SmartLead parity -------------------------------------------------------
// The 210-endpoint backlog in Docs/README.md, one module per category. Mounted
// last so a literal route defined above always wins over a parity module's
// parameterised one.
registerSendControls(api)
registerParity(api)
