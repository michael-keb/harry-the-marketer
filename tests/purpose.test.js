// Purpose guardrail — PURPOSE-GUARDRAIL-PLAN.md deterministic checker.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkCommercial, playbookCommercialHit, guardComposed, isNonCommercial,
} from '../server/purpose.js'
import { parsePlaybook } from '../server/playbook.js'

test('currency and hire-me phrases trip the deterministic check', () => {
  const hit = checkCommercial('I charge $80/hr for freelance ops work — hire me')
  assert.equal(hit.commercial, true)
  assert.match(hit.sentence, /\$80|hire me/i)
})

test('a clean training ask is not commercial', () => {
  const hit = checkCommercial(
    'Could I study your warehouse ops for my final-year assessment? Findings free, about an hour of your time.',
  )
  assert.equal(hit.commercial, false)
})

test('non-dollar currencies and fee paraphrases trip the check', () => {
  assert.equal(checkCommercial('My day rate is £500').commercial, true)
  assert.equal(checkCommercial('Package pricing starts at €500').commercial, true)
  assert.equal(checkCommercial('Happy to discuss my fee over a call').commercial, true)
  assert.equal(checkCommercial('That would be 500 dollars for the engagement').commercial, true)
  assert.equal(checkCommercial('AUD 500 retainer available').commercial, true)
})

test('playbookCommercialHit names the offending send node', () => {
  const graph = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: pitch my freelance services at $120/day]
    A -- no reply 3d --> L([Lost])
  `)
  assert.equal(graph.valid, true)
  const hit = playbookCommercialHit(graph)
  assert.ok(hit)
  assert.equal(hit.nodeId, 'A')
  assert.equal(hit.commercial, true)
})

test('guardComposed is off under commercial purpose', () => {
  assert.equal(
    guardComposed({ purpose: 'commercial', subject: 'Hire me', body: 'My rate card starts at $200' }),
    null,
  )
})

test('guardComposed blocks under assessment', () => {
  assert.equal(isNonCommercial('assessment'), true)
  const hit = guardComposed({
    purpose: 'assessment',
    subject: 'Quick question',
    body: 'Available for freelance work this term — day rate on request.',
  })
  assert.ok(hit?.commercial)
})
