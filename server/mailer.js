// Provider dispatch: one interface over Gmail and the local sandbox provider.
// Sandbox mailboxes record sends locally and let you simulate replies, so the
// entire platform can be exercised end-to-end without Google credentials.
import crypto from 'node:crypto'
import { db, logEvent } from './db.js'
import { gmailSend, gmailThread } from './google.js'
import { outlookSend, outlookThread } from './microsoft.js'
import { isOAuthProvider } from './providers.js'
import { recordTelemetry } from './telemetry.js'
import {
  newTrackingToken, buildHtmlBody, unsubscribeUrl, withOptOutFooter,
  signatureText, trackingDomainFor,
} from './tracking.js'
import { remainingToday } from './pacing.js'
import { suppressionFor, SuppressedError } from './suppression.js'
import { recordTouch } from './touches.js'

export { SuppressedError }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// What is left today, after the warm-up ramp has had its say. A mailbox
// connected this morning is not allowed its full allowance yet.
export function remainingQuota(mailbox) {
  return remainingToday(mailbox)
}

function bumpQuota(mailbox) {
  const today = todayStr()
  if (mailbox.sent_today_date === today) {
    db.prepare('UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ?').run(mailbox.id)
  } else {
    db.prepare('UPDATE mailboxes SET sent_today = 1, sent_today_date = ? WHERE id = ?').run(today, mailbox.id)
  }
}

// The mailbox signature, appended below the agent-composed body — once.
//
// Docs/email-accounts/update.md AC 7. `mailboxes.signature` was stored,
// sanitised and echoed by the API and read by nothing on the way out, so no
// email a campaign ever sent carried one.
//
// "Once" is the whole difficulty, and the rule is deliberately the same one
// server/parity/campaigns.js and server/parity/inbox.js already apply on the
// two manual-reply routes rather than a second, subtly different one: if the
// body already contains the signature, it is left alone. It is checked in both
// forms because those routes append the raw (HTML) column while this appends
// the text rendering — a manual reply that has already been signed must not be
// signed again here.
//
// Manual replies are excluded outright. Those routes take an explicit
// `add_signature` flag and a caller who leaves it off means "send this body as
// written"; AC 7 is about the *agent-composed* body, which is every email a
// playbook sends.
export function signedBody(body, mailbox, nodeId) {
  if (nodeId === 'manual') return String(body)
  const raw = String(mailbox?.signature || '').trim()
  const text = signatureText(raw)
  if (!text) return String(body)
  const current = String(body)
  if (current.includes(text) || (raw && current.includes(raw))) return current
  return `${current.trimEnd()}\n\n${text}`
}

// Send an email through the mailbox's provider and record it in `messages`.
// `cc`/`bcc` are optional and only ever supplied by the manual reply path — the
// agent never copies anyone. They are validated by the caller and suppression-
// checked at the transport alongside the primary recipient.
export async function sendEmail({ mailbox, user, campaign, lead, nodeId, subject, body, cc = [], bcc = [] }) {
  // Suppression, last. Every entry point already checks — import, push, the
  // approval queue, the manual reply — but this is the only line every send
  // passes through, and it is what makes "checked immediately before every
  // send, in one place" (Settings → Never contact) true rather than aspiration.
  // There is deliberately no parameter to skip it.
  const suppressed = suppressionFor(campaign.user_id, { address: lead.email, lead })
  if (suppressed) {
    recordTelemetry('send', { op: 'suppressed', ok: true, detail: suppressed.reason })
    throw new SuppressedError(suppressed)
  }
  // Copied recipients too, and here rather than only in `gmailSend`: the
  // sandbox provider never reaches that function, and a rule that holds for one
  // provider and not the other is not a rule. Being cc'd is still being
  // emailed, so somebody on the never-contact list stops the whole send.
  for (const address of [...cc, ...bcc]) {
    const blocked = suppressionFor(campaign.user_id, { address: String(address).trim() })
    if (blocked) {
      recordTelemetry('send', { op: 'suppressed', ok: true, detail: `copied recipient — ${blocked.reason}` })
      throw new SuppressedError(blocked)
    }
  }

  if (remainingQuota(mailbox) <= 0) throw new Error(`Daily limit reached for ${mailbox.email}`)

  const existing = db
    .prepare("SELECT thread_id FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?")
    .get(campaign.id, lead.id)

  let providerMessageId
  let threadId = existing?.thread_id || ''
  const trackingToken = newTrackingToken()

  // The mailbox's own settings, applied here because this is the one line every
  // agent send passes through — the same reason suppression and the touch
  // ledger live here rather than at each call site.
  const outgoing = signedBody(body, mailbox, nodeId)
  // The HTML part gets the sanitised markup rather than the text rendering, and
  // gets it ONLY when the text part was actually signed here. If the body
  // already carried the signature — a manual reply signed upstream, a follow-up
  // composed from a previous email — the escaped body already shows it, and
  // adding the markup too is exactly the double signature the "once" rule is
  // there to prevent.
  const htmlSignature = outgoing === String(body) ? '' : String(mailbox?.signature || '').trim()
  // Docs/email-accounts/update.md AC 6: tracking links use the custom domain.
  // Falls back to APP_URL when neither the campaign nor the mailbox sets one.
  const trackDomain = trackingDomainFor({ campaign, mailbox })

  const t0 = Date.now()
  if (mailbox.provider === 'gmail') {
    try {
      const result = await gmailSend(mailbox, {
        to: lead.email,
        cc,
        bcc,
        subject,
        // The opt-out line rides along with the transport, like the
        // List-Unsubscribe header — `messages` keeps the email as written.
        body: withOptOutFooter(outgoing, trackingToken, trackDomain),
        // The campaign's own tracking settings, honoured on the wire rather
        // than only in what Reports reports. `track_opens`/`track_clicks`
        // default to 1 in the schema, so a campaign that has never been
        // configured behaves exactly as before.
        html: buildHtmlBody({
          body,
          token: trackingToken,
          trackOpens: campaign.track_opens !== 0,
          trackClicks: campaign.track_clicks !== 0,
          trackingDomain: trackDomain,
          signature: htmlSignature,
        }),
        listUnsubscribe: unsubscribeUrl(trackingToken, trackDomain),
        threadId: threadId || undefined,
        workspaceId: user.id,
      })
      providerMessageId = result.messageId
      threadId = result.threadId
      recordTelemetry('send', { op: 'gmail', ok: true, ms: Date.now() - t0 })
    } catch (err) {
      recordTelemetry('send', { op: 'gmail', ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(String(err.message || err).slice(0, 300), mailbox.id)
      throw err
    }
  } else if (mailbox.provider === 'outlook') {
    try {
      const result = await outlookSend(mailbox, {
        to: lead.email,
        cc,
        bcc,
        subject,
        body: withOptOutFooter(outgoing, trackingToken, trackDomain),
        html: buildHtmlBody({
          body,
          token: trackingToken,
          trackOpens: campaign.track_opens !== 0,
          trackClicks: campaign.track_clicks !== 0,
          trackingDomain: trackDomain,
          signature: htmlSignature,
        }),
        listUnsubscribe: unsubscribeUrl(trackingToken, trackDomain),
        threadId: threadId || undefined,
        workspaceId: user.id,
      })
      providerMessageId = result.messageId
      threadId = result.threadId
      recordTelemetry('send', { op: 'outlook', ok: true, ms: Date.now() - t0 })
    } catch (err) {
      recordTelemetry('send', { op: 'outlook', ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(String(err.message || err).slice(0, 300), mailbox.id)
      throw err
    }
  } else {
    providerMessageId = `sbx-msg-${crypto.randomBytes(6).toString('hex')}`
    threadId = threadId || `sbx-thr-${crypto.randomBytes(6).toString('hex')}`
    recordTelemetry('send', { op: 'sandbox', ok: true, ms: Date.now() - t0 })
  }

  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, cc_emails, bcc_emails, provider_message_id, thread_id, node_id, is_read, tracking_token, send_status)
     VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent')`
    // The signed body, not the composed one: what is recorded has to be what
    // was sent, and the two manual-reply routes already store their signed
    // `outgoing` for the same reason.
  ).run(user.id, campaign.id, lead.id, mailbox.id, subject, outgoing, mailbox.email, lead.email,
    cc.join(', '), bcc.join(', '), providerMessageId, threadId, nodeId, trackingToken)
  bumpQuota(mailbox)
  // The touch ledger, written here for the same reason suppression is checked
  // here: this is the one line every send passes through. A frequency cap that
  // some send paths forget to record against is not a cap.
  recordTouch({
    wsId: campaign.user_id, leadId: lead.id, email: lead.email,
    channel: 'email', campaignId: campaign.id,
  })
  logEvent(user.id, { campaignId: campaign.id, leadId: lead.id, type: 'sent', detail: subject })
  return { providerMessageId, threadId }
}

// Gmail thread fetch with sync telemetry; failures also stamp the mailbox so
// the Monitoring page can point at the broken connection.
async function timedSync(mailbox, threadId) {
  const t0 = Date.now()
  const op = mailbox.provider === 'outlook' ? 'outlook' : 'gmail'
  try {
    const remote = mailbox.provider === 'outlook'
      ? await outlookThread(mailbox, threadId)
      : await gmailThread(mailbox, threadId)
    recordTelemetry('inbound_sync', { op, ok: true, ms: Date.now() - t0 })
    return remote
  } catch (err) {
    recordTelemetry('inbound_sync', { op, ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(String(err.message || err).slice(0, 300), mailbox.id)
    throw err
  }
}

// Pull any new inbound messages for a thread into `messages` (oauth providers —
// sandbox inbound messages are inserted directly by the simulate endpoint).
export async function syncInbound({ mailbox, user, campaign, lead, threadId }) {
  if (!isOAuthProvider(mailbox.provider) || !threadId) return 0
  const remote = await timedSync(mailbox, threadId)
  const known = new Set(
    db.prepare('SELECT provider_message_id FROM messages WHERE thread_id = ?').all(threadId).map((r) => r.provider_message_id)
  )
  let added = 0
  for (const msg of remote) {
    if (msg.direction !== 'in' || known.has(msg.providerMessageId)) continue
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
       VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`
    ).run(user.id, campaign.id, lead.id, mailbox.id, msg.subject, msg.body.slice(0, 20000), msg.fromEmail, msg.toEmail, msg.providerMessageId, threadId)
    added++
  }
  if (added) {
    db.prepare("UPDATE mailboxes SET last_sync_at = datetime('now') WHERE id = ?").run(mailbox.id)
  }
  return added
}

// Sandbox: simulate an inbound reply on a thread (drives the E2E demo loop).
export function simulateReply({ user, campaignLead, text }) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(campaignLead.lead_id)
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignLead.campaign_id)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL').get(campaign.mailbox_id)
  if (!mailbox || mailbox.provider !== 'sandbox') throw new Error('Simulated replies only work on sandbox mailboxes')
  if (!campaignLead.thread_id) throw new Error('No thread yet — send the first email before simulating a reply')
  const lastOut = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1")
    .get(campaignLead.thread_id)
  const subject = lastOut?.subject ? (lastOut.subject.startsWith('Re:') ? lastOut.subject : `Re: ${lastOut.subject}`) : 'Re:'
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
     VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id, campaign.id, lead.id, mailbox.id, subject, text, lead.email, mailbox.email,
    `sbx-msg-${crypto.randomBytes(6).toString('hex')}`, campaignLead.thread_id
  )
  logEvent(user.id, { campaignId: campaign.id, leadId: lead.id, type: 'reply', detail: text.slice(0, 120) })
}
