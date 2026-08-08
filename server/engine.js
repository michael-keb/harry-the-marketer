// The playbook engine. Each tick advances every lead of every running campaign
// through its Mermaid playbook graph: sending emails at Send nodes, waiting on
// replies/timeouts at branch points, classifying replies with the AI agent,
// and following the matching edge.
import { db, logEvent, touch, kvSet } from './db.js'
import { parsePlaybook, nodeIntents } from './playbook.js'
import { composeEmail, classifyReply, researchLead } from './ai.js'
import { sendEmail, syncInbound } from './mailer.js'
import { nextGapMs, sendWindow, followUpJitter } from './pacing.js'
import { resolveSend, sendingContext, brakeReason } from './gates.js'
import { placeHold } from './holds.js'
import { recordTelemetry } from './telemetry.js'
import { approvalRequired, openDraft, createDraft, markDraftSent, discardStaleDraft } from './drafts.js'
import { ensureConsent, consentUrl } from './consent.js'
import { notify } from './alerts.js'
import { runUpkeep } from './upkeep.js'
import { syncSheetsQuietly } from './sheets.js'
import { env } from './env.js'

const MAX_HOPS_PER_TICK = 10

const nowMs = () => Date.now()
const parseDbTime = (text) => (text ? Date.parse(text.replace(' ', 'T') + 'Z') : 0)

function setLead(cl, fields) {
  const cols = Object.keys(fields)
  db.prepare(`UPDATE campaign_leads SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), cl.id)
  Object.assign(cl, fields)
}

function lastOutbound(cl) {
  return db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1"
  ).get(cl.campaign_id, cl.lead_id)
}

function threadMessages(cl) {
  return db.prepare('SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? ORDER BY id').all(cl.campaign_id, cl.lead_id)
}

// Smart follow-up timing.
//
// The playbook says "no reply 3d". That is the author's intent, not a law of
// physics — someone who opened the email twice is warmer than someone who never
// saw it, and someone on annual leave is neither. So the wait is stretched or
// shortened by what actually happened, within a factor of two either way, and
// the reason is written into the activity trail so the change is never a
// mystery. Nothing to configure: the signals are already being collected.
const TIMING_FLOOR = 0.5
const TIMING_CEILING = 2

export function followUpTiming({ lastOutbound, intent, openTrackingWorks }) {
  if (intent === 'out of office') return { factor: TIMING_CEILING, reason: 'out of office — leaving it longer' }
  if (intent === 'not now') return { factor: 1.5, reason: 'they said not now — giving them more room' }
  if (lastOutbound?.clicked_at) return { factor: TIMING_FLOOR, reason: 'they clicked a link — following up sooner' }
  if (lastOutbound?.opened_at) return { factor: 0.65, reason: 'they opened it but did not reply — nudging sooner' }
  // Only trust "never opened" where open tracking has demonstrably worked;
  // otherwise every sandbox and every image-blocking inbox looks the same.
  if (openTrackingWorks) return { factor: 1.4, reason: 'no sign they have seen it — giving it longer' }
  return { factor: 1, reason: '' }
}

// Has open tracking ever produced a signal on this campaign? If not, its
// absence tells us nothing.
function openTrackingWorks(campaignId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM messages WHERE campaign_id = ? AND direction = 'out' AND opened_at != '' LIMIT 1"
  ).get(campaignId))
}

// Which gate each campaign is currently held behind.
//
// The engine asks every twenty seconds. Writing that answer to the activity
// trail each time would be four thousand rows a day all saying "outside your
// sending hours", and the one line anybody wants — the moment it changed —
// would be buried in them. So only transitions are recorded. Held in memory
// deliberately: after a restart the current hold is announced once more, which
// is worth a duplicate row.
const gateState = new Map()

function noteGate(ctx, slot) {
  const previous = gateState.get(ctx.campaign.id) || ''
  const current = slot.ok ? '' : slot.gate
  if (previous === current) return
  gateState.set(ctx.campaign.id, current)
  if (current) {
    const until = slot.until ? ` — next opening ${new Date(slot.until).toISOString().replace('T', ' ').slice(0, 16)}` : ''
    logEvent(ctx.user.id, { campaignId: ctx.campaign.id, type: 'send_gated', detail: `${slot.reason}${until}` })
  } else if (previous) {
    logEvent(ctx.user.id, { campaignId: ctx.campaign.id, type: 'send_resumed', detail: 'sending again' })
  }
}

function finishLead(ctx, cl, outcome, reason = '') {
  setLead(cl, { state: 'finished', outcome, error: '' })
  logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'finished', detail: `${outcome}${reason ? ` — ${reason}` : ''}` })
  if (outcome === 'unsubscribed') {
    db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = datetime('now') WHERE id = ?").run(cl.lead_id)
  }
}

// Move a lead onto a node and act on it. Returns true if the lead can keep advancing this tick.
async function enterNode(ctx, cl, nodeId) {
  const node = ctx.graph.nodes[nodeId]
  if (!node) {
    setLead(cl, { state: 'error', error: `Node "${nodeId}" no longer exists in the playbook` })
    logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'error', detail: `unknown node ${nodeId}` })
    return false
  }
  setLead(cl, { node_id: nodeId })
  const out = ctx.graph.edges.filter((e) => e.from === nodeId)

  switch (node.type) {
    case 'start': {
      const next = out.find((e) => e.cond.kind === 'always')
      if (!next) { finishLead(ctx, cl, 'completed', 'start node has no outgoing edge'); return false }
      return enterNode(ctx, cl, next.to)
    }
    case 'terminal':
      finishLead(ctx, cl, node.outcome)
      return false
    case 'wait': {
      const until = new Date(nowMs() + node.ms).toISOString()
      setLead(cl, { state: 'waiting', wait_until: until })
      return false
    }
    case 'decision':
      setLead(cl, { state: 'waiting', wait_until: '' })
      return false
    case 'send': {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
      if (!lead || lead.status !== 'active') {
        finishLead(ctx, cl, lead?.status === 'unsubscribed' ? 'unsubscribed' : 'completed', 'lead not active')
        return false
      }
      // The standing rule: nothing sends without a human OK. A pending draft
      // means the agent has already done its work and is waiting on you.
      // An existing draft is always used, even if approvals were switched off
      // since — otherwise turning the gate off would strand it in the queue and
      // send a second, different email in its place.
      const gated = approvalRequired(ctx.user)
      let draft = openDraft(cl.campaign_id, cl.lead_id)
      if (draft && draft.node_id !== nodeId) {
        discardStaleDraft(draft) // the lead was rerouted while this one queued
        draft = null
      }
      if (gated && draft?.status === 'pending') {
        setLead(cl, { state: 'active' }) // re-checked every tick until reviewed
        return false
      }

      let subject = draft?.subject
      let body = draft?.body
      if (!draft) {
        // Research agent: build a knowledge profile before the first email (AI only;
        // failures fall through silently — the templates still work without it).
        if (!lead.research && !threadMessages(cl).length) {
          const profile = await researchLead({ lead, businessContext: ctx.user.business_context })
          if (profile) {
            db.prepare("UPDATE leads SET research = ?, researched_at = datetime('now') WHERE id = ?").run(profile, lead.id)
            lead.research = profile
            logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: lead.id, type: 'researched', detail: profile.slice(0, 120) })
          }
        }
        // Once they've said yes, every following email carries the agreement
        // link so the "yes" ends up on the record without anyone chasing it.
        let consentLink = ''
        if (cl.intent === 'interested') {
          const consent = ensureConsent({ owner: ctx.user, leadId: lead.id, campaignId: cl.campaign_id })
          if (consent.status === 'sent') consentLink = consentUrl(consent.token)
        }
        // Copy the user read, tailored and approved for this step in the sample
        // editor. It is a model, not a template: each lead still gets their own
        // email, written to say what the approved one says.
        const approved = db.prepare(
          'SELECT subject, body FROM node_examples WHERE campaign_id = ? AND node_id = ?'
        ).get(cl.campaign_id, nodeId)
        const composed = await composeEmail({
          instruction: node.instruction || node.label,
          lead,
          businessContext: ctx.user.business_context,
          thread: threadMessages(cl),
          senderName: ctx.mailbox.display_name || ctx.user.name || ctx.mailbox.email,
          meetingLink: ctx.user.meeting_link,
          consentLink,
          example: approved || null,
        })
        subject = composed.subject
        body = composed.body

        if (gated) {
          createDraft({
            userId: ctx.user.id, campaignId: cl.campaign_id, leadId: cl.lead_id,
            nodeId, subject, body,
          })
          notify(ctx.user.id, {
            title: 'An email is waiting for your OK',
            text: `To ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email}${lead.company ? ` at ${lead.company}` : ''} — "${subject}"`,
            link: '/app/inbox',
          })
          setLead(cl, { state: 'active' })
          return false
        }
      }

      // The rhythm applies to the send, not to the writing: drafts arrive in a
      // batch you can review in one sitting, and then go out spaced across your
      // working hours. Approving an email means "yes, send this" — not "send
      // this instant" — and the queue tells you when it will actually leave.
      const slot = resolveSend({
        owner: ctx.user, campaign: ctx.campaign, mailbox: ctx.mailbox, lead,
        draft: draft && draft.status === 'approved' ? draft : null,
        rules: ctx.rules, holds: ctx.holds,
      })
      if (!slot.ok) {
        // Two gates are not a wait — they are a decision that has gone off, and
        // leaving the email queued behind them would mean it eventually goes
        // out anyway, which is the opposite of what either gate is for.
        if (slot.gate === 'stale_approval' && draft) {
          db.prepare("UPDATE drafts SET status = 'pending', reviewed_by = '', reviewed_at = '' WHERE id = ?").run(draft.id)
          logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'approval_expired', detail: slot.reason })
          notify(ctx.user.id, {
            title: 'An approval went stale',
            text: `The email for ${lead.email} has been waiting a while — have another look before it goes.`,
            link: '/app/inbox',
          })
        } else if (slot.gate === 'replied_since_approval' && draft) {
          discardStaleDraft(draft)
        }
        noteGate(ctx, slot)
        setLead(cl, { state: 'active' }) // re-checked every tick until the gate opens
        return false
      }
      noteGate(ctx, slot)
      let threadId
      try {
        ({ threadId } = await sendEmail({
          mailbox: ctx.mailbox, user: ctx.user, campaign: ctx.campaign, lead,
          nodeId, subject, body,
        }))
      } catch (err) {
        // Suppression is a refusal, not a failure: retrying next tick cannot
        // help, because an unsubscribe does not expire. The lead is finished
        // here rather than left to be re-attempted every twenty seconds, and
        // any draft still waiting for a human is withdrawn — approving an email
        // for someone who has opted out must not be possible.
        if (err?.suppressed) {
          if (draft) discardStaleDraft(cl.campaign_id, cl.lead_id)
          logEvent(ctx.user.id, {
            campaignId: cl.campaign_id, leadId: cl.lead_id,
            type: 'suppressed', detail: err.message,
          })
          finishLead(ctx, cl, err.reason === 'unsubscribed' ? 'unsubscribed' : 'stopped', err.message)
          return false
        }
        throw err
      }
      if (draft) markDraftSent(draft.id)
      if (!cl.thread_id) setLead(cl, { thread_id: threadId })
      // Close this mailbox's slot for a randomised gap so the next email in the
      // batch does not follow a second behind. Recorded for every provider —
      // canSendNow decides who has to honour it — so the sandbox exercises the
      // same code path a real mailbox does.
      // Re-read first: the send just moved sent_today, which sets both the gap
      // and whether the next lead in this same tick may go at all.
      ctx.mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ctx.mailbox.id)
      const gapUntil = Date.now() + nextGapMs(sendWindow(ctx.user), ctx.mailbox)
      db.prepare('UPDATE mailboxes SET next_send_at = ? WHERE id = ?').run(gapUntil, ctx.mailbox.id)
      ctx.mailbox.next_send_at = gapUntil

      if (out.length === 0) { finishLead(ctx, cl, 'completed', 'no next step after send'); return false }
      const always = out.find((e) => e.cond.kind === 'always')
      if (always && out.length === 1) return enterNode(ctx, cl, always.to)
      setLead(cl, { state: 'waiting', wait_until: '' })
      return false
    }
    default:
      setLead(cl, { state: 'error', error: `Unsupported node type ${node.type}` })
      return false
  }
}

// Follow a reply edge from the node the lead is waiting at. Exported for manual routing from the inbox.
export async function routeReply(ctx, cl, intent, message) {
  const out = ctx.graph.edges.filter((e) => e.from === cl.node_id)
  const exact = out.find((e) => e.cond.kind === 'reply' && e.cond.intent === intent)
  const catchAll = out.find((e) => e.cond.kind === 'reply' && e.cond.intent === null)
  const edge = exact || catchAll

  if (message) {
    db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(intent, message.id)
    logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'classified', detail: intent })
    const who = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
    notify(ctx.user.id, {
      title: intent === 'interested' ? 'Interested reply' : `Reply: ${intent}`,
      text: `${[who?.first_name, who?.last_name].filter(Boolean).join(' ') || who?.email || 'A lead'}${who?.company ? ` at ${who.company}` : ''} — "${String(message.body || '').slice(0, 180)}"`,
      link: '/app/inbox',
    })
  }
  setLead(cl, { intent })

  if (!edge) {
    if (intent === 'unsubscribe') { finishLead(ctx, cl, 'unsubscribed', 'no explicit unsubscribe edge'); return true }
    if (intent === 'out of office') return false // keep waiting; timeout edges still apply
    setLead(cl, { state: 'needs_attention' })
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'needs_attention',
      detail: `reply classified "${intent}" but node ${cl.node_id} has no matching edge`,
    })
    notify(ctx.user.id, {
      title: 'A lead needs you',
      text: `A reply classified "${intent}" has no matching step in "${ctx.campaign?.name || 'the playbook'}".`,
      link: '/app',
    })
    return true
  }
  logEvent(ctx.user.id, {
    campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'branched',
    detail: `${cl.node_id} --[reply: ${intent}]--> ${edge.to}`,
  })
  await enterNode(ctx, cl, edge.to)
  return true
}

async function processWaiting(ctx, cl) {
  const node = ctx.graph.nodes[cl.node_id]
  if (!node) return enterNode(ctx, cl, cl.node_id) // triggers the unknown-node error path

  // Wait nodes: purely time-based.
  if (node.type === 'wait') {
    if (cl.wait_until && Date.parse(cl.wait_until) <= nowMs()) {
      const next = ctx.graph.edges.find((e) => e.from === cl.node_id && e.cond.kind === 'always')
      if (!next) { finishLead(ctx, cl, 'completed', 'wait node has no outgoing edge'); return }
      logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'branched', detail: `${cl.node_id} --[wait done]--> ${next.to}` })
      await enterNode(ctx, cl, next.to)
    }
    return
  }

  // 1. Pull new inbound mail for this thread (gmail; sandbox inserts directly).
  try {
    await syncInbound({ mailbox: ctx.mailbox, user: ctx.user, campaign: ctx.campaign, lead: { id: cl.lead_id }, threadId: cl.thread_id })
  } catch (err) {
    console.warn('[engine] inbound sync failed:', err.message)
  }

  // 2. Unprocessed inbound reply? Classify and branch.
  const unprocessed = db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'in' AND intent = '' ORDER BY id DESC LIMIT 1"
  ).get(cl.campaign_id, cl.lead_id)
  if (unprocessed) {
    const intents = nodeIntents(ctx.graph, cl.node_id)
    const { intent } = await classifyReply({
      intents,
      replyText: unprocessed.body,
      thread: threadMessages(cl).filter((m) => m.id !== unprocessed.id),
      businessContext: ctx.user.business_context,
    })
    await routeReply(ctx, cl, intent, unprocessed)
    return
  }

  // 3. Timeout edges (no reply Xd / after Xd) measured from the last outbound
  //    email, with "no reply" waits tuned by how this lead has actually behaved.
  const timeoutEdges = ctx.graph.edges
    .filter((e) => e.from === cl.node_id && (e.cond.kind === 'no_reply' || e.cond.kind === 'after'))
    .sort((a, b) => a.cond.ms - b.cond.ms)
  if (timeoutEdges.length) {
    const outbound = lastOutbound(cl)
    const since = parseDbTime(outbound?.created_at)
    const timing = followUpTiming({
      lastOutbound: outbound,
      intent: cl.intent,
      openTrackingWorks: openTrackingWorks(cl.campaign_id),
    })
    // A fixed "after Xd" wait is a schedule the author chose; only "no reply"
    // follow-ups are adaptive — and they carry a per-lead offset so a hundred
    // leads do not all get chased at the same minute three days later.
    const jitter = followUpJitter(cl.lead_id, cl.node_id)
    const waitFor = (edge) =>
      edge.cond.kind === 'no_reply' ? Math.round(edge.cond.ms * timing.factor * jitter) : edge.cond.ms
    const due = timeoutEdges.find((e) => since && since + waitFor(e) <= nowMs())
    if (due) {
      const tuned = due.cond.kind === 'no_reply' && timing.reason ? ` (${timing.reason})` : ''
      logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'branched', detail: `${cl.node_id} --[${due.label}]--> ${due.to}${tuned}` })
      await enterNode(ctx, cl, due.to)
    }
  }
}

export async function processCampaign(campaign) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(campaign.user_id)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(campaign.mailbox_id)
  if (!mailbox) {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id)
    logEvent(user.id, { campaignId: campaign.id, type: 'campaign_paused', detail: 'mailbox missing — reconnect and resume' })
    return
  }
  const graph = parsePlaybook(campaign.mermaid)
  if (!graph.valid) {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id)
    logEvent(user.id, { campaignId: campaign.id, type: 'campaign_paused', detail: `playbook invalid: ${graph.errors[0]?.message || ''}` })
    return
  }
  // The rules merge reads three rows and the hold sweep writes one statement.
  // Doing either once per lead would make the send controls the most expensive
  // thing in the tick, so they are resolved once here and passed down.
  const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })
  const ctx = { user, mailbox, campaign, graph, rules, holds }

  // The brake. Bounces are the signal a mailbox is burning, and the damage is
  // to the domain rather than to this campaign — so the hold goes on the
  // mailbox, and every plan sending from it stops together.
  // Only worth asking if this mailbox is not already stopped — and the alert
  // fires once, when the hold goes on, not every twenty seconds for as long as
  // it stays on.
  const alreadyHeld = holds.some((h) => h.scope === 'mailbox' && h.scope_id === mailbox.id)
  if (!alreadyHeld) {
    const brake = brakeReason(mailbox, rules)
    if (brake) {
      ctx.holds = [...holds, placeHold(user.id, { scope: 'mailbox', id: mailbox.id, reason: brake, source: 'bounce_brake' })]
      notify(user.id, { title: 'Sending stopped to protect your address', text: brake, link: '/app/mailboxes' })
    }
  }

  // `paused_at` is set by the pause routes and was read by nothing here, so a
  // paused lead carried on receiving follow-ups exactly like an unpaused one —
  // the pause changed what the UI said and nothing about what the engine did.
  // `resume_at` lets a pause expire on its own; until then the lead is skipped.
  const leads = db.prepare(
    `SELECT * FROM campaign_leads
      WHERE campaign_id = ? AND state IN ('queued','active','waiting')
        AND (COALESCE(paused_at,'') = ''
             OR (COALESCE(resume_at,'') != '' AND datetime(resume_at) <= datetime('now')))`
  ).all(campaign.id)

  for (const cl of leads) {
    try {
      let hops = 0
      if (cl.state === 'queued') {
        setLead(cl, { state: 'active' })
        await enterNode(ctx, cl, graph.startId)
      } else if (cl.state === 'active') {
        await enterNode(ctx, cl, cl.node_id || graph.startId)
      } else if (cl.state === 'waiting') {
        await processWaiting(ctx, cl)
      }
      if (++hops > MAX_HOPS_PER_TICK) break
    } catch (err) {
      console.error('[engine] lead processing failed', cl.id, err)
      setLead(cl, { state: 'error', error: String(err.message || err).slice(0, 300) })
      logEvent(user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'error', detail: String(err.message || err).slice(0, 200) })
    }
  }
  touch('campaigns', campaign.id)
}

let ticking = false
export async function tick() {
  if (ticking) return { skipped: true }
  ticking = true
  const t0 = Date.now()
  try {
    const campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all()
    for (const campaign of campaigns) await processCampaign(campaign)

    // Work that belongs to nobody's request: releasing scheduled replies,
    // firing due reminders, adjusting warm-up, pulling untracked mail. It runs
    // after the campaigns because a lead's own sequence is the point and this
    // is housekeeping — and it absorbs its own failures, so a broken job can
    // never stop a campaign from sending (server/upkeep.js).
    const upkeep = await runUpkeep()

    kvSet('engine_last_tick', new Date().toISOString())
    recordTelemetry('tick', {
      ok: true,
      ms: Date.now() - t0,
      detail: [`${campaigns.length} running campaign(s)`, ...upkeep].join('; '),
    })
    syncSheetsQuietly() // throttled internally; never blocks or fails a tick
    return { campaigns: campaigns.length, upkeep }
  } catch (err) {
    recordTelemetry('tick', { ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    throw err
  } finally {
    ticking = false
  }
}

let engineTimer = null

export function startEngine() {
  if (engineTimer) return
  engineTimer = setInterval(() => tick().catch((err) => console.error('[engine] tick failed', err)), env.ENGINE_INTERVAL_MS)
  engineTimer.unref?.()
  console.log(`[engine] running every ${env.ENGINE_INTERVAL_MS / 1000}s`)
}

// Stop ticking so a shutdown signal does not interrupt a send mid-flight.
export function stopEngine() {
  if (!engineTimer) return
  clearInterval(engineTimer)
  engineTimer = null
  console.log('[engine] stopped')
}

// Build a ctx for one campaign (used by manual routing endpoints).
export function campaignCtx(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId)
  if (!campaign) return null
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(campaign.user_id)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(campaign.mailbox_id)
  const graph = parsePlaybook(campaign.mermaid)
  // The same rules and holds the tick resolves, so a manually routed send is
  // gated by exactly what an automatic one is.
  const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })
  return { campaign, user, mailbox, graph, rules, holds }
}
