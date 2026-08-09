// Short-form copy for SMS (and later WhatsApp / Telegram). Keeps SMS under a
// practical length; no subject line.

import { composeEmail } from '../ai.js'

const SMS_MAX = 320

function clip(text, max = SMS_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trimEnd()}…`
}

function fillTokens(template, lead, { senderName, meetingLink } = {}) {
  const first = lead.first_name || 'there'
  return String(template || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*company\s*\}\}/gi, lead.company || '')
    .replace(/\{\{\s*sender\s*\}\}/gi, senderName || '')
    .replace(/\{\{\s*meeting_link\s*\}\}/gi, meetingLink || '')
}

/**
 * Compose an SMS body from a Send sms: instruction.
 * Uses the email composer when AI is on, then strips to plain short text;
 * otherwise a deterministic fill of the instruction.
 */
export async function composeSms({
  instruction,
  lead,
  businessContext,
  senderName,
  meetingLink,
  example,
}) {
  const hint = String(instruction || '').trim() || 'Short friendly check-in'
  try {
    const composed = await composeEmail({
      instruction: `Write a single SMS (max ${SMS_MAX} characters, no subject, no greeting block, no sign-off fluff). ${hint}`,
      lead,
      businessContext,
      thread: [],
      senderName,
      meetingLink,
      example: example ? { subject: '', body: example.body || example } : null,
    })
    return { body: clip(composed.body || composed.subject || hint) }
  } catch {
    return {
      body: clip(fillTokens(
        example?.body || `${hint}. — {{sender}}${meetingLink ? ` ${meetingLink}` : ''}`,
        lead,
        { senderName, meetingLink },
      )),
    }
  }
}
