// Mermaid-flowchart playbook parser + validator.
//
// The user's campaign playbook IS a mermaid flowchart. Conventions:
//   S([Start])                     -- exactly one start node (stadium, label begins "start")
//   A[Send: intro our product]    -- send node; text after "Send:" is the agent instruction
//   W[Wait: 2d]                    -- delay node
//   D{Reply?}                      -- decision node; branch on labeled edges
//   Won([Won: meeting booked])     -- terminal stadium; outcome from first word
// Edges carry conditions as labels:
//   A -- reply: interested --> B   (classified reply intent)
//   A -- reply --> B               (any reply, catch-all)
//   A -- no reply 3d --> C        (timeout since last outbound)
//   A --> B                        (unconditional)
// Supports `A -->|label| B` and `A -- label --> B`, comments (%%), and quoted labels.

const DUR_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/

function normalizeClock(hhmm) {
  const m = CLOCK_RE.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

export function parseDuration(text) {
  const m = String(text).trim().match(DUR_RE)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2][0].toLowerCase()
  const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit]
  return ms ? Math.round(n * ms) : null
}

// Pull optional `at HH:MM` / `window HH:MM-HH:MM` off a duration clause so
// `no reply 3d at 09:30` and `after 2h window 09:00-11:00` share one path.
function splitTiming(rest) {
  let s = String(rest || '').trim()
  let exactTime = null
  let randomWindow = null
  let bad = false

  const atMatch = s.match(/\bat\s+(\d{1,2}:\d{2})\b/i)
  if (atMatch) {
    exactTime = normalizeClock(atMatch[1])
    if (!exactTime) bad = true
    s = `${s.slice(0, atMatch.index)} ${s.slice(atMatch.index + atMatch[0].length)}`.trim()
  }

  const winMatch = s.match(/\bwindow\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\b/i)
  if (winMatch) {
    const from = normalizeClock(winMatch[1])
    const to = normalizeClock(winMatch[2])
    if (!from || !to) bad = true
    else randomWindow = { from, to }
    s = `${s.slice(0, winMatch.index)} ${s.slice(winMatch.index + winMatch[0].length)}`.trim()
  }

  const ms = parseDuration(s.replace(/\s+/g, ' ').trim())
  if (bad) return { ms: null, exactTime: null, randomWindow: null }
  return { ms, exactTime, randomWindow }
}

function withTiming(base, timing) {
  if (timing.exactTime) base.exactTime = timing.exactTime
  if (timing.randomWindow) base.randomWindow = timing.randomWindow
  return base
}

export function parseCondition(label) {
  const text = String(label || '').trim().replace(/^"|"$/g, '')
  if (!text) return { kind: 'always' }
  const lower = text.toLowerCase()
  if (lower === 'reply' || lower === 'any reply' || lower === 'replied') return { kind: 'reply', intent: null }
  const replyMatch = lower.match(/^reply\s*[:=]\s*(.+)$/)
  if (replyMatch) return { kind: 'reply', intent: replyMatch[1].trim() }
  const noReply = lower.match(/^no\s*reply\s*[:=]?\s*(.+)$/)
  if (noReply) {
    const timing = splitTiming(noReply[1])
    return timing.ms
      ? withTiming({ kind: 'no_reply', ms: timing.ms, raw: text }, timing)
      : { kind: 'invalid', raw: text }
  }
  const after = lower.match(/^(?:after|wait)\s*[:=]?\s*(.+)$/)
  if (after) {
    const timing = splitTiming(after[1])
    return timing.ms
      ? withTiming({ kind: 'after', ms: timing.ms, raw: text }, timing)
      : { kind: 'invalid', raw: text }
  }
  // Bare durations on edges count as "after" (optional at/window suffixes).
  const bare = splitTiming(lower)
  if (bare.ms) return withTiming({ kind: 'after', ms: bare.ms, raw: text }, bare)
  return { kind: 'invalid', raw: text }
}

function classifyNode(id, shape, label) {
  const text = label.trim()
  const lower = text.toLowerCase()
  if (shape === 'stadium') {
    if (/^start\b/i.test(lower)) return { id, type: 'start', label: text }
    const outcomeWord = (lower.match(/^([a-z-]+)/) || [])[1] || 'completed'
    const outcome = ['won', 'win', 'success'].includes(outcomeWord) ? 'won'
      : ['lost', 'lose', 'dead'].includes(outcomeWord) ? 'lost'
      : ['unsubscribe', 'unsubscribed', 'optout', 'opt-out'].includes(outcomeWord) ? 'unsubscribed'
      : 'completed'
    return { id, type: 'terminal', label: text, outcome }
  }
  if (shape === 'diamond') return { id, type: 'decision', label: text }
  // Rectangles: Send / Wait actions.
  // Channel may be named: `Send sms: …`, `Send email: …`. Bare `Send:` is email
  // so every existing playbook keeps working unchanged.
  const send = text.match(/^send(?:\s+(email|sms|whatsapp|telegram))?\s*[:=]?\s*(.*)$/i)
  if (send) {
    const channel = (send[1] || 'email').toLowerCase()
    let instruction = (send[2] || '').trim()
    let randomWindow = null
    // Trailing `; window HH:MM-HH:MM` is step-level send jitter, not copy.
    const win = instruction.match(/;\s*window\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/i)
    if (win) {
      const from = normalizeClock(win[1])
      const to = normalizeClock(win[2])
      if (from && to) randomWindow = { from, to }
      instruction = instruction.slice(0, win.index).trim()
    }
    const node = {
      id,
      type: 'send',
      label: text,
      channel,
      instruction,
    }
    if (randomWindow) node.randomWindow = randomWindow
    return node
  }
  const wait = text.match(/^wait\s*[:=]?\s*(.*)$/i)
  if (wait) {
    const timing = splitTiming(wait[1])
    const node = { id, type: 'wait', label: text, ms: timing.ms ?? null }
    if (timing.exactTime) node.exactTime = timing.exactTime
    if (timing.randomWindow) node.randomWindow = timing.randomWindow
    return node
  }
  return { id, type: 'unknown', label: text }
}

// Strip a node token like `A[Send: hi]` / `B([Start])` / `C{Reply?}` from the
// start of a string. Returns { id, shape, label, rest } or null.
function readNode(str) {
  const m = str.match(/^\s*([A-Za-z0-9_-]+)/)
  if (!m) return null
  const id = m[1]
  let rest = str.slice(m[0].length)
  const openers = [
    { open: '([', close: '])', shape: 'stadium' },
    { open: '((', close: '))', shape: 'stadium' },
    { open: '[/', close: '/]', shape: 'rect' },
    { open: '{{', close: '}}', shape: 'diamond' },
    { open: '[', close: ']', shape: 'rect' },
    { open: '{', close: '}', shape: 'diamond' },
    { open: '(', close: ')', shape: 'stadium' },
  ]
  for (const { open, close, shape } of openers) {
    if (rest.startsWith(open)) {
      const end = rest.indexOf(close, open.length)
      if (end === -1) return { id, shape, label: null, rest: '', unclosed: true }
      const label = rest.slice(open.length, end).replace(/^"|"$/g, '')
      return { id, shape, label, rest: rest.slice(end + close.length) }
    }
  }
  return { id, shape: null, label: null, rest }
}

export function parsePlaybook(source) {
  const nodes = {}   // id -> node
  const edges = []   // { from, to, label, cond, line }
  const errors = []
  const warnings = []
  const referenced = new Set()

  const defineNode = (tok, line) => {
    if (tok.label === null) {
      referenced.add(tok.id)
      return
    }
    const node = classifyNode(tok.id, tok.shape, tok.label)
    if (nodes[tok.id] && nodes[tok.id].label !== node.label) {
      warnings.push({ line, message: `Node "${tok.id}" is defined twice with different labels; using the first.` })
      return
    }
    nodes[tok.id] = nodes[tok.id] || node
  }

  const lines = String(source || '').split('\n')
  lines.forEach((raw, i) => {
    const line = i + 1
    let text = raw.replace(/%%.*$/, '').trim()
    if (!text) return
    if (/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.test(text)) return
    if (/^(classDef|class|style|linkStyle|click|subgraph|end|direction)\b/i.test(text)) return

    // A statement can chain: A --> B --> C. Walk left to right.
    let tok = readNode(text)
    if (!tok) {
      errors.push({ line, message: `Cannot parse line: "${raw.trim()}"` })
      return
    }
    if (tok.unclosed) {
      errors.push({ line, message: `Unclosed bracket in node "${tok.id}"` })
      return
    }
    defineNode(tok, line)
    let prev = tok.id
    let rest = tok.rest

    while (rest.trim()) {
      // arrow with optional inline label:  -- label -->   |  -->  |  -->|label|
      let label = ''
      let m = rest.match(/^\s*--\s*([^->][^>]*?)\s*-->\s*/)
      if (m) {
        label = m[1]
        rest = rest.slice(m[0].length)
      } else if ((m = rest.match(/^\s*(?:-->|==>|-\.->|\.->)\s*/))) {
        rest = rest.slice(m[0].length)
        const pipe = rest.match(/^\|([^|]*)\|\s*/)
        if (pipe) {
          label = pipe[1]
          rest = rest.slice(pipe[0].length)
        }
      } else {
        errors.push({ line, message: `Expected an arrow (-->) after "${prev}": "${rest.trim()}"` })
        return
      }
      const next = readNode(rest)
      if (!next) {
        errors.push({ line, message: `Expected a node after the arrow: "${rest.trim()}"` })
        return
      }
      if (next.unclosed) {
        errors.push({ line, message: `Unclosed bracket in node "${next.id}"` })
        return
      }
      defineNode(next, line)
      const cond = parseCondition(label)
      if (cond.kind === 'invalid') {
        errors.push({ line, message: `Cannot understand edge label "${cond.raw}". Use "reply: <intent>", "reply", "no reply 3d", or "after 2h".` })
      }
      edges.push({ from: prev, to: next.id, label: label.trim(), cond, line })
      prev = next.id
      rest = next.rest
    }
  })

  // ---- semantic validation --------------------------------------------------
  for (const id of referenced) {
    if (!nodes[id]) errors.push({ line: 0, message: `Node "${id}" is used in an edge but never defined with a label.` })
  }
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (!nodes[end] && !referenced.has(end)) errors.push({ line: e.line, message: `Edge references unknown node "${end}".` })
    }
  }

  const all = Object.values(nodes)
  const starts = all.filter((n) => n.type === 'start')
  if (starts.length === 0) errors.push({ line: 0, message: 'No start node. Add one like: S([Start])' })
  if (starts.length > 1) errors.push({ line: 0, message: `Multiple start nodes (${starts.map((n) => n.id).join(', ')}). Keep exactly one.` })
  const startId = starts[0]?.id || null

  for (const n of all) {
    const out = edges.filter((e) => e.from === n.id)
    if (n.type === 'unknown') {
      errors.push({ line: 0, message: `Node "${n.id}" ("${n.label}") is not a recognized action. Rectangles must be "Send: <instruction>" or "Wait: <duration>".` })
    }
    if (n.type === 'wait' && n.ms === null) {
      errors.push({ line: 0, message: `Wait node "${n.id}" needs a duration, e.g. [Wait: 2d].` })
    }
    if (n.type === 'terminal' && out.length > 0) {
      warnings.push({ line: 0, message: `Terminal node "${n.id}" has outgoing edges; they will never run.` })
    }
    if (n.type === 'decision') {
      if (out.length === 0) errors.push({ line: 0, message: `Decision node "${n.id}" has no outgoing edges.` })
      const conditional = out.filter((e) => e.cond.kind !== 'always')
      if (out.length > 1 && conditional.length === 0) {
        errors.push({ line: 0, message: `Decision "${n.id}" has multiple unlabeled edges — label them (e.g. "reply: interested", "no reply 3d").` })
      }
    }
    if (n.type === 'send' && out.length === 0) {
      warnings.push({ line: 0, message: `Send node "${n.id}" has no next step — the lead will finish there after sending.` })
    }
    // Waiting nodes (send/decision with reply edges) should have a timeout escape.
    const replyEdges = out.filter((e) => e.cond.kind === 'reply')
    const timeoutEdges = out.filter((e) => e.cond.kind === 'no_reply' || e.cond.kind === 'after')
    if (replyEdges.length > 0 && timeoutEdges.length === 0) {
      warnings.push({ line: 0, message: `"${n.id}" waits for a reply but has no "no reply Xd" edge — leads that never reply will wait forever.` })
    }
    // Duplicate conditions
    const seen = new Set()
    for (const e of out) {
      const key = e.cond.kind === 'reply' ? `reply:${e.cond.intent ?? '*'}` : e.cond.kind === 'always' ? 'always' : `${e.cond.kind}:${e.cond.ms}`
      if (seen.has(key)) errors.push({ line: e.line, message: `Node "${n.id}" has two edges with the same condition (${e.label || 'unlabeled'}).` })
      seen.add(key)
    }
    // A send node that both auto-advances and branches is ambiguous.
    const always = edges.filter((e) => e.from === n.id && e.cond.kind === 'always')
    if ((n.type === 'send' || n.type === 'decision') && always.length > 0 && out.length > always.length) {
      errors.push({ line: 0, message: `Node "${n.id}" mixes an unlabeled edge with conditional edges — label every edge or none.` })
    }
    if (always.length > 1) {
      errors.push({ line: 0, message: `Node "${n.id}" has ${always.length} unlabeled edges — it can only auto-advance to one place.` })
    }
  }

  // Reachability from start
  if (startId) {
    const reachable = new Set([startId])
    const queue = [startId]
    while (queue.length) {
      const cur = queue.shift()
      for (const e of edges) {
        if (e.from === cur && nodes[e.to] && !reachable.has(e.to)) {
          reachable.add(e.to)
          queue.push(e.to)
        }
      }
    }
    for (const n of all) {
      if (!reachable.has(n.id)) warnings.push({ line: 0, message: `Node "${n.id}" is not reachable from Start.` })
    }
    const reachesTerminal = all.some((n) => reachable.has(n.id) && n.type === 'terminal')
    if (!reachesTerminal) warnings.push({ line: 0, message: 'No terminal node (e.g. W([Won])) is reachable — leads will never finish.' })
    const reachesSend = all.some((n) => reachable.has(n.id) && n.type === 'send')
    if (!reachesSend) errors.push({ line: 0, message: 'The playbook never sends an email — add a node like A[Send: intro].' })
  }

  return { nodes, edges, startId, errors, warnings, valid: errors.length === 0 }
}

// The shortest route from Start to a node, as the list of edges walked to get
// there. Used to reconstruct what a lead would have already received (and said)
// by the time a given step fires — see previewPlaybookEmails in ai.js.
// Returns [] for the start node itself, null when the node is unreachable.
export function pathToNode(graph, nodeId) {
  if (!graph.startId || !graph.nodes[nodeId]) return null
  if (nodeId === graph.startId) return []
  const prev = new Map()
  const seen = new Set([graph.startId])
  const queue = [graph.startId]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of graph.edges) {
      if (e.from !== cur || seen.has(e.to) || !graph.nodes[e.to]) continue
      seen.add(e.to)
      prev.set(e.to, e)
      if (e.to === nodeId) {
        const walked = []
        let at = nodeId
        while (at !== graph.startId) {
          const edge = prev.get(at)
          walked.unshift(edge)
          at = edge.from
        }
        return walked
      }
      queue.push(e.to)
    }
  }
  return null
}

// The intent vocabulary offered to the classifier at a given waiting node.
export function nodeIntents(graph, nodeId) {
  return graph.edges
    .filter((e) => e.from === nodeId && e.cond.kind === 'reply' && e.cond.intent)
    .map((e) => e.cond.intent)
}

// Surface invalid randomised windows without importing step-timing (keeps the
// parser free of a database open). Same rules as validateRandomWindow.
function windowOk(window) {
  if (!window) return { ok: true }
  const from = normalizeClock(window.from)
  const to = normalizeClock(window.to)
  if (!from || !to) return { ok: false, error: 'window needs HH:MM–HH:MM clocks' }
  const fromMin = Number(from.slice(0, 2)) * 60 + Number(from.slice(3))
  const toMin = Number(to.slice(0, 2)) * 60 + Number(to.slice(3))
  if (toMin < fromMin) return { ok: false, error: 'window end must be at or after start' }
  return { ok: true }
}

export function collectTimingIssues(graph) {
  const issues = []
  for (const n of Object.values(graph?.nodes || {})) {
    if (!n.randomWindow) continue
    const v = windowOk(n.randomWindow)
    if (!v.ok) issues.push({ message: `Node "${n.id}": ${v.error}` })
  }
  for (const e of graph?.edges || []) {
    if (!e.cond?.randomWindow) continue
    const v = windowOk(e.cond.randomWindow)
    if (!v.ok) issues.push({ message: `Edge ${e.from}→${e.to}: ${v.error}` })
  }
  return issues
}

export const DEFAULT_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: short intro email — who we are and the one problem we solve for their role]
    A -- reply: interested --> B[Send: thanks + propose a 20-minute call this week, offer two time slots]
    A -- reply: question --> Q[Send: answer their question directly, then ask if a quick call makes sense]
    A -- reply: not now --> N[Wait: 30d]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 3d --> F[Send: short follow-up — one new proof point, one question]
    F -- reply: interested --> B
    F -- reply: unsubscribe --> U
    F -- no reply 4d --> G[Send: last check-in — close the loop politely]
    G -- reply: interested --> B
    G -- no reply 5d --> L([Lost: no response])
    N --> A2[Send: re-engage — reference their earlier reply and share what's new]
    A2 -- reply: interested --> B
    A2 -- no reply 5d --> L
    B -- reply --> W([Won: call booked])
    B -- no reply 3d --> G
    Q -- reply: interested --> B
    Q -- no reply 4d --> F
`
