import test from 'node:test'
import assert from 'node:assert/strict'

process.env.AI_MODE = 'off'

const { heuristicPlanGoal, goalPlaybook, heuristicQualify } = await import('../server/ai.js')
const { parsePlaybook } = await import('../server/playbook.js')

test('heuristic goal planning extracts the target and keywords', () => {
  const plan = heuristicPlanGoal('Generate 20 qualified meetings with Australian SaaS companies using Jira')
  assert.equal(plan.target, 20)
  assert.ok(plan.icp.keywords.includes('australian'))
  assert.ok(plan.icp.keywords.includes('saas'))
  assert.ok(plan.icp.keywords.includes('jira'))
  assert.ok(plan.name.length > 0)
})

test('heuristic goal planning defaults the target to 10', () => {
  const plan = heuristicPlanGoal('Get meetings with fintech COOs in Sydney')
  assert.equal(plan.target, 10)
})

test('generated goal playbooks always validate', () => {
  const nasty = heuristicPlanGoal('Book 5 demos with [weird] {chars} in "quotes" | pipes')
  nasty.introInstruction = 'intro with [brackets] {braces} (parens) "quotes" | pipes'
  const graph = parsePlaybook(goalPlaybook(nasty))
  assert.deepEqual(graph.errors, [])
  assert.equal(graph.valid, true)
  assert.equal(graph.nodes.W.outcome, 'won')
})

test('qualification scores ICP matches higher, with reasons', () => {
  const icp = { keywords: ['jira', 'saas'], industries: ['software'], locations: ['australia'], titles: ['operations'] }
  const fitLead = {
    email: 'jo@acme.com.au', first_name: 'Jo', last_name: 'Smith', company: 'Acme SaaS',
    title: 'Head of Operations', notes: 'Uses Jira heavily; based in Australia',
  }
  const poorLead = { email: 'x@unknown.org', first_name: '', last_name: '', company: '', title: '', notes: '' }
  const good = heuristicQualify(fitLead, icp)
  const bad = heuristicQualify(poorLead, icp)
  assert.ok(good.fit > bad.fit, `expected ${good.fit} > ${bad.fit}`)
  assert.ok(good.fit >= 60)
  assert.ok(good.reasons.some((r) => /jira/i.test(r)))
  assert.ok(bad.fit < 60)
  assert.ok(bad.reasons.length > 0)
})
