#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const costasRoot = path.resolve(desktopRoot, '..', '..')
const aeRoot = path.resolve(process.env.AGENT_EXPERIMENTS_ROOT || path.join(costasRoot, '..', 'AgentExperiments'))
const manifest = path.join(aeRoot, 'run', 'Cargo.toml')
const executable = process.platform === 'win32' ? 'ae-executive-scene.exe' : 'ae-executive-scene'
const sourceBinary = path.join(aeRoot, 'run', 'target', 'debug', executable)
const destinationDir = path.join(desktopRoot, 'build', 'ae')
const destination = path.join(destinationDir, executable)
const sources = [
  path.join(aeRoot, 'run', 'src', 'tui.rs'),
  path.join(aeRoot, 'run', 'src', 'bin', 'ae-executive-scene.rs'),
  path.join(aeRoot, 'ugui', 'src', 'lib.rs'),
  path.join(aeRoot, 'quine', 'src', 'executive_applet.rs')
]

if (!existsSync(manifest)) {
  throw new Error(`[stage-ae-executive] missing AgentExperiments run manifest: ${manifest}`)
}

const destinationFresh = existsSync(destination) && sources.every(source => existsSync(source) && statSync(source).mtimeMs <= statSync(destination).mtimeMs)

if (!destinationFresh) {
  const result = spawnSync('cargo', ['build', '--manifest-path', manifest, '--bin', 'ae-executive-scene'], {
    cwd: aeRoot,
    stdio: 'inherit'
  })
  if (result.error || result.status !== 0 || !existsSync(sourceBinary)) {
    throw new Error(`[stage-ae-executive] Rust projector build failed (${result.status ?? result.error?.message})`)
  }
  mkdirSync(destinationDir, { recursive: true })
  copyFileSync(sourceBinary, destination)
  if (process.platform !== 'win32') chmodSync(destination, 0o755)
}

console.log(`[stage-ae-executive] staged ${destination}`)
