// Why a reply might matter more than the one above it.
//
// The Inbox's Important folder was a manual star and nothing else, so a reply
// from a CTO saying "budget approved, send the contract" arrived looking
// exactly like an out-of-office. This scores inbound replies so those two sort
// differently, and — the part that matters — always says why in words.
//
// Three rules the spec is explicit about, and which are easy to lose:
//
//   1. Never a bare number. A score with no reason is an instruction to trust
//      an algorithm nobody can inspect. Every point added here names itself, so
//      the UI can render "Decision-maker title · Buying signal in reply" and a
//      user can disagree with the reasoning rather than just the result.
//
//   2. Missing data lowers confidence; it never raises a score. A lead with no
//      title is not a junior — they are unknown, and unknown scores zero. The
//      alternative is a system that quietly rewards incomplete records.
//
//   3. A person outranks the scorer. Someone who starred a conversation has
//      made a decision, and a later re-score must not unmake it. `applyScore`
//      will set the star but never clear a manual one.
//
// Deliberately heuristic and deterministic: no model call, so it works with no
// API key, produces the same answer twice, and can be unit-tested against the
// exact words rather than against a mood.

// Seniority worth interrupting someone for. Matched on word boundaries so
// "Head of Operations" scores and "Overhead Analyst" does not.
const DECISION_MAKER = [
  /\b(ceo|cto|cfo|coo|cmo|ciso|cio)\b/i,
  /\bchief\b/i,
  /\bfounder|co-?founder\b/i,
  /\b(vp|svp|evp|vice president)\b/i,
  /\bhead of\b/i,
  /\bdirector\b/i,
  /\b(owner|principal|partner|proprietor)\b/i,
  /\bmanaging director\b/i,
]

// Phrases that mean money or a date is in play. Kept narrow on purpose: a
// pattern that fires on "interesting" would mark the whole inbox important and
// the folder would stop being a queue.
const BUYING_SIGNALS = [
  [/\bbudget (is )?(approved|allocated|signed off|available)\b/i, 'Budget mentioned as approved'],
  [/\b(send|share)( me| us)? (a|the) (proposal|quote|contract|sow|pricing)\b/i, 'Asked for a proposal or contract'],
  [/\b(what|how much) (does it|would it|will it) cost\b/i, 'Asked what it costs'],
  [/\b(pricing|price list|rate card)\b/i, 'Asked about pricing'],
  [/\bwhen can we (start|begin|kick off|go live)\b/i, 'Asked when we can start'],
  [/\b(sign|signing) (the )?(contract|agreement|paperwork)\b/i, 'Talking about signing'],
  [/\bprocurement|legal review|security review\b/i, 'Mentioned a buying process'],
  [/\b(book|schedule|set up) (a )?(call|meeting|demo)\b/i, 'Asked to book time'],
  [/\bloop(ing)? in\b|\bintroduce you to\b|\bcc(?:'?ing)? (my|our)\b/i, 'Bringing a colleague in'],
]

// Urgency, which is not the same as intent to buy but does change what you read
// first.
const URGENCY = [
  [/\b(this|next) week\b/i, 'Named a near-term timeframe'],
  [/\burgent|asap|as soon as possible\b/i, 'Said it is urgent'],
  [/\bdeadline\b/i, 'Mentioned a deadline'],
]

// Above this a conversation is starred without anyone asking. One decision-maker
// title alone is not enough — seniority makes a reply worth reading sooner, not
// worth interrupting for. A buying signal on its own is.
export const IMPORTANT_AT = 40

// Score one inbound reply. `lead` may be partial or absent; that costs points
// rather than earning them.
export function scoreReply({ lead = {}, body = '', intent = '' } = {}) {
  const reasons = []
  let score = 0

  const title = String(lead.title || '').trim()
  if (title && DECISION_MAKER.some((re) => re.test(title))) {
    score += 25
    reasons.push('Decision-maker title')
  }

  const text = String(body || '')
  // At most two buying-signal reasons: a reply that trips five patterns is not
  // five times more important, and a wall of reasons is as unreadable as none.
  const signals = BUYING_SIGNALS.filter(([re]) => re.test(text)).slice(0, 2)
  for (const [, reason] of signals) {
    score += 30
    reasons.push(reason)
  }

  const urgent = URGENCY.find(([re]) => re.test(text))
  if (urgent) {
    score += 10
    reasons.push(urgent[1])
  }

  // The classifier's own reading counts for something, but less than what the
  // person actually wrote — it is a guess about the same text.
  if (intent === 'interested') {
    score += 15
    reasons.push('Classified as interested')
  }

  // Explicitly worth nothing: an out-of-office is the noise this folder exists
  // to keep out, however senior the sender.
  if (intent === 'out of office' || intent === 'unsubscribe') {
    return { score: 0, reasons: [] }
  }

  return { score: Math.min(score, 100), reasons }
}

// Store a score against a message, and star it if it clears the bar.
//
// The one rule with teeth: a star a person set is never cleared here. Scoring
// runs again every time a reply is re-read, and a scorer that could un-star
// would silently undo a human decision on a timer — the same defect class as
// the classifier overwriting a corrected intent.
export function applyScore(db, message, { lead = {}, intent = '' } = {}) {
  const { score, reasons } = scoreReply({ lead, body: message.body, intent })

  // `important_by` records who last decided, in either direction. Non-empty
  // means a person has ruled on this conversation, and the scorer defers —
  // both ways. Re-starring something a user deliberately un-starred is the same
  // insult as un-starring something they starred; it just takes longer to
  // notice.
  const decided = Boolean(message.important_by)
  const important = decided ? (message.is_important ? 1 : 0) : (score >= IMPORTANT_AT ? 1 : 0)

  db.prepare(
    'UPDATE messages SET importance_score = ?, importance_reasons = ?, is_important = ? WHERE id = ?'
  ).run(score, JSON.stringify(reasons), important, message.id)

  return { score, reasons, important: Boolean(important), decidedByPerson: decided }
}
