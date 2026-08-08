// The signed "yes".
//
// When a prospect says they're interested, the agent sends them one link. They
// read what they're agreeing to, type their name, and click Agree. That's the
// whole flow — one click for them, a dated record for you.
//
// Server-rendered on purpose, like the legal pages: recipients open it from an
// email client on any device, and it must work with no JavaScript.
import crypto from 'node:crypto'
import express from 'express'
import { db, logEvent } from './db.js'
import { env } from './env.js'
import { notify } from './alerts.js'
import { BRAND } from '../shared/site-content.js'

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const consentUrl = (token) => `${(env.APP_URL || '').replace(/\/$/, '')}/agree/${token}`

// What they're agreeing to. The owner can write their own in Settings; this is
// the honest default, and it names the sender so the page is never anonymous.
export function defaultTerms({ senderName, senderEmail, offer }) {
  const who = [senderName, senderEmail && `(${senderEmail})`].filter(Boolean).join(' ') || 'the sender'
  return [
    `You are confirming that you're happy to take part in the work ${who} described.`,
    offer ? `What it involves: ${offer}` : 'What it involves: a short conversation and any details you choose to share.',
    'What we will use: only the details you give us and what is publicly available about your business.',
    'You can change your mind at any time by replying to the email — nothing is binding and there is no cost.',
  ].join('\n\n')
}

export function ownerTerms(owner) {
  if (owner?.consent_terms?.trim()) return owner.consent_terms.trim()
  let offer = ''
  try { offer = JSON.parse(owner?.profile || '{}')?.offer || '' } catch { /* free-text briefing */ }
  return defaultTerms({ senderName: owner?.name, senderEmail: owner?.email, offer })
}

export function consentFor(userId, leadId) {
  return db.prepare('SELECT * FROM consents WHERE user_id = ? AND lead_id = ?').get(userId, leadId)
}

// Make sure this lead has an agreement link, and return it. Re-issuing is a
// no-op: the same link keeps working, and a signed one is never overwritten.
export function ensureConsent({ owner, leadId, campaignId = null }) {
  const existing = consentFor(owner.id, leadId)
  if (existing) return existing
  const token = crypto.randomBytes(12).toString('hex')
  db.prepare(
    'INSERT INTO consents (user_id, lead_id, campaign_id, token, terms) VALUES (?, ?, ?, ?, ?)'
  ).run(owner.id, leadId, campaignId, token, ownerTerms(owner))
  return consentFor(owner.id, leadId)
}

// ---- the page ---------------------------------------------------------------

function page({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light }
  body { margin:0; background:#f6f7f9; color:#16202a;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
  main { max-width:34rem; margin:0 auto; padding:3rem 1.25rem 4rem }
  .card { background:#fff; border:1px solid #e3e7ec; border-radius:14px; padding:1.75rem }
  h1 { font-size:1.4rem; margin:0 0 .35rem; letter-spacing:-.01em }
  .sub { color:#5b6a78; margin:0 0 1.5rem }
  .terms { white-space:pre-wrap; background:#f6f7f9; border:1px solid #e3e7ec;
           border-radius:10px; padding:1rem; margin:0 0 1.5rem }
  label { display:block; font-size:.85rem; color:#5b6a78; margin-bottom:.35rem }
  input[type=text] { width:100%; box-sizing:border-box; padding:.7rem .8rem; font-size:1rem;
                     border:1px solid #cfd6de; border-radius:9px; background:#fff; color:inherit }
  input[type=text]:focus { outline:2px solid #17a583; outline-offset:1px; border-color:#17a583 }
  .actions { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; margin-top:1.25rem }
  button { font:inherit; font-weight:600; padding:.7rem 1.4rem; border-radius:9px; cursor:pointer }
  .yes { background:#17a583; border:1px solid #17a583; color:#fff }
  .no { background:transparent; border:1px solid #cfd6de; color:#5b6a78; font-weight:500 }
  .foot { color:#8593a0; font-size:.8rem; margin-top:1.5rem; text-align:center }
  .done { font-size:1.1rem }
</style>
</head>
<body><main>${body}
<p class="foot">Sent via ${esc(BRAND.name)}</p>
</main></body></html>`
}

const notFound = () =>
  page({
    title: 'Link not found',
    body: `<div class="card"><h1>This link isn't valid</h1>
      <p class="sub">It may have been mistyped or replaced by a newer one. Replying to the email that brought you here is the quickest fix.</p></div>`,
  })

function signedPage(consent, lead) {
  return page({
    title: 'Confirmed',
    body: `<div class="card">
      <h1 class="done">You're confirmed${consent.signed_name ? `, ${esc(consent.signed_name.split(' ')[0])}` : ''}.</h1>
      <p class="sub">Recorded ${esc((consent.signed_at || '').replace(' ', ' at '))} UTC for ${esc(lead?.email || '')}. You'll hear back by email — reply to that thread any time to change your mind.</p>
      <div class="terms">${esc(consent.terms)}</div>
    </div>`,
  })
}

export const consentRouter = express.Router()

// Mounted at /agree by server/index.js.
consentRouter.get('/:token', (req, res) => {
  const consent = db.prepare('SELECT * FROM consents WHERE token = ?').get(req.params.token)
  if (!consent) return res.status(404).type('html').send(notFound())
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(consent.lead_id)
  const owner = db.prepare('SELECT name, email FROM users WHERE id = ?').get(consent.user_id)
  res.set('Cache-Control', 'no-store')

  if (consent.status === 'signed') return res.type('html').send(signedPage(consent, lead))
  if (consent.status === 'declined') {
    return res.type('html').send(page({
      title: 'No problem',
      body: `<div class="card"><h1>No problem — nothing recorded.</h1>
        <p class="sub">We've noted that you'd rather not take part, and you won't be chased about it.</p></div>`,
    }))
  }

  const from = [owner?.name, owner?.email && `&lt;${esc(owner.email)}&gt;`].filter(Boolean).join(' ')
  res.type('html').send(page({
    title: 'Confirm you are happy to take part',
    body: `<div class="card">
      <h1>Just confirming</h1>
      <p class="sub">${from ? `${from} asked us to record this.` : 'Please confirm the details below.'} Takes about ten seconds.</p>
      <div class="terms">${esc(consent.terms)}</div>
      <form method="post" action="/agree/${esc(consent.token)}">
        <label for="name">Type your name to confirm</label>
        <input id="name" type="text" name="name" autocomplete="name" required
               placeholder="${esc([lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Your name')}" />
        <div class="actions">
          <button class="yes" type="submit" name="answer" value="agree">Yes, I'm happy to take part</button>
          <button class="no" type="submit" name="answer" value="decline" formnovalidate>No thanks</button>
        </div>
      </form>
    </div>`,
  }))
})

consentRouter.post('/:token', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  const consent = db.prepare('SELECT * FROM consents WHERE token = ?').get(req.params.token)
  if (!consent) return res.status(404).type('html').send(notFound())
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(consent.lead_id)
  res.set('Cache-Control', 'no-store')
  if (consent.status !== 'sent') return res.redirect(303, `/agree/${consent.token}`)

  const who = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.email || ''

  if (req.body?.answer === 'decline') {
    db.prepare("UPDATE consents SET status = 'declined', signed_at = datetime('now') WHERE id = ?").run(consent.id)
    logEvent(consent.user_id, { campaignId: consent.campaign_id, leadId: consent.lead_id, type: 'consent_declined', detail: who })
    notify(consent.user_id, { title: 'Agreement declined', text: `${who} declined the agreement.`, link: '/app/leads' })
    return res.redirect(303, `/agree/${consent.token}`)
  }

  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) return res.redirect(303, `/agree/${consent.token}`)
  db.prepare(
    "UPDATE consents SET status = 'signed', signed_name = ?, signed_at = datetime('now'), signed_ip = ? WHERE id = ?"
  ).run(name, String(req.ip || '').slice(0, 60), consent.id)
  logEvent(consent.user_id, { campaignId: consent.campaign_id, leadId: consent.lead_id, type: 'consent_signed', detail: `${name} agreed` })
  notify(consent.user_id, {
    title: 'Agreement signed',
    text: `${name}${who && who !== name ? ` (${who})` : ''} agreed to take part.`,
    link: '/app/leads',
  })
  res.redirect(303, `/agree/${consent.token}`)
})
