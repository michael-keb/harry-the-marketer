// The AI agent: composes outreach emails and classifies reply intent.
// Uses the Anthropic SDK when a key/profile is available; falls back to a
// deterministic heuristic so the whole platform still works end-to-end without it.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { env } from './env.js'
import { timed } from './telemetry.js'
import { parsePlaybook, pathToNode } from './playbook.js'

let client = null
let openaiClient = null
let lastError = ''

function getClient() {
  if (!client) client = new Anthropic() // resolves ANTHROPIC_API_KEY or an `ant auth login` profile
  return client
}

function getOpenAI() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  return openaiClient
}

// Which provider serves AI calls: explicit AI_PROVIDER wins; auto prefers
// OpenAI when its key is set, then Anthropic; 'none' means heuristics only.
export function aiProvider() {
  if (env.AI_PROVIDER === 'openai') return env.OPENAI_API_KEY ? 'openai' : 'none'
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic'
  if (env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  return 'none'
}

export function aiStatus() {
  const provider = aiProvider()
  return {
    provider,
    configuredKey: provider !== 'none',
    model: provider === 'openai' ? env.OPENAI_MODEL : env.ANTHROPIC_MODEL,
    lastError,
  }
}

// Dispatch to the active provider. Both paths return the model's text output;
// with `schema` set, that text is JSON conforming to the schema.
async function callModel(opts) {
  if (process.env.AI_MODE === 'off') throw new Error('AI disabled (AI_MODE=off)')
  const provider = aiProvider()
  // Telemetry wraps only real provider calls — heuristic-mode fallbacks are
  // expected behavior, not failures worth alerting on.
  if (provider === 'openai') return timed('ai_call', `${opts.op || 'call'} (openai)`, () => callOpenAI(opts))
  if (provider === 'anthropic') return timed('ai_call', `${opts.op || 'call'} (claude)`, () => callClaude(opts))
  throw new Error('no AI provider configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY)')
}

// GPT-5-family reasoning effort from our coarse effort levels: keep the mini
// model fast on routine classify/compose work.
const OPENAI_EFFORT = { low: 'none', medium: 'low', high: 'medium' }

async function callOpenAI({ system, user, maxTokens, effort, schema }) {
  const req = {
    model: env.OPENAI_MODEL,
    max_completion_tokens: Math.max(maxTokens * 4, 2000), // headroom: reasoning tokens count toward the cap
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (/^(gpt-5|o\d)/.test(env.OPENAI_MODEL) && OPENAI_EFFORT[effort]) {
    req.reasoning_effort = OPENAI_EFFORT[effort]
  }
  if (schema) {
    req.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } }
  }
  const response = await getOpenAI().chat.completions.create(req)
  const choice = response.choices?.[0]
  if (!choice?.message?.content) throw new Error(`empty response (finish_reason: ${choice?.finish_reason || 'unknown'})`)
  lastError = ''
  return choice.message.content
}

async function callClaude({ system, user, maxTokens, effort, schema }) {
  const req = {
    model: env.ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort },
    messages: [{ role: 'user', content: user }],
    // Server-side refusal fallback (on by default per Anthropic guidance for Opus 5-class models).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  }
  if (schema) req.output_config.format = { type: 'json_schema', schema }
  const response = await getClient().beta.messages.create(req)
  if (response.stop_reason === 'refusal') throw new Error('model refused the request')
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  lastError = ''
  return text
}

function threadTranscript(thread) {
  return thread
    .map((m) => `--- ${m.direction === 'out' ? 'US' : 'THEM'} (${m.created_at})\nSubject: ${m.subject}\n${m.body}`)
    .join('\n\n')
    .slice(-8000)
}

export function mergeFields(text, lead) {
  return String(text)
    .replaceAll('{{firstName}}', lead.first_name || 'there')
    .replaceAll('{{lastName}}', lead.last_name || '')
    .replaceAll('{{company}}', lead.company || 'your company')
    .replaceAll('{{title}}', lead.title || '')
    .replaceAll('{{email}}', lead.email || '')
}

// ---- compose --------------------------------------------------------------

// Every outbound email has to be able to survive being read aloud to the
// recipient. These rules are not optional and are not exposed as a setting:
// an email that hides what it is asking for costs more replies than it wins.
const HONESTY_RULES =
  `Be straight with the recipient — this is the most important rule here:\n` +
  `- Say plainly, in the first two sentences, who is writing and what you are asking of them.\n` +
  `- Say what taking part actually involves — roughly how much of their time, and what happens next.\n` +
  `- If you reference something about their business, it must come from the research profile or lead data below. Never invent a detail, a mutual contact, a prior conversation, or a referral.\n` +
  `- Never imply the recipient asked to be contacted, signed up, or replied earlier when they did not.\n` +
  `- Make declining easy and cost-free: one short closing line inviting them to say no, in your own words.\n` +
  `- No fake urgency, no invented deadlines, no flattery you cannot back up, no spam trigger words.`

// `example` is copy the user has already read and approved for this step (see
// node_examples). It is a model to follow, not a template to send: the whole
// point of approving it was that it says the right thing, so the composer keeps
// its angle and voice and only moves what has to move for this recipient.
// `refine` is a one-off note ("shorter, lead with the ROI number") from someone
// rewriting a sample by hand, and outranks the instruction where they collide.
export async function composeEmail({ instruction, lead, businessContext, thread, senderName, meetingLink, consentLink, example, refine }) {
  try {
    const text = await callModel({
      system:
        `You write concise, effective B2B outreach emails for Harry the Marketer as ${senderName || 'the sender'}. ` +
        `Business context (who we are, what we sell, our voice):\n${businessContext || '(none provided — keep it generic but professional)'}\n\n` +
        HONESTY_RULES + '\n\n' +
        (example?.body
          ? `The user has approved this exact email as the copy for this step:\n---\nSubject: ${example.subject || '(none)'}\n\n${String(example.body).slice(0, 3000)}\n---\n` +
            `Write this recipient's version of that email. Keep its angle, structure, length and voice. Change only what must change for this lead and the thread so far. Do not add points it does not make.\n`
          : '') +
        (meetingLink ? `When proposing a call or meeting, include this booking link: ${meetingLink}\n` : '') +
        (consentLink
          ? `This person has already said they are interested. Include this link once, near the end, so they can confirm in writing what they are agreeing to: ${consentLink}\n` +
            `Describe it as a short confirmation that takes seconds — never as a contract, and never as a condition of talking.\n`
          : '') +
        `Rules: plain text only. 50-120 words for the body. No placeholders like [Name] — use the lead data given. ` +
        `Personalize from the research profile when one is provided — reference something specific and true. ` +
        `One clear ask. Sign off with the sender's first name only. ` +
        `If there is an existing thread, write a natural continuation and keep the subject as a reply (Re: ...).`,
      user:
        `Lead: ${lead.first_name} ${lead.last_name}, ${lead.title || 'unknown title'} at ${lead.company || 'unknown company'} <${lead.email}>` +
        (lead.notes ? `\nNotes: ${lead.notes}` : '') +
        (lead.research ? `\nResearch profile:\n${String(lead.research).slice(0, 2500)}` : '') +
        (thread?.length ? `\n\nThread so far:\n${threadTranscript(thread)}` : '') +
        `\n\nPlaybook instruction for this email: ${instruction}` +
        (refine ? `\n\nRevision note from the user — apply it over the instruction wherever the two disagree: ${String(refine).slice(0, 600)}` : '') +
        `\n\nWrite the email now.`,
      op: 'compose',
      maxTokens: 1024,
      effort: 'medium',
      schema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Email subject line. For replies, reuse the thread subject with Re: prefix.' },
          body: { type: 'string', description: 'Plain-text email body.' },
        },
        required: ['subject', 'body'],
        additionalProperties: false,
      },
    })
    const parsed = JSON.parse(text)
    if (parsed.subject && parsed.body) return { ...parsed, via: 'ai' }
    throw new Error('missing fields in AI response')
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] compose fell back to template:', lastError)
    return { ...templateCompose({ instruction, lead, thread, senderName, consentLink }), via: 'template' }
  }
}

function templateCompose({ instruction, lead, thread, senderName, consentLink }) {
  const firstName = lead.first_name || 'there'
  const prevSubject = thread?.length ? thread[thread.length - 1].subject : ''
  const subject = prevSubject
    ? (prevSubject.startsWith('Re:') ? prevSubject : `Re: ${prevSubject}`)
    : mergeFields(instruction, lead).slice(0, 78) || `Quick question, ${firstName}`
  const body =
    `Hi ${firstName},\n\n${mergeFields(instruction, lead)}\n\n` +
    (consentLink ? `When you have a moment, this link confirms what you're agreeing to — it takes seconds:\n${consentLink}\n\n` : '') +
    `Would it make sense to have a quick chat? If it's not for you, just say so and I'll leave it there.\n\n` +
    `Best,\n${(senderName || 'The team').split(' ')[0]}`
  return { subject, body }
}

// ---- classify -------------------------------------------------------------

// Baseline intents the engine always understands, beyond the campaign's own edge labels.
export const CORE_INTENTS = ['interested', 'not interested', 'not now', 'question', 'unsubscribe', 'out of office', 'other']

// The part of a reply the sender actually typed, with the quoted history cut
// off. Every outbound email carries the "Unsubscribe here:" footer, and mail
// clients quote the original below the reply — so classifying the full body
// means every reply "contains" the word unsubscribe and the keyword heuristic
// opts the lead out of a conversation they just joined. Classification must
// only ever read the fresh text; the thread transcript is passed separately
// for context.
const QUOTE_MARKERS = [
  /\bOn [\s\S]{5,300}? wrote:/, // Gmail/Apple Mail attribution, tolerating a wrapped line
  /^\s*-{2,}\s*Original Message\s*-{2,}/im, // Outlook classic
  /^\s*-{2,}\s*Forwarded message\s*-{2,}/im,
  /^From:\s.+$/m, // Outlook top-post header block
  /^>+/m, // any quoted line
  /^--\s*$/m, // signature delimiter
  /^_{10,}\s*$/m, // Outlook divider
  /^Sent from my /im,
]

export function freshReplyText(body) {
  const text = String(body || '')
  let cut = text.length
  for (const marker of QUOTE_MARKERS) {
    const idx = text.search(marker)
    if (idx !== -1 && idx < cut) cut = idx
  }
  const fresh = text.slice(0, cut).trim()
  // A reply that is nothing but quoted text (or an unrecognised layout) falls
  // back to the full body — worse input, but never an empty classification.
  return fresh || text
}

export async function classifyReply({ intents, replyText, thread, businessContext }) {
  const vocabulary = [...new Set([...(intents || []), ...CORE_INTENTS])]
  const fresh = freshReplyText(replyText)
  const heuristic = heuristicClassify(fresh, vocabulary)
  // Unsubscribe requests are honored regardless of what the model would say.
  if (heuristic.intent === 'unsubscribe' && heuristic.confidence >= 0.9) return { ...heuristic, via: 'heuristic' }
  try {
    const text = await callModel({
      system:
        `You classify replies to B2B outreach emails by intent so Harry the Marketer can route them. ` +
        `Business context: ${businessContext || '(none)'}. ` +
        `Pick exactly one intent from the allowed list. "other" means none fit well and a human should look.`,
      user:
        (thread?.length ? `Thread so far:\n${threadTranscript(thread)}\n\n` : '') +
        `Reply to classify (quoted history removed):\n"""\n${fresh.slice(0, 4000)}\n"""\n\nAllowed intents: ${vocabulary.join(' | ')}`,
      op: 'classify',
      maxTokens: 256,
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: vocabulary },
          reasoning: { type: 'string', description: 'One short sentence.' },
        },
        required: ['intent', 'reasoning'],
        additionalProperties: false,
      },
    })
    const parsed = JSON.parse(text)
    if (vocabulary.includes(parsed.intent)) return { intent: parsed.intent, reasoning: parsed.reasoning, via: 'ai' }
    throw new Error(`intent "${parsed.intent}" not in vocabulary`)
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] classify fell back to heuristic:', lastError)
    return { ...heuristic, via: 'heuristic' }
  }
}

// ---- company research agent -----------------------------------------------
// Uses Claude's server-side web search to build a knowledge profile for a lead.
// Requires an API key; without one it returns null (the UI says so honestly).

export async function researchLead({ lead, businessContext }) {
  if (process.env.AI_MODE === 'off') return null
  if (aiProvider() === 'none') return null
  if (aiProvider() === 'openai') {
    try {
      const response = await timed('ai_call', 'research (openai)', () => getOpenAI().responses.create({
        model: env.OPENAI_MODEL,
        tools: [{ type: 'web_search' }],
        instructions:
          `You are a company research agent for Harry the Marketer, an outreach platform. Business context of the sender: ` +
          `${businessContext || '(none)'}. Be factual and brief; never fabricate specifics.`,
        input:
          `Research this B2B lead and produce a compact knowledge profile for outreach personalization.\n` +
          `Lead: ${lead.first_name} ${lead.last_name}, ${lead.title || 'unknown title'} at ${lead.company || 'unknown company'} <${lead.email}>\n` +
          (lead.notes ? `Existing notes: ${lead.notes}\n` : '') +
          `\nSearch the web for the company (site, news, hiring, tech signals). Then write the profile in this exact plain-text shape:\n` +
          `Company: ...\nSituation: ...\nLikely pain: ...\nTrigger: ...\nOpportunity: ...\nPersonalization hooks: 2-3 bullets.\n` +
          `If you cannot find reliable information, say what is unknown rather than inventing it.`,
      }))
      const text = (response.output_text || '').trim()
      lastError = ''
      return text || null
    } catch (err) {
      lastError = String(err.message || err)
      console.warn('[ai] research (openai) failed:', lastError)
      return null
    }
  }
  try {
    const text = await timed('ai_call', 'research (claude)', async () => {
      let messages = [{
        role: 'user',
        content:
          `Research this B2B lead and produce a compact knowledge profile for outreach personalization.\n` +
          `Lead: ${lead.first_name} ${lead.last_name}, ${lead.title || 'unknown title'} at ${lead.company || 'unknown company'} <${lead.email}>\n` +
          (lead.notes ? `Existing notes: ${lead.notes}\n` : '') +
          `\nSearch the web for the company (site, news, hiring, tech signals). Then write the profile in this exact plain-text shape:\n` +
          `Company: ...\nSituation: ...\nLikely pain: ...\nTrigger: ...\nOpportunity: ...\nPersonalization hooks: 2-3 bullets.\n` +
          `If you cannot find reliable information, say what is unknown rather than inventing it.`,
      }]
      let response = await getClient().beta.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 2000,
        system:
          `You are a company research agent for Harry the Marketer, an outreach platform. Business context of the sender: ` +
          `${businessContext || '(none)'}. Be factual and brief; never fabricate specifics.`,
        messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      // Server-tool loops can pause; continue once to let the search finish.
      if (response.stop_reason === 'pause_turn') {
        messages = [...messages, { role: 'assistant', content: response.content }]
        response = await getClient().beta.messages.create({
          model: env.ANTHROPIC_MODEL, max_tokens: 2000, messages,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        })
      }
      if (response.stop_reason === 'refusal') throw new Error('model refused the request')
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    })
    lastError = ''
    return text || null
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] research failed:', lastError)
    return null
  }
}

// ---- revenue goal planning ------------------------------------------------
// "Give the AI a revenue outcome" → structured plan: name, target, ICP, playbook.

const ICP_SCHEMA = {
  type: 'object',
  properties: {
    industries: { type: 'array', items: { type: 'string' } },
    locations: { type: 'array', items: { type: 'string' } },
    titles: { type: 'array', items: { type: 'string' }, description: 'Job titles worth contacting' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Technologies, signals, or phrases that indicate fit' },
    summary: { type: 'string', description: 'One sentence describing the ideal customer' },
  },
  required: ['industries', 'locations', 'titles', 'keywords', 'summary'],
  additionalProperties: false,
}

export async function planGoal({ description, businessContext }) {
  const fallback = heuristicPlanGoal(description)
  try {
    const text = await callModel({
      system:
        `You turn a plain-English revenue outcome into a structured go-to-market plan for Harry the Marketer. ` +
        `Business context: ${businessContext || '(none)'}. ` +
        `The playbook you write is instructions for send steps only — Harry the Marketer assembles the flowchart itself.`,
      user:
        `Revenue outcome: """${String(description).slice(0, 1000)}"""\n\n` +
        `Extract the plan. target = the number of won outcomes asked for (meetings, deals, customers); default 10 if unstated.`,
      op: 'plan goal',
      maxTokens: 1200,
      effort: 'medium',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short campaign-style name for this goal' },
          target: { type: 'integer' },
          icp: ICP_SCHEMA,
          introInstruction: { type: 'string', description: 'What the first email should say (angle, not copy)' },
          followupInstruction: { type: 'string', description: 'Angle for the follow-up email' },
          breakupInstruction: { type: 'string', description: 'Angle for the final check-in email' },
        },
        required: ['name', 'target', 'icp', 'introInstruction', 'followupInstruction', 'breakupInstruction'],
        additionalProperties: false,
      },
    })
    const plan = JSON.parse(text)
    if (!plan.name || !plan.target) throw new Error('incomplete plan')
    plan.target = Math.max(1, Math.min(10000, Math.round(plan.target)))
    return { ...plan, via: 'ai' }
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] goal planning fell back to heuristic:', lastError)
    return { ...fallback, via: 'heuristic' }
  }
}

export function heuristicPlanGoal(description) {
  const text = String(description)
  const targetMatch = text.match(/(\d+)\s*(?:qualified\s+)?(?:meetings?|calls?|demos?|deals?|customers?|wins?|bookings?)/i)
    || text.match(/(\d+)/)
  const target = targetMatch ? Math.max(1, Math.min(10000, Number(targetMatch[1]))) : 10
  const stop = new Set(['generate', 'qualified', 'meetings', 'meeting', 'with', 'that', 'the', 'and', 'for', 'companies', 'company', 'using', 'want', 'need', 'book', 'get', 'find', 'staff', 'employees', 'people', 'per', 'month', 'week'])
  const keywords = [...new Set(
    text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w))
  )].slice(0, 12)
  return {
    name: text.slice(0, 60).trim() || 'Revenue goal',
    target,
    icp: { industries: [], locations: [], titles: [], keywords, summary: text.slice(0, 200) },
    introInstruction: `short intro tailored to this outcome: ${text.slice(0, 140)}`,
    followupInstruction: 'short follow-up with one concrete proof point and one question',
    breakupInstruction: 'polite last check-in, close the loop, leave the door open',
  }
}

// Assemble a proven playbook shape around the AI's angle instructions.
export function goalPlaybook(plan) {
  const esc = (s) => String(s).replace(/[[\]{}()"|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return `flowchart TD
    S([Start]) --> A[Send: ${esc(plan.introInstruction)}]
    A -- reply: interested --> B[Send: thanks and propose a 20-minute call this week, offer two time slots]
    A -- reply: question --> Q[Send: answer their question directly, then ask if a quick call makes sense]
    A -- reply: not now --> N[Wait: 30d]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 3d --> F[Send: ${esc(plan.followupInstruction)}]
    F -- reply: interested --> B
    F -- reply: unsubscribe --> U
    F -- no reply 4d --> G[Send: ${esc(plan.breakupInstruction)}]
    G -- reply: interested --> B
    G -- no reply 5d --> L([Lost: no response])
    N --> A2[Send: re-engage, reference their earlier reply and share what is new]
    A2 -- reply: interested --> B
    A2 -- no reply 5d --> L
    B -- reply --> W([Won: meeting booked])
    B -- no reply 3d --> G
    Q -- reply: interested --> B
    Q -- no reply 4d --> F
`
}

// ---- AI playbook generation ------------------------------------------------
// Generate a full Mermaid playbook from a brief (and the campaign's linked
// goal, when there is one). The result is validated; if the model's diagram
// does not parse, we fall back to assembling a proven shape from its angles.

export async function generatePlaybook({ brief, goal, businessContext }) {
  const goalContext = goal
    ? `\nThis campaign is linked to a revenue goal: "${goal.description}" (target: ${goal.target} won). ICP: ${goal.icp || '{}'}.`
    : ''
  try {
    const text = await callModel({
      system:
        `You design outreach playbooks as Mermaid flowcharts for Harry the Marketer. Business context: ${businessContext || '(none)'}.` +
        `\nStrict syntax rules — the engine parses this, so follow them exactly:` +
        `\n- Start: S([Start]) exactly once` +
        `\n- Send steps: ID[Send: instruction for the email agent]` +
        `\n- Waits: ID[Wait: 30d]` +
        `\n- Terminals: ID([Won: ...]), ID([Lost: ...]), ID([Unsubscribed])` +
        `\n- Edges: A -- reply: intent --> B | A -- reply --> B | A -- no reply 3d --> B | plain A --> B` +
        `\n- Never use characters [ ] { } ( ) " | inside node labels or instructions` +
        `\n- Every send that waits for replies needs a "no reply Xd" escape; always include an unsubscribe path` +
        `\n- 6-12 nodes total. First line must be: flowchart TD`,
      user:
        `Design a playbook for this brief:\n"""${String(brief || 'an effective cold outreach sequence for our ICP')}"""${goalContext}\n\n` +
        `Return the complete Mermaid flowchart.`,
      op: 'generate playbook',
      maxTokens: 1500,
      effort: 'medium',
      schema: {
        type: 'object',
        properties: { mermaid: { type: 'string', description: 'The complete Mermaid flowchart, starting with "flowchart TD"' } },
        required: ['mermaid'],
        additionalProperties: false,
      },
    })
    const { mermaid } = JSON.parse(text)
    const graph = parsePlaybook(mermaid)
    if (graph.valid) return { mermaid, via: 'ai', warnings: graph.warnings }
    lastError = `generated diagram invalid: ${graph.errors[0]?.message || ''}`
    console.warn('[ai] generated playbook failed validation, assembling from plan instead:', lastError)
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] playbook generation failed:', lastError)
  }
  // Assemble a guaranteed-valid playbook from planned angles instead.
  const plan = goal
    ? { ...heuristicPlanGoal(goal.description), name: goal.name }
    : heuristicPlanGoal(String(brief || 'cold outreach'))
  return { mermaid: goalPlaybook(plan), via: 'assembled', warnings: [] }
}

// ---- sample messages for a playbook ---------------------------------------
// A diagram tells you the shape of a campaign but not what it says. This walks
// the graph and writes one real sample email per Send step — same agent, same
// prompts, same business context as the live send — so the diagram can be read
// as the emails it will actually produce before a single one goes out.

const MAX_PREVIEW_NODES = 10

// What a lead "said" on a reply edge, so a follow-up sample reads like a reply.
const SAMPLE_REPLIES = {
  interested: 'This sounds interesting — tell me more. Happy to jump on a call.',
  question: 'How does this work alongside what we already have in place?',
  'not now': "Not right now — we're mid-quarter. Maybe circle back later.",
  'not interested': "Thanks, but this isn't for us.",
  unsubscribe: 'Please take me off this list.',
  'out of office': "I'm away until next week with limited access to email.",
}

export function sampleReply(intent) {
  if (!intent) return 'Thanks for reaching out — happy to hear more.'
  return SAMPLE_REPLIES[intent] || `Thanks for the note — ${intent}.`
}

// A stand-in recipient when the campaign has no leads attached yet. Shaped from
// the goal's ICP when there is one so the sample lands near the real audience.
export function exampleLead(icp) {
  const title = icp?.titles?.[0] || 'Head of Operations'
  const industry = icp?.industries?.[0] || ''
  return {
    id: null,
    first_name: 'Alex',
    last_name: 'Moreau',
    title,
    company: 'Northwind Logistics',
    email: 'alex.moreau@example.com',
    notes: `Example recipient used for previewing this playbook — not a real person.${industry ? ` Industry: ${industry}.` : ''}`,
    research: '',
  }
}

// A node in a sentence: its id plus enough of its label to recognise it.
function stepName(graph, id) {
  const label = (graph.nodes[id]?.label || id).replace(/^(send|wait)\s*:?\s*/i, '')
  return `${id} ("${label.length > 52 ? `${label.slice(0, 52).trimEnd()}…` : label}")`
}

// One line saying when this email goes out, in the reader's language.
function triggerLine(graph, path) {
  const last = path[path.length - 1]
  if (!last || last.from === graph.startId) return 'First email — sent as soon as the lead enters the campaign.'
  const from = stepName(graph, last.from)
  const wait = path.filter((e) => graph.nodes[e.from]?.type === 'wait')
  const waited = wait.length ? ` Waits ${graph.nodes[wait[wait.length - 1].from].label.replace(/^wait\s*:?\s*/i, '')} first.` : ''
  if (last.cond.kind === 'reply') {
    return last.cond.intent
      ? `After step ${from} — they replied and the agent read it as "${last.cond.intent}".${waited}`
      : `After step ${from} — they replied.${waited}`
  }
  if (last.cond.kind === 'no_reply') return `After step ${from} — no reply for ${last.cond.raw.replace(/^no\s*reply\s*/i, '')}.${waited}`
  if (last.cond.kind === 'after') return `${last.cond.raw} after step ${from}.${waited}`
  return `Straight after step ${from}.${waited}`
}

// The thread a lead would be holding when this step fires: every earlier sample
// email on this route, plus the replies the route's own edge labels imply.
function threadForPath(graph, path, composedByNode) {
  const thread = []
  for (const edge of path) {
    const from = graph.nodes[edge.from]
    const sample = composedByNode.get(edge.from)
    if (from?.type === 'send' && sample) {
      thread.push({ direction: 'out', subject: sample.subject, body: sample.body, created_at: 'earlier' })
    }
    if (edge.cond.kind === 'reply') {
      thread.push({
        direction: 'in',
        subject: `Re: ${sample?.subject || 'your email'}`,
        body: sampleReply(edge.cond.intent),
        created_at: 'earlier',
      })
    }
  }
  return thread
}

// Everything about a step that the diagram alone decides — known before any
// model call, and identical whether the copy is written now or was approved
// weeks ago. `dependsOn` lists the earlier Send steps this one quotes, so a
// reader who rewrites an email upstream can be told which samples below it are
// now answering an older draft.
function stepFacts(graph, node, path) {
  return {
    nodeId: node.id,
    label: node.label,
    instruction: node.instruction || node.label,
    trigger: triggerLine(graph, path),
    // Once a lead has said yes, live emails carry the agreement link — the
    // sample says so rather than quietly showing a shorter email.
    carriesAgreementLink: path.some((e) => e.cond.kind === 'reply' && e.cond.intent === 'interested'),
    dependsOn: path.map((e) => e.from).filter((id) => graph.nodes[id]?.type === 'send'),
  }
}

// `onPlan` fires once, before any model call, with everything that can be known
// from the diagram alone — so the reader sees the shape of the answer
// immediately. `onSample` then fires per step, in the order they are displayed,
// as each one finishes writing. Both are optional; without them this behaves
// exactly as it always did.
//
// `examples` maps a node id to copy the reader has already approved for that
// step. Approved copy is shown exactly as it stands: rewriting it would hide
// the edit they made, and pay for a model call to do it.
export async function previewPlaybookEmails({ graph, lead, businessContext, senderName, meetingLink, examples = {}, onPlan, onSample }) {
  const steps = Object.values(graph.nodes)
    .filter((n) => n.type === 'send')
    .map((n) => ({ node: n, path: pathToNode(graph, n.id) }))
    .filter((s) => s.path !== null)
    .sort((a, b) => a.path.length - b.path.length)

  const truncated = Math.max(0, steps.length - MAX_PREVIEW_NODES)
  const shown = steps.slice(0, MAX_PREVIEW_NODES)

  onPlan?.({
    totalSendSteps: steps.length,
    truncated,
    steps: shown.map(({ node, path }) => ({
      ...stepFacts(graph, node, path),
      saved: Boolean(examples[node.id]?.body), // nothing to wait for on these
    })),
  })

  // Compose depth by depth: a step's sample quotes the samples above it, and
  // everything at the same depth is independent, so those go out together.
  const composedByNode = new Map()
  const samples = []
  const depths = [...new Set(shown.map((s) => s.path.length))].sort((a, b) => a - b)
  for (const depth of depths) {
    const level = shown.filter((s) => s.path.length === depth)
    const written = await Promise.all(level.map(async ({ node, path }) => {
      const thread = threadForPath(graph, path, composedByNode)
      const saved = examples[node.id]
      const composed = saved?.body
        ? { subject: saved.subject, body: saved.body, via: 'saved' }
        : await composeEmail({
          instruction: node.instruction || node.label,
          lead,
          businessContext,
          thread,
          senderName,
          meetingLink,
          consentLink: '',
        })
      return { node, path, composed, thread }
    }))
    for (const { node, path, composed, thread } of written) {
      composedByNode.set(node.id, composed)
      const sample = {
        ...stepFacts(graph, node, path),
        threadLength: thread.length,
        subject: composed.subject,
        body: composed.body,
        via: composed.via,
      }
      samples.push(sample)
      onSample?.(sample)
    }
  }
  // Depths run in ascending order and each level keeps `shown`'s order, so
  // `samples` is already the order the graph reads — and so is the order
  // onSample fired in. The sort is a cheap guard, not the mechanism.
  const order = shown.map((s) => s.node.id)
  samples.sort((a, b) => order.indexOf(a.nodeId) - order.indexOf(b.nodeId))
  return { samples, truncated, totalSendSteps: steps.length }
}

// Rewrite one step, so a sample can be tailored without paying to regenerate
// the whole sequence around it.
//
// `priorSamples` is what is currently on screen above this step, so the rewrite
// answers the emails the reader is actually looking at — including any they
// edited by hand — rather than a fresh set nobody has seen. An edited
// instruction reaches this through `graph`: the caller writes it back into the
// diagram first, so there is never a prompt in play that the diagram does not
// show. `refine` is a one-off note about this attempt ("shorter, drop the case
// study"); `basedOn` is the copy on screen, passed when the note is meant to
// revise it rather than start over.
export async function composeStepSample({
  graph, nodeId, lead, businessContext, senderName, meetingLink,
  priorSamples = {}, refine, basedOn,
}) {
  const node = graph.nodes[nodeId]
  if (!node || node.type !== 'send') throw new Error(`"${nodeId}" is not a Send step in this playbook`)
  const path = pathToNode(graph, nodeId)
  if (!path) throw new Error(`"${nodeId}" cannot be reached from Start`)

  const thread = threadForPath(graph, path, new Map(Object.entries(priorSamples)))
  const composed = await composeEmail({
    instruction: node.instruction || node.label,
    lead,
    businessContext,
    thread,
    senderName,
    meetingLink,
    consentLink: '',
    example: basedOn?.body ? basedOn : null,
    refine,
  })
  return {
    ...stepFacts(graph, node, path),
    threadLength: thread.length,
    subject: composed.subject,
    body: composed.body,
    via: composed.via,
  }
}

// ---- AI qualification -----------------------------------------------------

export async function qualifyLead({ lead, icp, businessContext }) {
  const fallback = heuristicQualify(lead, icp)
  try {
    const text = await callModel({
      system:
        `You qualify B2B leads against an ideal customer profile for Harry the Marketer. ` +
        `Business context: ${businessContext || '(none)'}. Be honest: unknown fields lower confidence, they do not disqualify.`,
      user:
        `ICP: ${JSON.stringify(icp)}\n\nLead: ${JSON.stringify({
          email: lead.email, firstName: lead.first_name, lastName: lead.last_name,
          company: lead.company, title: lead.title, notes: lead.notes,
        })}\n\nScore this lead 0-100 and explain.`,
      op: 'qualify',
      maxTokens: 512,
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          fit: { type: 'integer', description: '0-100' },
          reasons: { type: 'array', items: { type: 'string' }, description: '2-4 short reasons, plain language' },
        },
        required: ['fit', 'reasons'],
        additionalProperties: false,
      },
    })
    const parsed = JSON.parse(text)
    const fit = Math.max(0, Math.min(100, Math.round(parsed.fit)))
    return { fit, reasons: (parsed.reasons || []).slice(0, 5), via: 'ai' }
  } catch (err) {
    lastError = String(err.message || err)
    console.warn('[ai] qualification fell back to heuristic:', lastError)
    return { ...fallback, via: 'heuristic' }
  }
}

export function heuristicQualify(lead, icp) {
  const haystack = [lead.company, lead.title, lead.notes, lead.email].join(' ').toLowerCase()
  const reasons = []
  let fit = 40 // neutral base: reachable lead with an email address
  const hit = (list, label) => {
    const matches = (list || []).filter((k) => k && haystack.includes(String(k).toLowerCase()))
    if (matches.length) {
      fit += Math.min(30, matches.length * 12)
      reasons.push(`${label}: ${matches.slice(0, 3).join(', ')}`)
    }
    return matches.length
  }
  hit(icp.keywords, 'Matches signals')
  hit(icp.industries, 'Industry match')
  hit(icp.locations, 'Location match')
  const titleHits = hit(icp.titles, 'Title match')
  if (!titleHits && lead.title) {
    if (/head|director|vp|chief|founder|ceo|coo|cto|manager|lead/i.test(lead.title)) {
      fit += 8
      reasons.push(`Decision-maker title: ${lead.title}`)
    }
  }
  if (lead.notes) { fit += 5; reasons.push('Has research notes for personalization') }
  if (!lead.company) { fit -= 10; reasons.push('Company unknown') }
  fit = Math.max(0, Math.min(100, fit))
  if (!reasons.length) reasons.push('No ICP signals found in the lead data')
  return { fit, reasons }
}

export function heuristicClassify(replyText, vocabulary) {
  const text = String(replyText).toLowerCase()
  const has = (...words) => words.some((w) => text.includes(w))
  let intent = 'other'
  let confidence = 0.4
  if (has('unsubscribe', 'remove me', 'stop emailing', 'take me off', 'opt out', 'opt-out')) {
    intent = 'unsubscribe'; confidence = 0.95
  } else if (has('out of office', 'ooo', 'annual leave', 'on vacation', 'parental leave', 'auto-reply', 'automatic reply')) {
    intent = 'out of office'; confidence = 0.9
  } else if (has('not interested', 'no thanks', 'no thank', "don't need", 'we already have', 'pass on this')) {
    intent = 'not interested'; confidence = 0.8
  } else if (has('not right now', 'not now', 'maybe later', 'next quarter', 'circle back', 'reach out in', 'busy at the moment')) {
    intent = 'not now'; confidence = 0.75
  } else if (has('interested', 'sounds good', 'tell me more', "let's talk", 'book a call', 'schedule', 'demo', 'happy to chat', 'send me more', 'yes please', 'sure,')) {
    intent = 'interested'; confidence = 0.8
  } else if (text.includes('?')) {
    intent = 'question'; confidence = 0.6
  }
  if (!vocabulary.includes(intent)) intent = 'other'
  return { intent, confidence, reasoning: 'keyword heuristic' }
}
