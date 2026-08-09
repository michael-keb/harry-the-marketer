// Email tracking: open pixel, signed click-through links, one-click unsubscribe.
// These endpoints are public by design (recipients hit them from their inbox).
// For real recipients outside this machine, APP_URL must be publicly reachable.
import crypto from 'node:crypto'
import express from 'express'
import { db, sessionSecret, logEvent } from './db.js'
import { env } from './env.js'
import { unsubscribeLead } from './suppression.js'

const SECRET = sessionSecret()

export const newTrackingToken = () => crypto.randomBytes(12).toString('hex')

export function signUrl(token, url) {
  return crypto.createHmac('sha256', SECRET).update(`${token}|${url}`).digest('base64url').slice(0, 24)
}

// A custom tracking domain, reduced to a bare hostname or discarded.
//
// Everything that reaches here has already been validated at save time
// (`trackingDomain()` in server/parity/mailboxes.js), but this is the function
// that interpolates a stored value straight into an `href`, so it re-checks
// rather than trusting the column. A value that is not a plain hostname falls
// back to APP_URL: a mistyped setting must degrade to a working link, never to
// a broken or attacker-controlled one.
const SAFE_HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function normalizeTrackingDomain(domain) {
  const bare = String(domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:.*$/, '')
  return SAFE_HOST.test(bare) ? bare : ''
}

// Campaign beats mailbox beats APP_URL.
//
// Both columns exist and neither had a reader. The order is "most specific
// wins", the same rule the per-lead sender pin follows over the campaign's own
// mailbox: a mailbox tracking domain is a fleet-wide default set once when the
// address is connected, while a campaign tracking domain is chosen by the
// person running *this* campaign, later and for this campaign only. Anything
// else would make the campaign-level field unusable — you could never override
// the fleet default, which is the only reason to set a per-campaign one.
export function trackingDomainFor({ campaign = null, mailbox = null } = {}) {
  return normalizeTrackingDomain(campaign?.tracking_domain) || normalizeTrackingDomain(mailbox?.tracking_domain)
}

export const trackingBase = (domain = '') => {
  const host = normalizeTrackingDomain(domain)
  return host ? `https://${host}` : env.APP_URL.replace(/\/$/, '')
}

// The signature covers `token|url` and deliberately not the host: it is what
// stops /t/c from being an open redirect, and it has to keep verifying whether
// the recipient arrives on APP_URL or on a CNAME'd tracking domain pointing at
// the same app. Signing the base instead would make every custom-domain link
// unverifiable — a broken link where an unverified one was the worry.
export function trackedClickUrl(token, url, domain = '') {
  return `${trackingBase(domain)}/t/c/${token}?u=${Buffer.from(url).toString('base64url')}&s=${signUrl(token, url)}`
}

export const pixelUrl = (token, domain = '') => `${trackingBase(domain)}/t/o/${token}.gif`
export const unsubscribeUrl = (token, domain = '') => `${trackingBase(domain)}/t/u/${token}`

// The plain-text part needs its own way out — a recipient reading in a
// text-only client should never have to hunt for one, and CAN-SPAM/CASL both
// require an opt-out in the message itself, not just in an HTML alternative.
export function withOptOutFooter(body, token, domain = '') {
  return `${String(body).trimEnd()}\n\n--\nDon't want these? Unsubscribe here: ${unsubscribeUrl(token, domain)}`
}

// Build the HTML alternative for a plain-text body: escaped text, optionally
// tracked links, optionally an open pixel, always an unsubscribe footer.
//
// The flags are the point. This function used to take none, and `mailer.js`
// called it unconditionally, so a campaign with `track_opens: false` still
// carried a pixel and still had every link rewritten through the click
// redirector. The setting changed what Reports *said* and nothing about what
// left the building — which for a privacy control is the worst way to be wrong.
//
// The unsubscribe link is deliberately NOT optional. Suppression and the right
// to leave are not campaign preferences — and it is built from the same
// `trackingDomain` as everything else, so a custom domain moves the opt-out
// link with the rest rather than leaving one link pointing at a second host.
//
// `signature` is the mailbox's, already sanitised by
// `sanitizeSignature()` in server/parity/mailboxes.js. It goes in raw, below
// the body and ABOVE the unsubscribe line, because Docs/email-accounts/update.md
// AC 7 is explicit that a signature must not displace the opt-out.
export function buildHtmlBody({ body, token, trackOpens = true, trackClicks = true, trackingDomain = '', signature = '' }) {
  const escaped = String(body)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = trackClicks
    ? escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[).,;!?]+$/, '')
      const trail = url.slice(clean.length)
      return `<a href="${trackedClickUrl(token, clean, trackingDomain)}">${clean}</a>${trail}`
    })
    // Still linked, just not through us: a bare URL in an HTML part that the
    // reader cannot click is a worse email, and not tracking is the ask.
    : escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[).,;!?]+$/, '')
      const trail = url.slice(clean.length)
      return `<a href="${clean}">${clean}</a>${trail}`
    })
  const sig = String(signature || '').trim()
  return (
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    `<div>${linked.replace(/\n/g, '<br>')}</div>` +
    (sig ? `<div class="harry-signature">${sig}</div>` : '') +
    `<br><div style="font-size:11px;color:#999">` +
    `<a href="${unsubscribeUrl(token, trackingDomain)}" style="color:#999">Unsubscribe</a></div>` +
    (trackOpens ? `<img src="${pixelUrl(token, trackingDomain)}" width="1" height="1" alt="" style="display:none">` : '') +
    `</body></html>`
  )
}

// The signature as it belongs in the plain-text alternative. The column holds
// sanitised HTML; a text-only client must not be shown the tags.
export function signatureText(html) {
  if (!html) return ''
  return String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const messageByToken = (token) =>
  db.prepare("SELECT * FROM messages WHERE tracking_token = ? AND direction = 'out'").get(token)

export const trackingRouter = express.Router()

trackingRouter.get('/t/o/:token.gif', (req, res) => {
  const msg = messageByToken(req.params.token)
  if (msg && !msg.opened_at) {
    db.prepare("UPDATE messages SET opened_at = datetime('now') WHERE id = ?").run(msg.id)
    logEvent(msg.user_id, { campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'opened', detail: msg.subject })
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private', Pragma: 'no-cache' })
  res.send(GIF)
})

trackingRouter.get('/t/c/:token', (req, res) => {
  const { token } = req.params
  let url
  try { url = Buffer.from(String(req.query.u || ''), 'base64url').toString('utf8') } catch { url = '' }
  // The signature stops this from being an open redirect: only URLs we put in
  // the email redirect anywhere.
  if (!url || req.query.s !== signUrl(token, url) || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Invalid link')
  }
  const msg = messageByToken(token)
  if (msg) {
    const updates = ["clicked_at = datetime('now')"]
    if (!msg.opened_at) updates.push("opened_at = datetime('now')") // a click implies an open
    if (!msg.clicked_at) {
      db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(msg.id)
      logEvent(msg.user_id, { campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'clicked', detail: url.slice(0, 200) })
    }
  }
  res.redirect(302, url)
})

trackingRouter.get('/t/u/:token', (req, res) => {
  const msg = messageByToken(req.params.token)
  if (msg?.lead_id) {
    // The same function the Settings route calls. This path used to write
    // `leads.status` and stop there, so Reports — which counts
    // `campaign_leads.unsubscribed_at` — showed zero unsubscribes, and any
    // draft already written for this person stayed in Needs your OK waiting to
    // be approved and sent to someone who had just opted out.
    const result = unsubscribeLead(msg.user_id, msg.lead_id, { source: 'link', actor: 'recipient' })
    logEvent(msg.user_id, {
      campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'unsubscribed_link',
      detail: `one-click unsubscribe — ${result.stopped} enrolment${result.stopped === 1 ? '' : 's'} stopped` +
        `${result.declined ? `, ${result.declined} draft${result.declined === 1 ? '' : 's'} withdrawn` : ''}` +
        `${result.cancelled ? `, ${result.cancelled} queued send${result.cancelled === 1 ? '' : 's'} cancelled` : ''}`,
    })
  }
  res.set('Content-Type', 'text/html')
  res.send(
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222">` +
    `<h2>You're unsubscribed</h2><p>You won't receive further emails from this sender.</p></body></html>`
  )
})
