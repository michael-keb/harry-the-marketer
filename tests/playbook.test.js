import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlaybook, parseCondition, parseDuration, DEFAULT_PLAYBOOK, nodeIntents } from '../server/playbook.js'

test('parseDuration handles units', () => {
  assert.equal(parseDuration('3d'), 3 * 86400e3)
  assert.equal(parseDuration('2 hours'), 2 * 3600e3)
  assert.equal(parseDuration('45m'), 45 * 60e3)
  assert.equal(parseDuration('1w'), 7 * 86400e3)
  assert.equal(parseDuration('soon'), null)
})

test('parseCondition grammar', () => {
  assert.deepEqual(parseCondition(''), { kind: 'always' })
  assert.deepEqual(parseCondition('reply'), { kind: 'reply', intent: null })
  assert.deepEqual(parseCondition('reply: interested'), { kind: 'reply', intent: 'interested' })
  assert.deepEqual(parseCondition('Reply: Not Now'), { kind: 'reply', intent: 'not now' })
  assert.equal(parseCondition('no reply 3d').kind, 'no_reply')
  assert.equal(parseCondition('no reply 3d').ms, 3 * 86400e3)
  assert.equal(parseCondition('after 2h').kind, 'after')
  assert.equal(parseCondition('gibberish').kind, 'invalid')
})

test('default playbook parses clean', () => {
  const g = parsePlaybook(DEFAULT_PLAYBOOK)
  assert.deepEqual(g.errors, [])
  assert.equal(g.valid, true)
  assert.equal(g.startId, 'S')
  assert.equal(g.nodes.A.type, 'send')
  assert.match(g.nodes.A.instruction, /intro email/)
  assert.equal(g.nodes.U.type, 'terminal')
  assert.equal(g.nodes.U.outcome, 'unsubscribed')
  assert.equal(g.nodes.W.outcome, 'won')
  assert.equal(g.nodes.L.outcome, 'lost')
  assert.equal(g.nodes.N.type, 'wait')
  assert.equal(g.nodes.N.ms, 30 * 86400e3)
})

test('chained statements and pipe labels', () => {
  const g = parsePlaybook(`flowchart LR
    S([Start]) --> A[Send: hi] -->|reply: interested| W([Won])
    A -->|no reply 2d| L([Lost])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.edges.length, 3)
  const e = g.edges.find((x) => x.from === 'A' && x.to === 'W')
  assert.deepEqual(e.cond, { kind: 'reply', intent: 'interested' })
})

test('decision diamonds branch', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi]
    A --> D{Reply?}
    D -- reply: interested --> W([Won])
    D -- no reply 3d --> L([Lost])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.D.type, 'decision')
  assert.deepEqual(nodeIntents(g, 'D'), ['interested'])
})

test('validation catches missing start', () => {
  const g = parsePlaybook('flowchart TD\n  A[Send: hi] --> B([Won])')
  assert.ok(g.errors.some((e) => /No start node/.test(e.message)))
})

test('validation catches double start, unknown rect, bad labels', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Do something]
    S2([Start again]) --> A
    A -- whenever --> B([Won])
  `)
  assert.ok(g.errors.some((e) => /Multiple start nodes/.test(e.message)))
  assert.ok(g.errors.some((e) => /not a recognized action/.test(e.message)))
  assert.ok(g.errors.some((e) => /Cannot understand edge label/.test(e.message)))
  assert.equal(g.valid, false)
})

test('validation catches mixed labeled/unlabeled edges and duplicates', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi]
    A --> B[Send: next]
    A -- reply: interested --> W([Won])
    B -- reply: interested --> W
    B -- reply: interested --> L([Lost])
  `)
  assert.ok(g.errors.some((e) => /mixes an unlabeled edge/.test(e.message)))
  assert.ok(g.errors.some((e) => /same condition/.test(e.message)))
})

test('warns on missing timeout escape and unreachable nodes', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi]
    A -- reply: interested --> W([Won])
    X[Send: orphan] --> W
  `)
  assert.equal(g.valid, true)
  assert.ok(g.warnings.some((w) => /wait forever/.test(w.message)))
  assert.ok(g.warnings.some((w) => /not reachable/.test(w.message)))
})

test('undefined node reference is an error', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi]
    A -- reply --> GHOST
  `)
  assert.ok(g.errors.some((e) => /never defined/.test(e.message)))
})

test('quoted labels and comments parse', () => {
  const g = parsePlaybook(`flowchart TD
    %% my campaign
    S([Start]) --> A["Send: pitch the Q3 offer"]
    A -- "reply: interested" --> W([Won]) %% happy path
    A -- no reply 3d --> L([Lost])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.A.instruction, 'pitch the Q3 offer')
  assert.equal(g.nodes.A.channel, 'email')
})

test('Send sms: sets channel sms; bare Send: stays email', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: Intro]
    A -- no reply 2d --> B[Send sms: Short nudge]
    B --> W([Won])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.A.channel, 'email')
  assert.equal(g.nodes.B.channel, 'sms')
  assert.equal(g.nodes.B.instruction, 'Short nudge')
})

test('Send whatsapp is rejected with a channel-specific error', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send whatsapp: hi]
    A --> W([Won])
  `)
  assert.equal(g.valid, false)
  assert.ok(g.errors.some((e) => /channel "whatsapp" is not supported yet/.test(e.message)))
})

test('Send with a non-keyword first word stays an email instruction (no colon needed)', () => {
  // Regression: the channel alternation must stay a keyword list. A `(\\w+)`
  // capture read "intro" as a channel and broke every colon-less Send label.
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send intro email]
    A --> W([Won])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.A.channel, 'email')
  assert.equal(g.nodes.A.instruction, 'intro email')
})

test('wait/start nodes cannot carry labeled edges', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> W[Wait: 1d]
    W -- no reply 3d --> A[Send: hi]
    A --> T([Won])
  `)
  assert.equal(g.valid, false)
  assert.ok(g.errors.some((e) => /Wait\/Start step/.test(e.message)))
})

test('reply before send is rejected; after-only decision is valid', () => {
  const bad = parsePlaybook(`flowchart TD
    S([Start]) --> D{Pick}
    D -- reply: interested --> A[Send: hi]
    A --> W([Won])
  `)
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => /no message has been sent yet/.test(e.message)))

  const ok = parsePlaybook(`flowchart TD
    S([Start]) --> D{Pick}
    D -- after 30s --> A[Send: hi]
    A --> W([Won])
  `)
  assert.equal(ok.valid, true)
})

test('reply-before-send is caught even when a send path reaches the node first', () => {
  // Regression: visited-state must be (node, sent-yet?). D is reached through
  // the send path A first; the send-free path via the waits must still flag
  // D's reply edge.
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> D0{Route}
    D0 -- after 1s --> A[Send: hi]
    D0 -- after 2s --> W1[Wait: 1d]
    A --> D{Reply?}
    W1 --> D
    D -- reply: interested --> B2[Send: yes]
    B2 --> T([Won])
  `)
  assert.equal(g.valid, false)
  assert.ok(
    g.errors.some((e) => /Node "D" waits for a reply, but no message has been sent yet/.test(e.message)),
    `errors: ${g.errors.map((e) => e.message).join(' | ')}`,
  )
})
