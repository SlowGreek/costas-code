import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const aeRoot = process.env.AGENT_EXPERIMENTS_ROOT
  ? path.resolve(process.env.AGENT_EXPERIMENTS_ROOT)
  : path.resolve(appRoot, '../../..', 'AgentExperiments')
const destination = path.join(appRoot, 'build', 'ae', 'shell-viewport')
const sources = [
  ['shell-builds.json', path.join(aeRoot, 'run', 'SHELL-BUILDS.json'), 'ae-shell-build-matrix/1'],
  [
    'shell-capability-parity.json',
    path.join(aeRoot, 'envelope', 'capabilities', 'generated', 'SHELL-CAPABILITY-PARITY.json'),
    'ae-shell-capability-parity/1.0.0'
  ],
  ['surface-profiles.json', path.join(aeRoot, 'ugui', 'json', 'surface-profiles.json'), 'ugui-surface-profiles/v1']
]

rmSync(destination, { force: true, recursive: true })
mkdirSync(destination, { recursive: true })
for (const [name, source, schema] of sources) {
  if (!existsSync(source)) throw new Error(`[stage-ae-shell-viewport] missing source: ${source}`)
  const value = JSON.parse(readFileSync(source, 'utf8'))
  if (value?.schema !== schema) throw new Error(`[stage-ae-shell-viewport] schema mismatch: ${source}`)
  copyFileSync(source, path.join(destination, name))
}
console.log(`[stage-ae-shell-viewport] staged ${destination}`)