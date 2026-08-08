// Dev launcher: runs the API and the Vite dev server under the same Node that
// runs this script (use a Node >= 20.19 binary, e.g. from nvm).
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.execPath
const env = { ...process.env, PATH: `${path.dirname(nodeBin)}:${process.env.PATH}` }

const procs = [
  // The preview harness exports PORT for the web port — the API must stay on 8130.
  ['api', ['--watch', path.join(root, 'server', 'index.js')], { ...env, PORT: '8130' }],
  ['web', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(root, 'web', 'vite.config.js')], env],
].map(([name, args, procEnv]) => {
  const child = spawn(nodeBin, args, { cwd: root, env: procEnv, stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code})`)
    process.exit(code ?? 0)
  })
  return child
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of procs) child.kill(signal)
    process.exit(0)
  })
}
