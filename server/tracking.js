// Email tracking: open pixel, signed click-through links, one-click unsubscribe.
// These endpoints are public by design (recipients hit them from their inbox).
// For real recipients outside this machine, APP_URL must be publicly reachable.
import crypto from 'node:crypto'
import express from 'express'
import { db, sessionSecret, logEvent } from './db.js'
import { env } from './env.js'

const SECRET = sessionSecret()

export const newTrackingToken = () => crypto.randomBytes(12).toString('hex')

export function signUrl(token, url) {
  return crypto.createHmac('sha256', SECRET).update(`${token}|${url}`).digest('base64url').slice(0, 24)
}

export const trackingBase = () => env.APP_URL.replace(/\/$/, '')

export function trackedClickUrl(token, url) {
  return `${trackingBase()}/t/c/${token}?u=${Buffer.from(url).toString('base64url')}&s=${signUrl(token, url)}`
}

export const pixelUrl = (token) => `${trackingBase()}/t/o/${token}.gif`
export const unsubscribeUrl = (token) => `${trackingBase()}/t/u/${token}`

// The plain-text part needs its own way out — a recipient reading in a
// text-only client should never have to hunt for one, and CAN-SPAM/CASL both
// require an opt-out in the message itself, not just in an HTML alternative.
export function withOptOutFooter(body, token) {
  return `${String(body).trimEnd()}\n\n--\nDon't want these? Unsubscribe here: ${unsubscribeUrl(token)}`
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
// to leave are not campaign preferences.
export function buildHtmlBody({ body, token, trackOpens = true, trackClicks = true }) {
  const escaped = String(body)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = trackClicks
    ? escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[).,;!?]+$/, '')
      const trail = url.slice(clean.length)
      return `<a href="${trackedClickUrl(token, clean)}">${clean}</a>${trail}`
    })
    // Still linked, just not through us: a bare URL in an HTML part that the
    // reader cannot click is a worse email, and not tracking is the ask.
    : escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[).,;!?]+$/, '')
      const trail = url.slice(clean.length)
      return `<a href="${clean}">${clean}</a>${trail}`
    })
  return (
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    `<div>${linked.replace(/\n/g, '<br>')}</div>` +
    `<br><div style="font-size:11px;color:#999">` +
    `<a href="${unsubscribeUrl(token)}" style="color:#999">Unsubscribe</a></div>` +
    (trackOpens ? `<img src="${pixelUrl(token)}" width="1" height="1" alt="" style="display:none">` : '') +
    `</body></html>`
  )
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
    db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = datetime('now') WHERE id = ?").run(msg.lead_id)
    db.prepare(
      "UPDATE campaign_leads SET state = 'finished', outcome = 'unsubscribed', updated_at = datetime('now') WHERE lead_id = ? AND state IN ('queued','active','waiting','needs_attention')"
    ).run(msg.lead_id)
    logEvent(msg.user_id, { campaignId: msg.campaign_id, leadId: msg.lead_id, type: 'unsubscribed_link', detail: 'one-click unsubscribe' })
  }
  res.set('Content-Type', 'text/html')
  res.send(
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222">` +
    `<h2>You're unsubscribed</h2><p>You won't receive further emails from this sender.</p></body></html>`
  )
})
