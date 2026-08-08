// Dump the full API route table and flag shadowed routes.
//
// Express matches the first layer that fits, so a parity module registering
// `GET /leads/:id` after routes.js has already claimed `GET /leads/export`
// leaves the second one unreachable. That is invisible at boot and only shows
// up as a mysterious 404 later, so it is checked here instead.
//
//   node scripts/routes.mjs           list every route, grouped
//   node scripts/routes.mjs --check   exit 1 if anything is shadowed

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-routes-'))
process.env.AI_MODE = 'off'

const { api } = await import('../server/routes.js')

const routes = []
for (const layer of api.stack) {
  if (!layer.route) continue
  for (const method of Object.keys(layer.route.methods)) {
    routes.push({ method: method.toUpperCase(), path: layer.route.path })
  }
}

// Turn '/leads/:id' into a regex that matches concrete paths, so we can ask
// whether an earlier pattern swallows a later literal.
const toRe = (p) =>
  new RegExp('^' + p.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$')

const shadowed = []
for (let i = 0; i < routes.length; i++) {
  for (let j = 0; j < i; j++) {
    if (routes[i].method !== routes[j].method) continue
    if (routes[j].path === routes[i].path) {
      shadowed.push({ ...routes[i], by: routes[j].path, kind: 'duplicate' })
      break
    }
    if (!routes[i].path.includes(':') && toRe(routes[j].path).test(routes[i].path)) {
      shadowed.push({ ...routes[i], by: routes[j].path, kind: 'captured' })
      break
    }
  }
}

const check = process.argv.includes('--check')

if (!check) {
  const groups = new Map()
  for (const r of routes) {
    const key = r.path.split('/')[1] || '(root)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  for (const [group, rs] of [...groups].sort()) {
    console.log(`\n${group}  (${rs.length})`)
    for (const r of rs) console.log(`  ${r.method.padEnd(6)} /api${r.path}`)
  }
}

console.log(`\n${routes.length} routes registered.`)

if (shadowed.length) {
  console.log(`\n${shadowed.length} unreachable route(s):`)
  for (const s of shadowed) {
    console.log(`  ${s.method.padEnd(6)} /api${s.path}  ${s.kind} by  /api${s.by}`)
  }
  if (check) process.exit(1)
} else {
  console.log('No shadowed routes.')
}
