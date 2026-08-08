// The agent's briefing, asked as questions instead of a blank box.
//
// Everything downstream (compose, classify, qualify, research) already reads
// one string — `users.business_context`. So the guided answers are stored as
// JSON on `users.profile` and composed back into that same string here. No
// prompt anywhere else has to know the difference.
//
// Shared by the Settings form and the server, so the questions someone answers
// and the briefing the agent reads can never describe different things.

export const PROFILE_FIELDS = [
  {
    key: 'who',
    label: 'Who is asking',
    hint: 'Your name, role, and why a stranger should take you seriously.',
    placeholder: 'Sam Reid, ops lead at Northwind. 8 years running warehouse teams; doing a business assessment this term.',
  },
  {
    key: 'offer',
    label: 'What you are asking for',
    hint: 'The thing you want from them, and what they get out of it.',
    placeholder: 'A short assessment of their fulfilment process. They get the written findings, free — I need one real business to study.',
  },
  {
    key: 'fit',
    label: 'Who is a good fit',
    hint: 'Business type, size, and the problem they should already have.',
    placeholder: 'Australian ecommerce businesses, 10-100 staff, shipping their own orders and feeling it. Owner or ops lead reachable.',
  },
  {
    key: 'proof',
    label: 'Proof you can point to',
    hint: 'Results, names, numbers, credentials. Optional but it does the heavy lifting.',
    placeholder: 'Cut pick times 30% at Harrow Goods. Cert IV in Logistics. Two prior assessments published.',
  },
  {
    key: 'extra',
    label: 'Anything else',
    hint: 'Constraints, wording to avoid, context the agent should know.',
    placeholder: 'Never promise a discount. Avoid the word "synergy". I am only free Tuesdays and Thursdays.',
  },
]

export const VOICES = [
  { key: 'direct', label: 'Direct', prompt: 'Direct and plain. Short sentences, no filler, no hype.' },
  { key: 'warm', label: 'Warm', prompt: 'Warm and human. Friendly but never chummy or over-familiar.' },
  { key: 'formal', label: 'Formal', prompt: 'Professional and measured. Full sentences, no slang or contractions.' },
]

const isFilled = (value) => typeof value === 'string' && value.trim() !== ''

export function parseProfile(json) {
  try {
    const parsed = JSON.parse(json || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// Which answers are still missing — drives the one-line nudge in Settings.
export function profileGaps(profile) {
  return PROFILE_FIELDS.filter((f) => f.key !== 'extra' && !isFilled(profile?.[f.key])).map((f) => f.label)
}

// Compose the guided answers into the briefing string the agent already reads.
// Returns '' when nothing has been answered, so an empty profile never
// overwrites a briefing someone typed by hand.
export function composeBusinessContext(profile) {
  if (!profile || typeof profile !== 'object') return ''
  const lines = []
  for (const field of PROFILE_FIELDS) {
    if (isFilled(profile[field.key])) lines.push(`${field.label}: ${profile[field.key].trim()}`)
  }
  const voice = VOICES.find((v) => v.key === profile.voice)
  if (voice) lines.push(`Voice: ${voice.prompt}`)
  return lines.join('\n')
}
