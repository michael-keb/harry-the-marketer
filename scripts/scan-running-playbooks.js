#!/usr/bin/env node
// One-off pre-deploy scan: parse every running campaign's playbook and report
// any that would pause under the fix-5a validation rules.
import { db } from '../server/db.js'
import { parsePlaybook } from '../server/playbook.js'

const rows = db.prepare("SELECT id, name, mermaid FROM campaigns WHERE status = 'running'").all()
let bad = 0
for (const c of rows) {
  const graph = parsePlaybook(c.mermaid || '')
  if (!graph.valid) {
    bad += 1
    console.log(`#${c.id} ${c.name}: ${graph.errors[0]?.message || 'invalid'}`)
  }
}
console.log(`Scanned ${rows.length} running campaign(s); ${bad} would pause on deploy.`)
