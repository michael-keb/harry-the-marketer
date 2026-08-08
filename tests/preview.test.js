// Sample emails for a playbook: one per Send step, with the thread and reply
// that would have come before it. AI_MODE=off keeps this deterministic — the
// composer falls back to templates, which is exactly what a keyless install sends.
process.env.AI_MODE = 'off'

import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlaybook, pathToNode, DEFAULT_PLAYBOOK } from '../server/playbook.js'
import { previewPlaybookEmails, composeStepSample, exampleLead, sampleReply } from '../server/ai.js'
import { setSendInstruction, sanitizeInstruction, applyInstructions } from '../shared/playbook-edit.js'

const LEAD = {
  first_name: 'Alex', last_name: 'Moreau', title: 'Head of Ops',
  company: 'Northwind', email: 'alex@northwind.example', notes: '', research: '',
}

test('pathToNode walks the shortest route from Start', () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  assert.deepEqual(pathToNode(g, 'S'), [])
  assert.deepEqual(pathToNode(g, 'A').map((e) => e.to), ['A'])

  const toFollowUp = pathToNode(g, 'F')
  assert.deepEqual(toFollowUp.map((e) => e.to), ['A', 'F'])
  assert.equal(toFollowUp[1].cond.kind, 'no_reply')

  const toBooking = pathToNode(g, 'B')
  assert.equal(toBooking[toBooking.length - 1].cond.intent, 'interested')
})

test('pathToNode returns null for an unreachable node', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: intro]
    A -- no reply 3d --> L([Lost])
    Z[Send: orphan] --> L
  `)
  assert.equal(pathToNode(g, 'Z'), null)
})

test('every send step gets a sample, in diagram order', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  const { samples, truncated, totalSendSteps } = await previewPlaybookEmails({
    graph: g, lead: LEAD, businessContext: 'We sell reporting software.', senderName: 'Harry Smith',
  })
  const sendIds = Object.values(g.nodes).filter((n) => n.type === 'send').map((n) => n.id)
  assert.equal(totalSendSteps, sendIds.length)
  assert.equal(truncated, 0)
  assert.equal(samples.length, sendIds.length)
  for (const s of samples) {
    assert.ok(s.subject, `${s.nodeId} has a subject`)
    assert.ok(s.body.includes('Alex'), `${s.nodeId} is addressed to the lead`)
    assert.ok(s.body.includes('Harry'), `${s.nodeId} is signed by the sender`)
    assert.equal(s.via, 'template') // AI_MODE=off
  }
  // The first email is first, and it is the one with no thread behind it.
  assert.equal(samples[0].nodeId, 'A')
  assert.equal(samples[0].threadLength, 0)
  assert.match(samples[0].trigger, /First email/)
})

test('later steps read as replies to the earlier ones', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  const { samples } = await previewPlaybookEmails({ graph: g, lead: LEAD, senderName: 'Harry' })
  const byId = Object.fromEntries(samples.map((s) => [s.nodeId, s]))

  // F fires after silence: intro sent, no reply, so one message behind it.
  assert.equal(byId.F.threadLength, 1)
  assert.match(byId.F.trigger, /no reply for 3d/i)
  assert.match(byId.F.subject, /^Re:/)

  // B fires after they say yes: intro + their reply behind it.
  assert.equal(byId.B.threadLength, 2)
  assert.match(byId.B.trigger, /interested/)
  assert.equal(byId.B.carriesAgreementLink, true)
  assert.equal(byId.F.carriesAgreementLink, false)
})

test('sample replies cover the core intents and fall back for custom ones', () => {
  assert.match(sampleReply('interested'), /call/i)
  assert.match(sampleReply('unsubscribe'), /off this list/i)
  assert.match(sampleReply('wants pricing'), /wants pricing/)
})

test('example lead is shaped by the ICP when there is one', () => {
  assert.equal(exampleLead(null).title, 'Head of Operations')
  const shaped = exampleLead({ titles: ['VP Supply Chain'], industries: ['3PL'] })
  assert.equal(shaped.title, 'VP Supply Chain')
  assert.match(shaped.notes, /3PL/)
})

test('a step names the earlier send steps its thread quotes', async () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: intro]
    A -- no reply 3d --> F[Send: follow up]
    F -- no reply 4d --> G[Send: last check-in]
    G -- no reply 5d --> L([Lost])
  `)
  const { samples } = await previewPlaybookEmails({ graph: g, lead: LEAD, senderName: 'Harry' })
  const byId = Object.fromEntries(samples.map((s) => [s.nodeId, s]))
  assert.deepEqual(byId.A.dependsOn, [])
  assert.deepEqual(byId.F.dependsOn, ['A'])
  assert.deepEqual(byId.G.dependsOn, ['A', 'F'])

  // The wait node on a route is not something a rewrite can invalidate.
  const withWait = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: intro]
    A -- no reply 3d --> W[Wait: 2d]
    W --> F[Send: follow up]
  `)
  const later = await previewPlaybookEmails({ graph: withWait, lead: LEAD, senderName: 'Harry' })
  assert.deepEqual(later.samples.find((s) => s.nodeId === 'F').dependsOn, ['A'])
})

test('approved copy is shown as it stands, and the thread below it quotes it', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  const examples = { A: { subject: 'A subject I wrote myself', body: 'Hi Alex, the exact words I approved.' } }
  const { samples } = await previewPlaybookEmails({ graph: g, lead: LEAD, senderName: 'Harry', examples })
  const byId = Object.fromEntries(samples.map((s) => [s.nodeId, s]))

  assert.equal(byId.A.via, 'saved')
  assert.equal(byId.A.subject, examples.A.subject)
  assert.equal(byId.A.body, examples.A.body)
  // The follow-up is still written, and it answers the approved email.
  assert.equal(byId.F.via, 'template')
  assert.equal(byId.F.subject, 'Re: A subject I wrote myself')
})

test('the plan says up front which steps need no writing', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  let plan = null
  await previewPlaybookEmails({
    graph: g, lead: LEAD, senderName: 'Harry',
    examples: { A: { subject: 'Mine', body: 'Mine.' } },
    onPlan: (p) => { plan = p },
  })
  const saved = plan.steps.filter((s) => s.saved).map((s) => s.nodeId)
  assert.deepEqual(saved, ['A'])
})

test('one step can be rewritten against the samples already on screen', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  const sample = await composeStepSample({
    graph: g,
    nodeId: 'F',
    lead: LEAD,
    senderName: 'Harry',
    priorSamples: { A: { subject: 'The intro as edited by hand', body: 'Hi Alex, my own words.' } },
  })
  assert.equal(sample.nodeId, 'F')
  assert.equal(sample.threadLength, 1)
  assert.equal(sample.subject, 'Re: The intro as edited by hand')
  assert.match(sample.trigger, /no reply for 3d/i)
})

test('rewriting refuses steps that are not reachable send nodes', async () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  await assert.rejects(() => composeStepSample({ graph: g, nodeId: 'N', lead: LEAD }), /not a Send step/)
  await assert.rejects(() => composeStepSample({ graph: g, nodeId: 'nope', lead: LEAD }), /not a Send step/)

  const orphaned = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: intro]
    A -- no reply 3d --> L([Lost])
    Z[Send: orphan] --> L
  `)
  await assert.rejects(() => composeStepSample({ graph: orphaned, nodeId: 'Z', lead: LEAD }), /cannot be reached/)
})

test('editing a step instruction writes it back into the diagram', () => {
  const next = setSendInstruction(DEFAULT_PLAYBOOK, 'F', 'one new proof point and a single question')
  assert.match(next, /F\[Send: one new proof point and a single question\]/)
  const g = parsePlaybook(next)
  assert.equal(g.valid, true)
  assert.equal(g.nodes.F.instruction, 'one new proof point and a single question')
  // Only the definition moves — the bare `F` on the edge lines below it stays.
  assert.equal((next.match(/F -- reply: interested --> B/g) || []).length, 1)
  assert.equal(g.nodes.A.instruction, parsePlaybook(DEFAULT_PLAYBOOK).nodes.A.instruction)
})

test('instructions that would break the diagram are flattened, not written raw', () => {
  assert.equal(sanitizeInstruction('ask about their [Q3] plans\nand "budget" | now'),
    'ask about their Q3 plans and budget now')
  assert.equal(sanitizeInstruction('x'.repeat(500)).length, 240)

  const next = setSendInstruction(DEFAULT_PLAYBOOK, 'A', 'mention their [pipeline] "problem"')
  assert.equal(parsePlaybook(next).valid, true)
  assert.equal(parsePlaybook(next).nodes.A.instruction, 'mention their pipeline problem')
})

test('an edit to a node that is not a send step leaves the source alone', () => {
  assert.equal(setSendInstruction(DEFAULT_PLAYBOOK, 'N', 'wait longer'), DEFAULT_PLAYBOOK)   // a Wait node
  assert.equal(setSendInstruction(DEFAULT_PLAYBOOK, 'W', 'celebrate'), DEFAULT_PLAYBOOK)     // a terminal
  assert.equal(setSendInstruction(DEFAULT_PLAYBOOK, 'ZZZ', 'anything'), DEFAULT_PLAYBOOK)    // not there
  assert.equal(setSendInstruction(DEFAULT_PLAYBOOK, 'A', '   '), DEFAULT_PLAYBOOK)           // nothing said
})

test('a set of edits applies in one pass', () => {
  const next = applyInstructions(DEFAULT_PLAYBOOK, [
    { nodeId: 'A', instruction: 'first thing' },
    { nodeId: 'F', instruction: 'second thing' },
  ])
  const g = parsePlaybook(next)
  assert.equal(g.valid, true)
  assert.equal(g.nodes.A.instruction, 'first thing')
  assert.equal(g.nodes.F.instruction, 'second thing')
})

test('previews cap at ten steps rather than fanning out forever', async () => {
  const steps = Array.from({ length: 14 }, (_, i) => `    N${i} --> N${i + 1}[Send: step ${i + 1}]`)
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> N0[Send: step 0]
${steps.join('\n')}
    N14 --> W([Won])
  `)
  assert.equal(g.valid, true)
  const { samples, truncated, totalSendSteps } = await previewPlaybookEmails({ graph: g, lead: LEAD, senderName: 'Harry' })
  assert.equal(totalSendSteps, 15)
  assert.equal(samples.length, 10)
  assert.equal(truncated, 5)
})
