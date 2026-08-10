// The playbook engine. Each tick advances every lead of every running campaign
// through its Mermaid playbook graph: sending emails at Send nodes, waiting on
// replies/timeouts at branch points, classifying replies with the AI agent,
// and following the matching edge.
import { db, logEvent, touch, kvSet } from './db.js'
import { parsePlaybook, nodeIntents } from './playbook.js'
import { composeEmail, classifyReply, researchLead } from './ai.js'
import { syncInbound } from './mailer.js'
import { sendMessage, smsAccountFor, smsEligibility } from './channels/send.js'
import { composeSms } from './channels/compose.js'
import { nextGapMs, sendWindow, followUpJitter, remainingToday } from './pacing.js'
import { resolveSend, sendingContext, brakeReason } from './gates.js'
import { placeHold } from './holds.js'
import { applyScore } from './importance.js'
import { unsubscribeLead } from './suppression.js'
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
  // An outcome is a trigger too — "went quiet" is the commonest reason to hand
  // someone to a different playbook. Checked before the lead is marked
  // finished, because a handoff is not an ending.
  //
  // `moved` is excluded: it is what a handoff writes, and treating it as a
  // trigger would let two children hand a lead back and forth for ever.
  if (outcome !== 'moved' && outcome !== 'unsubscribed' && handOff(ctx, cl, outcome)) return

  // An unsubscribe reached by the engine is the same event as one reached from
  // Settings or from the footer link, so it runs the same code. It used to set
  // `leads.status` and nothing else — which meant `campaign_leads.unsubscribed_at`
  // stayed empty on this path, and that column is what server/metrics.js counts.
  // Reports and the analytics surfaces then gave different unsubscribe totals
  // for the same campaign, depending only on which path the person left by.
  //
  // Before `setLead`, so the link ends as this function intends: finished with
  // an outcome, and carrying the timestamp every surface reads.
  if (outcome === 'unsubscribed') {
    unsubscribeLead(ctx.user.id, cl.lead_id, { source: 'reply', actor: 'lead' })
  }

  setLead(cl, { state: 'finished', outcome, error: '' })
  logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'finished', detail: `${outcome}${reason ? ` — ${reason}` : ''}` })
}

// ---- subsequences ------------------------------------------------------------

// Hand a lead from a parent campaign to a child written for what just happened.
//
// A subsequence exists so that someone who goes quiet, or who suddenly gets
// interested, continues in a playbook written for that situation instead of one
// written for a cold open. Creating and linking the child already worked; this
// is the part that makes it mean anything — without it a subsequence was a
// campaign with a `parent_campaign_id` and no way for a lead to ever reach it.
//
// `event` is the thing that just happened: a classified intent, or the outcome
// the lead finished on. A child lists the events it wants in its settings.
//
// Returns true when the lead has left the parent, so callers stop working on it.
function handOff(ctx, cl, event) {
  if (!event) return false

  const children = db.prepare(
    "SELECT * FROM campaigns WHERE parent_campaign_id = ? AND user_id = ? AND COALESCE(status,'') != 'archived' ORDER BY id"
  ).all(cl.campaign_id, ctx.user.id)
  if (!children.length) return false

  const match = children.find((child) => {
    let triggers = []
    try { triggers = JSON.parse(child.settings || '{}').triggers || [] } catch { triggers = [] }
    return triggers.includes(event)
  })
  if (!match) return false

  // Unsubscribe outranks every routing rule. Moving someone who has opted out
  // into a fresh playbook is precisely how an opt-out gets lost.
  const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(cl.lead_id)
  if (!lead || lead.status !== 'active') return false

  // One person is only ever live in one playbook, so a lead already running in
  // the child is not enrolled twice.
  //
  // A pairing someone has marked done is not available to be re-enrolled either.
  // The handoff below resets a finished row to 'queued', which is a fresh start
  // in that campaign — and "no more emails from this campaign" has to outrank an
  // automatic routing rule, or completing a lead would last only until the next
  // event matched a subsequence. The parent keeps them and follows its own
  // edges, so nobody is silently dropped.
  const already = db.prepare(
    "SELECT id, state, completed_at FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?"
  ).get(match.id, cl.lead_id)
  if (already && (already.state !== 'finished' || already.completed_at)) return false

  // Readiness, checked before the lead is moved rather than after. A child with
  // no mailbox or a playbook that does not parse cannot send, and a lead left
  // sitting in it would be neither in the parent nor going anywhere — which is
  // the silent drop the spec rules out.
  const ready = match.mailbox_id
    ? db.prepare('SELECT id FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(match.mailbox_id, ctx.user.id)
    : null
  const graph = parsePlaybook(match.mermaid || '')
  if (!ready || !graph.valid) {
    setLead(cl, { state: 'needs_attention' })
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'needs_attention',
      detail: `"${event}" would hand this lead to "${match.name}", but that campaign ${!ready ? 'has no mailbox' : 'has an invalid playbook'}`,
    })
    notify(ctx.user.id, {
      title: 'A handoff is stuck',
      text: `A lead matched "${event}" but "${match.name}" is not ready to receive them.`,
      link: '/app',
    })
    return true
  }

  // Leave the parent, join the child. The parent link is finished rather than
  // deleted so the trail of where this person has been survives.
  db.prepare(
    `UPDATE campaign_leads SET state = 'finished', outcome = 'moved', wait_until = '', updated_at = datetime('now')
     WHERE id = ?`
  ).run(cl.id)
  // `queued`, which is what a lead that has never been touched looks like — the
  // engine reads it as "start this person at the top of the playbook". Anything
  // else, `waiting` included, reads as parked partway through a run that never
  // happened, and the child would never send.
  if (already) {
    db.prepare(
      "UPDATE campaign_leads SET state = 'queued', node_id = '', outcome = '', error = '', wait_until = '', updated_at = datetime('now') WHERE id = ?"
    ).run(already.id)
  } else {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, '', 'queued')")
      .run(match.id, cl.lead_id)
  }

  logEvent(ctx.user.id, {
    campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'handed_off',
    detail: `"${event}" — moved to "${match.name}" (#${match.id})`,
  })
  logEvent(ctx.user.id, {
    campaignId: match.id, leadId: cl.lead_id, type: 'handed_in',
    detail: `arrived from "${ctx.campaign?.name || `#${cl.campaign_id}`}" on "${event}"`,
  })
  return true
}

// A subsequence that ends when they answer the old thread.
//
// The move dialog offers "Stop if they reply to the current campaign", and says
// underneath it that a reply on the old thread halts the subsequence rather than
// talking over it. That promise had no keeper: the flag was written to
// `campaigns.stop_on_source_reply` — a campaign-wide column — and nothing in
// this file ever read it. The checkbox was decoration on a feature that did not
// exist, which is the same shape as every other bug this codebase has found:
// stored, echoed back, never acted on.
//
// Three things about how it is done here are deliberate.
//
// **Why a sweep rather than the reply path.** The obvious place is where an
// inbound reply is classified, but that code never runs for this case: the move
// closes the source pairing (`state = 'stopped'`, `outcome = 'moved'`), and the
// tick only selects `queued`/`active`/`waiting` rows. So a reply landing on the
// source campaign after a move is seen by nobody. The sweep asks the question
// from the other end — of the child pairing, which *is* live — so it holds
// whatever state the source pairing was left in.
//
// **What counts as "a reply on the old thread".** Only one that arrived after
// the move, which is what `moved_after_message_id` records. The reply the
// triager was reading when they pressed the button is on that same thread, and
// counting it would stop every flagged subsequence on the tick after it started.
//
// **What "stop" means.** Not a deleted row and not `finished`. The pairing is
// left in `stopped` with the outcome `stopped_on_source_reply`, keeping its
// `node_id`, so the lead is visibly halted at the step they had reached, the
// reason is on the row rather than only in a log line, and a person who
// disagrees can put them back — the row, the thread and the trail are all still
// there to put back. Any email already composed and waiting for a human is
// withdrawn in the same pass, because an approval queue that can still send for
// a stopped subsequence is the same broken promise one screen later.
//
// Runs before the campaign's leads are advanced, so the stop lands in the tick
// that notices the reply rather than one email later.
function stopSubsequencesOnSourceReply(ctx) {
  const flagged = db.prepare(
    `SELECT * FROM campaign_leads
      WHERE campaign_id = ? AND stop_on_source_reply = 1
        AND moved_from_campaign_id IS NOT NULL
        AND state NOT IN ('finished', 'stopped')`
  ).all(ctx.campaign.id)

  for (const cl of flagged) {
    const reply = db.prepare(
      `SELECT * FROM messages
        WHERE campaign_id = ? AND lead_id = ? AND direction = 'in' AND id > ?
        ORDER BY id LIMIT 1`
    ).get(cl.moved_from_campaign_id, cl.lead_id, cl.moved_after_message_id || 0)
    if (!reply) continue

    const source = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(cl.moved_from_campaign_id)
    const sourceName = source?.name || `#${cl.moved_from_campaign_id}`

    setLead(cl, { state: 'stopped', outcome: 'stopped_on_source_reply', wait_until: '', error: '' })

    const draft = openDraft(cl.campaign_id, cl.lead_id)
    if (draft) discardStaleDraft(draft)

    // Named on both campaigns, because both trails are read for different
    // reasons: the subsequence's says why this lead stopped, the source's says
    // that this reply did more than arrive.
    const detail = `a reply on "${sourceName}" (message #${reply.id}) stopped "${ctx.campaign.name}"` +
      `${reply.body ? ` — "${String(reply.body).slice(0, 120)}"` : ''}`
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'subsequence_stopped', detail,
    })
    logEvent(ctx.user.id, {
      campaignId: cl.moved_from_campaign_id, leadId: cl.lead_id, type: 'subsequence_stopped', detail,
    })
  }
}

// Which mailbox sends to this lead.
//
// A campaign has one mailbox, but a lead may be pinned to another — the case
// the pin exists for is a prospect who already knows a colleague and should
// hear from that colleague's address rather than a stranger's. The pin lived in
// `campaign_leads.mailbox_id` and had no reader anywhere: the engine went
// straight to `campaign.mailbox_id`, so a lead pinned to mailbox 2 was sent
// from mailbox 1 and the setting was decoration.
//
// The pin has to survive contact with reality, so three things are checked
// before it is honoured:
//
//   * the mailbox still exists and belongs to this workspace — a pin is a
//     foreign key a user can outlive by deleting the account;
//   * it is attached to the campaign, either as the campaign's own mailbox or
//     through the `campaign_mailboxes` pool. Sending from an unattached account
//     is the one outcome the spec rules out outright;
//   * where it fails either test the pin is cleared rather than ignored, and
//     the clearing is logged. A pin that silently does nothing is worse than no
//     pin, because the lead's row goes on claiming a sender it will never use.
//
// Which of the campaign's mailboxes sends this email.
//
// `add-email-accounts.md` states the point of attaching several: "attaching more
// mailboxes raises total volume, never per-mailbox volume." That is rotation,
// and it did not exist. `campaign_mailboxes` had exactly one reader in the whole
// server — the pin validation above — so attaching five mailboxes to a campaign
// changed nothing at all: everything went from `campaigns.mailbox_id` until that
// single mailbox hit its cap, and the per-mailbox capacity figures the campaign
// page showed described a spread that was never happening.
//
// Two rules decide it, in this order.
//
// First, a conversation keeps its sender. Once someone has been emailed from an
// address, every later email in that thread comes from the same one — switching
// mid-thread breaks threading in the recipient's client and reads as a different
// person picking up the conversation. This is the same reason the per-lead pin
// warns before changing sender on an open thread.
//
// Second, for a lead nobody has written to yet, pick the mailbox with the most
// room left today. Choosing by remaining capacity rather than round-robin is
// what makes the caps compose: each mailbox keeps its own daily limit and its
// own warm-up ramp, and the pool drains evenly instead of one address being
// exhausted before the next is touched. Ties break towards whichever is free to
// send soonest, so a mailbox mid-gap does not hold the campaign up.
function rotatedMailbox(ctx, cl) {
  const previous = db.prepare(
    `SELECT mailbox_id FROM messages
      WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' AND mailbox_id IS NOT NULL
      ORDER BY id LIMIT 1`
  ).get(cl.campaign_id, cl.lead_id)
  if (previous?.mailbox_id) {
    const held = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(previous.mailbox_id, ctx.campaign.user_id)
    // Only if it can still send. A deleted or disconnected mailbox is a reason
    // to move the conversation, not a reason to stop it.
    if (held && held.status === 'connected' && !held.is_suspended) return held
  }

  const pool = db.prepare(
    `SELECT m.* FROM mailboxes m
      WHERE m.user_id = ? AND m.deleted_at IS NULL
        AND (m.id = ? OR m.id IN (SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?))
        AND m.status = 'connected' AND COALESCE(m.is_suspended, 0) = 0
      ORDER BY m.id`
  ).all(ctx.campaign.user_id, ctx.campaign.mailbox_id, ctx.campaign.id)
  if (pool.length <= 1) return pool[0] || ctx.mailbox

  const now = Date.now()
  let best = null
  let bestRoom = -1
  for (const mailbox of pool) {
    const room = remainingToday(mailbox, now)
    if (room > bestRoom || (room === bestRoom && best && (mailbox.next_send_at || 0) < (best.next_send_at || 0))) {
      best = mailbox
      bestRoom = room
    }
  }
  // Everything is spent: hand back the campaign's own mailbox so the gate
  // refuses with a reason about capacity rather than the tick failing on a null.
  return bestRoom > 0 ? best : ctx.mailbox
}

// Returns a mailbox in every case, so callers never have to handle a null.
function mailboxFor(ctx, cl) {
  if (!cl.mailbox_id || cl.mailbox_id === ctx.campaign.mailbox_id) return rotatedMailbox(ctx, cl)

  const pinned = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cl.mailbox_id, ctx.campaign.user_id)

  const attached = pinned && (
    pinned.id === ctx.campaign.mailbox_id ||
    db.prepare('SELECT 1 FROM campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?')
      .get(ctx.campaign.id, pinned.id)
  )

  if (!attached) {
    db.prepare('UPDATE campaign_leads SET mailbox_id = NULL WHERE id = ?').run(cl.id)
    cl.mailbox_id = null
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id,
      leadId: cl.lead_id,
      type: 'sender_unpinned',
      detail: pinned
        ? `mailbox ${pinned.email} is no longer attached to this campaign — back to the campaign sender`
        : 'the pinned mailbox no longer exists — back to the campaign sender',
    })
    return ctx.mailbox
  }
  return pinned
}

// SMS send step — same approval + gate shape as email, different transport.
async function sendSmsNode(ctx, cl, node, nodeId, out) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
  if (!lead || lead.status !== 'active') {
    finishLead(ctx, cl, lead?.status === 'unsubscribed' ? 'unsubscribed' : 'completed', 'lead not active')
    return false
  }

  const account = smsAccountFor(ctx.campaign)
  if (!account) {
    setLead(cl, { state: 'error', error: 'No SMS channel account — connect Twilio under Settings → Connections' })
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'error',
      detail: 'sms step with no channel account',
    })
    return false
  }

  const eligible = smsEligibility(ctx.user.id, lead)
  if (!eligible.ok) {
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'suppressed', detail: eligible.message,
    })
    finishLead(ctx, cl, eligible.reason === 'opted_out' || eligible.reason === 'unsubscribed' ? 'unsubscribed' : 'stopped', eligible.message)
    return false
  }

  const gated = approvalRequired(ctx.user)
  let draft = openDraft(cl.campaign_id, cl.lead_id)
  if (draft && draft.node_id !== nodeId) {
    discardStaleDraft(draft)
    draft = null
  }
  if (gated && draft?.status === 'pending') {
    setLead(cl, { state: 'active' })
    return false
  }

  let body = draft?.body
  if (!draft) {
    const approved = db.prepare(
      'SELECT subject, body FROM node_examples WHERE campaign_id = ? AND node_id = ?'
    ).get(cl.campaign_id, nodeId)
    const composed = await composeSms({
      instruction: node.instruction || node.label,
      lead,
      businessContext: ctx.user.business_context,
      senderName: account.display_name || ctx.user.name || account.phone_number,
      meetingLink: ctx.user.meeting_link,
      example: approved || null,
    })
    body = composed.body
    if (gated) {
      createDraft({
        userId: ctx.user.id, campaignId: cl.campaign_id, leadId: cl.lead_id,
        nodeId, subject: 'SMS', body,
      })
      notify(ctx.user.id, {
        title: 'An SMS is waiting for your OK',
        text: `To ${lead.phone || lead.email} — "${String(body).slice(0, 80)}"`,
        link: '/app/inbox',
      })
      setLead(cl, { state: 'active' })
      return false
    }
  }

  // One-channel-per-day and workspace rhythm still apply; mailbox pacing uses
  // the campaign mailbox as the schedule anchor (SMS account has its own daily cap).
  const slot = resolveSend({
    owner: ctx.user, campaign: ctx.campaign, mailbox: ctx.mailbox, lead,
    draft: draft && draft.status === 'approved' ? draft : null,
    rules: ctx.rules, holds: ctx.holds,
    channel: 'sms',
  })
  if (!slot.ok) {
    if (slot.gate === 'stale_approval' && draft) {
      db.prepare("UPDATE drafts SET status = 'pending', reviewed_by = '', reviewed_at = '' WHERE id = ?").run(draft.id)
    } else if (slot.gate === 'replied_since_approval' && draft) {
      discardStaleDraft(draft)
    }
    noteGate(ctx, slot)
    setLead(cl, { state: 'active' })
    return false
  }
  noteGate(ctx, slot)

  let threadId
  try {
    ({ threadId } = await sendMessage({
      channel: 'sms',
      account, user: ctx.user, campaign: ctx.campaign, lead,
      nodeId, body,
    }))
  } catch (err) {
    if (err?.suppressed) {
      if (draft) discardStaleDraft(draft)
      logEvent(ctx.user.id, {
        campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'suppressed', detail: err.message,
      })
      finishLead(ctx, cl, err.reason === 'unsubscribed' || err.reason === 'opted_out' ? 'unsubscribed' : 'stopped', err.message)
      return false
    }
    throw err
  }
  if (draft) markDraftSent(draft.id)
  if (!cl.thread_id) setLead(cl, { thread_id: threadId })

  if (out.length === 0) { finishLead(ctx, cl, 'completed', 'no next step after send'); return false }
  const always = out.find((e) => e.cond.kind === 'always')
  if (always && out.length === 1) return enterNode(ctx, cl, always.to)
  setLead(cl, { state: 'waiting', wait_until: '' })
  return false
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
      const channel = (node.channel || 'email').toLowerCase()
      if (channel === 'sms') return sendSmsNode(ctx, cl, node, nodeId, out)
      if (channel !== 'email') {
        setLead(cl, { state: 'error', error: `Channel "${channel}" is not supported yet` })
        return false
      }

      // Resolved per lead, not per campaign: everything below — the sender name
      // in the copy, the daily cap the gate reads, the address it leaves from,
      // and the pacing gap it closes afterwards — has to agree about which
      // mailbox this is. Passing the campaign's mailbox to some of them and the
      // pinned one to others is how a pin half-works.
      const mailbox = mailboxFor(ctx, cl)
      const pinned = mailbox.id !== ctx.mailbox.id
      // The gate reads per-mailbox limits and warm-up state, so a pinned send
      // has to be judged against its own mailbox's rules rather than the
      // campaign mailbox's. Only recomputed when the two differ.
      const rules = pinned
        ? sendingContext({ owner: ctx.user, campaign: ctx.campaign, mailbox }).rules
        : ctx.rules

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
          senderName: mailbox.display_name || ctx.user.name || mailbox.email,
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
        owner: ctx.user, campaign: ctx.campaign, mailbox, lead,
        draft: draft && draft.status === 'approved' ? draft : null,
        rules, holds: ctx.holds,
        channel: 'email',
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
        ({ threadId } = await sendMessage({
          channel: 'email',
          account: mailbox, user: ctx.user, campaign: ctx.campaign, lead,
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
      //
      // The gap belongs to whichever mailbox actually sent. A pinned send must
      // not slow the campaign mailbox down, and — more importantly — must not
      // leave the pinned mailbox free to fire again a second later, which is
      // what pacing only the campaign mailbox would have done.
      const sent = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailbox.id)
      const gapUntil = Date.now() + nextGapMs(sendWindow(ctx.user), sent)
      db.prepare('UPDATE mailboxes SET next_send_at = ? WHERE id = ?').run(gapUntil, sent.id)
      sent.next_send_at = gapUntil
      // Keep the shared ctx in step when the campaign's own mailbox sent, so
      // the next lead in this tick sees the new counter rather than a stale one.
      if (!pinned) ctx.mailbox = sent

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
// `setBy` is an email address when a person chose this intent rather than the
// classifier. It is not decoration: it is what stops the next tick undoing the
// correction. Marking the inbound message with the chosen intent takes it out
// of the "unclassified" query the tick runs, and stamping `intent_set_by`
// records that a human owns this value — see `processWaiting`.
export async function routeReply(ctx, cl, intent, message, { setBy = '' } = {}) {
  // The classifier may read a reply as an unsubscribe; it may never act on
  // that reading. Acting means suppression — irreversible for the lead's own
  // footer click and heavy even when reversible — and the classifier has been
  // wrong about exactly this: a quoted footer under "ok thanks" read as an
  // opt-out. So the machine parks the lead with its reading attached, and
  // opting out remains what it always should have been: the recipient's own
  // click, or a person confirming what the reply actually says.
  if (intent === 'unsubscribe' && !setBy) {
    if (message) db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(intent, message.id)
    setLead(cl, { intent, state: 'needs_attention' })
    logEvent(ctx.user.id, {
      campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'needs_attention',
      detail: 'reply reads like an unsubscribe — confirm it to opt them out, nothing sends meanwhile',
    })
    const who = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
    notify(ctx.user.id, {
      title: 'Possible unsubscribe — your call',
      text: `A reply from ${[who?.first_name, who?.last_name].filter(Boolean).join(' ') || who?.email || 'a lead'} reads like an unsubscribe. Confirm it to opt them out, or reclassify it — no email goes out while they wait.`,
      link: '/app/inbox',
    })
    return true
  }

  const out = ctx.graph.edges.filter((e) => e.from === cl.node_id)
  const exact = out.find((e) => e.cond.kind === 'reply' && e.cond.intent === intent)
  const catchAll = out.find((e) => e.cond.kind === 'reply' && e.cond.intent === null)
  const edge = exact || catchAll

  if (message) {
    db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(intent, message.id)
    // Score it while the reply and the lead are both in hand. Deterministic and
    // model-free, so this runs identically with no API key configured.
    applyScore(db, { ...message, intent }, {
      lead: db.prepare('SELECT title, company FROM leads WHERE id = ?').get(cl.lead_id) || {},
      intent,
    })
    if (!setBy) logEvent(ctx.user.id, { campaignId: cl.campaign_id, leadId: cl.lead_id, type: 'classified', detail: intent })
    // No notification when a person set this: they are already looking at the
    // reply — that is where the correction came from.
    if (!setBy) {
      const who = db.prepare('SELECT * FROM leads WHERE id = ?').get(cl.lead_id)
      notify(ctx.user.id, {
        title: intent === 'interested' ? 'Interested reply' : `Reply: ${intent}`,
        text: `${[who?.first_name, who?.last_name].filter(Boolean).join(' ') || who?.email || 'A lead'}${who?.company ? ` at ${who.company}` : ''} — "${String(message.body || '').slice(0, 180)}"`,
        link: '/app/inbox',
      })
    }
  }
  setLead(cl, setBy
    ? { intent, intent_set_by: setBy, intent_set_at: new Date().toISOString() }
    : { intent })

  // A subsequence trigger fires before the parent's own edges are considered:
  // the whole point is that this lead's next email should come from the child's
  // playbook, so letting the parent branch first would send exactly the email
  // the handoff exists to avoid.
  if (handOff(ctx, cl, intent)) return true

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
  // Use the mailbox that owns the conversation — a pinned or rotated send may
  // have left campaign.mailbox_id, and Gmail thread ids are per-account. Syncing
  // the campaign's primary mailbox against another account's thread_id silently
  // finds nothing, so replies never reach the Inbox.
  try {
    const mailbox = mailboxFor(ctx, cl)
    await syncInbound({ mailbox, user: ctx.user, campaign: ctx.campaign, lead: { id: cl.lead_id }, threadId: cl.thread_id })
  } catch (err) {
    console.warn('[engine] inbound sync failed:', err.message)
  }

  // 2. Unprocessed inbound reply? Classify and branch.
  const unprocessed = db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'in' AND intent = '' ORDER BY id DESC LIMIT 1"
  ).get(cl.campaign_id, cl.lead_id)
  if (unprocessed) {
    // A person who corrected the classifier outranks it. Without this the
    // correction survived exactly as long as it took the tick to come round:
    // the reply was still unclassified, so the classifier ran again, reached
    // its original conclusion, and wrote it straight back over the human's.
    //
    // The comparison is by time, not by presence. An intent set by hand last
    // week says nothing about a reply that arrived this morning — that one
    // genuinely does need reading. Only a decision made *after* the message
    // landed is a decision about that message.
    const humanSet = cl.intent_set_by && cl.intent_set_at &&
      parseDbTime(cl.intent_set_at) >= parseDbTime(unprocessed.created_at)
    if (humanSet) {
      db.prepare('UPDATE messages SET intent = ? WHERE id = ?').run(cl.intent, unprocessed.id)
      return
    }
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
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
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
      notify(user.id, { title: 'Sending stopped to protect your address', text: brake, link: '/app/connections' })
    }
  }

  // Before the lead query, never after: a lead this stops must not be selected
  // for work in the same tick, or the reply that was supposed to halt the
  // subsequence would be answered by one more email from it first.
  stopSubsequencesOnSourceReply(ctx)

  // `paused_at` is set by the pause routes and was read by nothing here, so a
  // paused lead carried on receiving follow-ups exactly like an unpaused one —
  // the pause changed what the UI said and nothing about what the engine did.
  // `resume_at` lets a pause expire on its own; until then the lead is skipped.
  //
  // `completed_at` is the terminal marker "mark as done" writes, and it is
  // checked *here*, in the one query that decides who the tick works on, rather
  // than only in the routes that could resurrect a lead
  // (Docs/campaigns/mark-lead-complete.md §5: "the engine must treat a completed
  // campaign_leads row as terminal at the top of its tick").
  //
  // Terminal-ness used to ride on `state` alone, and `state` is written by a
  // dozen places — the intent route, resume, retry, reclassify, the handoff. Any
  // one of them flipping a completed row back to 'active' put it straight back
  // in this SELECT, and the next tick emailed someone a person had marked done.
  // Guarding each writer would mean being right thirteen times; guarding the
  // selection means being right once, and any writer added later inherits it.
  // The intent route refuses as well (server/parity/campaigns.js) — not because
  // this guard needs help, but so the user is told rather than left with a row
  // whose `state` says active and which will never move again.
  //
  // Re-enrolling somebody deliberately is unaffected: that removes the pairing
  // and adds it again, and the new row carries no completion.
  const leads = db.prepare(
    `SELECT * FROM campaign_leads
      WHERE campaign_id = ? AND state IN ('queued','active','waiting')
        AND COALESCE(completed_at,'') = ''
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
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
  const graph = parsePlaybook(campaign.mermaid)
  // The same rules and holds the tick resolves, so a manually routed send is
  // gated by exactly what an automatic one is.
  const { rules, holds } = sendingContext({ owner: user, campaign, mailbox })
  return { campaign, user, mailbox, graph, rules, holds }
}
