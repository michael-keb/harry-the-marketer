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

// ---- plain-text & opt-out wording -------------------------------------------

// Campaign asked for plain text only (Settings → send_as_plain_text /
// force_plain_text). When set, no HTML alternative is attached — the opt-out
// footer still rides on the text part, so the way out survives.
function forcePlainText(campaign) {
  if (campaign?.send_as_plain_text || campaign?.force_plain_text) return true
  try {
    const s = JSON.parse(campaign?.settings || '{}')
    return Boolean(s.send_as_plain_text || s.force_plain_text)
  } catch { return false }
}

// The campaign's own opt-out wording, threaded through to the footer so the
// sentence the sender previewed is the one that ships.
function unsubscribeWordingOf(campaign) {
  try { return String(JSON.parse(campaign?.settings || '{}').unsubscribe_text || '').trim() } catch { return '' }
}

// ---- bounce detection --------------------------------------------------------
//
// The bounce brake (server/gates.js) keys on leads.status='bounced' and
// messages.send_status='bounced', but nothing set them — so a mailbox could burn
// its domain on a dead list and the brake never engaged. This classifies an
// inbound delivery-failure notice (a DSN / NDR), resolves which recipient it is
// about, and marks that lead and its last outbound bounced. Wired into every
// inbound path: the per-thread engine sync (syncInbound below) and the
// whole-inbox upkeep sweep (server/upkeep.js).
const BOUNCE_FROM_RE = /(mailer-daemon|postmaster|mail delivery (sub)?system|mail delivery system)/i
const BOUNCE_SUBJECT_RE = /(delivery status notification|undeliverable|undelivered mail|delivery (has )?failed|returned mail|mail delivery failed|message not delivered|delivery incomplete|failure notice)/i
const BOUNCE_BODY_RE = /(delivery status notification|status:\s*5\.\d+\.\d+|\b(550|554)[ -]|message not delivered|address (couldn't|could not) be found|recipient .*(rejected|does not exist)|user unknown|no such user|mailbox (unavailable|full))/i

function extractFailedRecipient(subject, body) {
  const text = `${subject || ''}\n${body || ''}`
  const patterns = [
    /Final-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+?)>?\s/i,
    /Original-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+?)>?\s/i,
    /<([^\s<>]+@[^\s<>]+)>\s*[:(]/, // Postfix: "<foo@bar.com>: host said..."
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[1].toLowerCase()
  }
  const any = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
  return any ? any[0].toLowerCase() : ''
}

// A transient defer — Gmail's "delivery has been delayed", a 4.x.x status, a
// "will retry" — comes from mailer-daemon just like a hard failure does, but the
// recipient is still reachable. Marking such a lead bounced would suppress a
// live address on a temporary hiccup, so a transient notice is only treated as a
// bounce when a permanent (5.x.x) signal is also present.
const BOUNCE_TRANSIENT_RE = /(delivery (is |has been )?delayed|delivery delay|will (be )?retr|temporar(y|ily)|status:\s*4\.\d+\.\d+|\b4\.\d\.\d\b|not yet been delivered)/i
const BOUNCE_HARD_RE = /(\b5\.\d+\.\d+\b|\b(550|554)\b|permanent(ly)?|does not exist|user unknown|no such (user|mailbox))/i

// Returns { failed } when the message is a permanent delivery-failure notice,
// else null (including transient defers, which must not suppress the lead).
export function classifyBounce(msg) {
  const from = String(msg?.fromEmail || '').toLowerCase()
  const subject = String(msg?.subject || '')
  const body = String(msg?.body || '')
  const looksBounce =
    BOUNCE_FROM_RE.test(from) || BOUNCE_SUBJECT_RE.test(subject) || BOUNCE_BODY_RE.test(body)
  if (!looksBounce) return null
  const hay = `${subject}\n${body}`
  if (BOUNCE_TRANSIENT_RE.test(hay) && !BOUNCE_HARD_RE.test(hay)) return null
  return { failed: extractFailedRecipient(subject, body) }
}

// Mark the addressed lead bounced and its most recent outbound (from this
// mailbox when known) send_status='bounced'. Idempotent — re-marking an already
// bounced lead is a no-op and does not re-log. Returns the lead/message ids or
// null when the failed recipient is not a known lead.
export function markBounce({ wsId, mailboxId = null, failedEmail }) {
  if (!wsId || !failedEmail) return null
  const lead = db.prepare(
    'SELECT * FROM leads WHERE user_id = ? AND lower(trim(email)) = ?'
  ).get(wsId, failedEmail)
  if (!lead) return null
  const already = lead.status === 'bounced'
  if (!already) {
    db.prepare("UPDATE leads SET status = 'bounced', updated_at = datetime('now') WHERE id = ?").run(lead.id)
  }
  const out = mailboxId
    ? db.prepare(
        "SELECT * FROM messages WHERE user_id = ? AND lead_id = ? AND direction = 'out' AND mailbox_id = ? ORDER BY id DESC LIMIT 1"
      ).get(wsId, lead.id, mailboxId)
      || db.prepare("SELECT * FROM messages WHERE user_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(wsId, lead.id)
    : db.prepare("SELECT * FROM messages WHERE user_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(wsId, lead.id)
  const marked = out && out.send_status !== 'bounced'
  if (marked) db.prepare("UPDATE messages SET send_status = 'bounced' WHERE id = ?").run(out.id)
  if (!already || marked) {
    logEvent(wsId, {
      campaignId: out?.campaign_id || null, leadId: lead.id, type: 'bounced',
      detail: `delivery failed to ${failedEmail} — lead marked bounced`,
    })
  }
  return { leadId: lead.id, messageId: out?.id || null }
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
  // Campaign send-format and opt-out wording, honoured on the wire.
  const plain = forcePlainText(campaign)
  const unsubText = unsubscribeWordingOf(campaign)

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
        body: withOptOutFooter(outgoing, trackingToken, trackDomain, unsubText),
        // The campaign's own tracking settings, honoured on the wire rather
        // than only in what Reports reports. `track_opens`/`track_clicks`
        // default to 1 in the schema, so a campaign that has never been
        // configured behaves exactly as before. Plain-text campaigns get NO
        // HTML alternative — text/plain only — so send_as_plain_text is real.
        html: plain ? undefined : buildHtmlBody({
          body,
          token: trackingToken,
          trackOpens: campaign.track_opens !== 0,
          trackClicks: campaign.track_clicks !== 0,
          trackingDomain: trackDomain,
          signature: htmlSignature,
          unsubscribeText: unsubText,
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
        body: withOptOutFooter(outgoing, trackingToken, trackDomain, unsubText),
        html: plain ? undefined : buildHtmlBody({
          body,
          token: trackingToken,
          trackOpens: campaign.track_opens !== 0,
          trackClicks: campaign.track_clicks !== 0,
          trackingDomain: trackDomain,
          signature: htmlSignature,
          unsubscribeText: unsubText,
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
  if (!isOAuthProvider(mailbox.provider)) return 0
  if (!threadId) {
    const row = db.prepare(
      `SELECT thread_id FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out'
         AND COALESCE(thread_id, '') != '' ORDER BY id DESC LIMIT 1`
    ).get(campaign.id, lead.id)
    threadId = row?.thread_id || ''
  }
  if (!threadId) return 0
  const remote = await timedSync(mailbox, threadId)
  // Scoped by user_id: two workspaces can hold the same Gmail account, and the
  // dedupe must be per-workspace or the second workspace loses every reply the
  // first already saw.
  const known = new Set(
    db.prepare("SELECT provider_message_id FROM messages WHERE user_id = ? AND thread_id = ?")
      .all(user.id, threadId).map((r) => r.provider_message_id)
  )
  let added = 0
  for (const msg of remote) {
    if (msg.direction !== 'in' || known.has(msg.providerMessageId)) continue
    // A delivery-failure notice on the thread is a bounce, not a reply — mark the
    // lead/message bounced (feeds the brake) and do not record it as a reply.
    const bounce = classifyBounce(msg)
    if (bounce) {
      markBounce({ wsId: user.id, mailboxId: mailbox.id, failedEmail: bounce.failed || lead?.email || '' })
      continue
    }
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
       VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`
    ).run(user.id, campaign.id, lead.id, mailbox.id, msg.subject, msg.body.slice(0, 20000), msg.fromEmail, msg.toEmail, msg.providerMessageId, threadId).changes
    // Emit the reply event from the engine path too — the LEAD_REPLIED webhook
    // used to miss active-campaign replies because only the 5-minute upkeep sweep
    // logged them. The unique (user_id, provider_message_id) index means exactly
    // one path inserts a given message (changes === 1), so keying the event on the
    // insert dedupes it against the upkeep sweep automatically.
    if (inserted) {
      logEvent(user.id, {
        campaignId: campaign.id, leadId: lead.id, type: 'reply',
        detail: String(msg.body || msg.subject || '').slice(0, 120),
      })
    }
    added += inserted
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
