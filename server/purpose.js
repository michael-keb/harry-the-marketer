// Purpose guardrail — deterministic commercial-pitch detector.
//
// A message the product writes may not offer, price, or promote a service when
// the plan's purpose is assessment / experience / role. See
// PURPOSE-GUARDRAIL-PLAN.md. This module is the shared checker used by playbook
// validation (template path) and the post-compose backstop (AI path).
//
// Under purpose `commercial` the guardrail is off — there is nothing to protect.
// Manual Inbox replies typed by a human are out of scope.

export const PURPOSES = ['assessment', 'experience', 'role', 'commercial']

export function isNonCommercial(purpose) {
  return purpose === 'assessment' || purpose === 'experience' || purpose === 'role'
}

// Phrase / pattern list — cheap, always runs, works with no API key.
// Currency is not $-only: £ / € / AUD / "500 dollars" and fee paraphrases too.
const COMMERCIAL_PATTERNS = [
  /\$\s?\d/,
  /£\s?\d/,
  /€\s?\d/,
  /\b(?:aud|usd|gbp|eur|cad|nzd)\s*\$?\s*\d/i,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|pounds?|euros?|bucks)\b/i,
  /\bper\s+hour\b/i,
  /\bhourly\s+rate\b/i,
  /\brate\s+card\b/i,
  /\bmy\s+services?\b/i,
  /\bhire\s+me\b/i,
  /\bfor\s+hire\b/i,
  /\bget\s+a\s+quote\b/i,
  /\brequest\s+a\s+quote\b/i,
  /\bretainer\b/i,
  /\bpackage\s+(deal|pricing|price)\b/i,
  /\bavailable\s+for\s+freelance\b/i,
  /\bday\s+rate\b/i,
  /\bfreelance\s+(services?|work|rates?)\b/i,
  /\bbook\s+a\s+(paid|discovery)\s+call\b/i,
  /\bbuy\s+now\b/i,
  /\bspecial\s+offer\b/i,
  /\blimited[- ]time\s+offer\b/i,
  /\bour\s+pricing\b/i,
  /\bpricing\s+starts\b/i,
  /\bstarting\s+at\s+[\$£€]/i,
  /\bdiscuss\s+my\s+fee\b/i,
  /\bmy\s+fee\b/i,
  /\bwhat\s+i\s+charge\b/i,
  /\bi\s+charge\b/i,
]

/**
 * Deterministic commercial check. Returns { commercial, sentence } where
 * `sentence` quotes the offending line (or the first match) for the human.
 */
export function checkCommercial(text) {
  const raw = String(text || '')
  if (!raw.trim()) return { commercial: false, sentence: '' }
  for (const re of COMMERCIAL_PATTERNS) {
    const m = raw.match(re)
    if (!m) continue
    const idx = m.index ?? 0
    // Pull the surrounding line so the UI can show something readable.
    const lineStart = raw.lastIndexOf('\n', idx) + 1
    const lineEnd = raw.indexOf('\n', idx)
    const sentence = raw.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200)
    return { commercial: true, sentence: sentence || m[0] }
  }
  return { commercial: false, sentence: '' }
}

/**
 * Scan every send-node instruction in a parsed playbook. Returns the first hit
 * so launch can refuse with a named field.
 */
export function playbookCommercialHit(graph) {
  if (!graph?.nodes) return null
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== 'send') continue
    const text = [node.instruction, node.label].filter(Boolean).join('\n')
    const hit = checkCommercial(text)
    if (hit.commercial) {
      return { nodeId: node.id, ...hit }
    }
  }
  return null
}

/**
 * Guard a composed message under a non-commercial purpose. Returns null when
 * the message is fine (or the purpose does not need guarding).
 */
export function guardComposed({ purpose, subject = '', body = '' }) {
  if (!isNonCommercial(purpose)) return null
  const hit = checkCommercial(`${subject}\n${body}`)
  if (!hit.commercial) return null
  return hit
}
