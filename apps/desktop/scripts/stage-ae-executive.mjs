#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const costasRoot = path.resolve(desktopRoot, '..', '..')
const aeRoot = path.resolve(process.env.AGENT_EXPERIMENTS_ROOT || path.join(costasRoot, '..', 'AgentExperiments'))
const destinationDir = path.join(desktopRoot, 'build', 'ae')
const suffix = process.platform === 'win32' ? '.exe' : ''

const artifacts = [
  {
    manifest: path.join(aeRoot, 'run', 'Cargo.toml'),
    bin: 'ae-executive-scene',
    source: path.join(aeRoot, 'run', 'target', 'debug', `ae-executive-scene${suffix}`),
    inputs: [
      path.join(aeRoot, 'run', 'src', 'tui.rs'),
      path.join(aeRoot, 'run', 'src', 'bin', 'ae-executive-scene.rs'),
      path.join(aeRoot, 'ugui', 'src', 'lib.rs'),
      path.join(aeRoot, 'ugui', 'src', 'executive.rs'),
      path.join(aeRoot, 'ugui', 'src', 'executive', 'dashboard_metrics.rs'),
      path.join(aeRoot, 'ugui', 'src', 'executive', 'lucid_logs.rs'),
      path.join(aeRoot, 'ugui', 'src', 'executive', 'quine_studio.rs'),
      path.join(aeRoot, 'ugui', 'src', 'executive', 'scores_settings.rs'),
      path.join(aeRoot, 'ugui', 'src', 'geom_scene.rs'),
      path.join(aeRoot, 'ugui', 'src', 'projection_action.rs'),
      path.join(aeRoot, 'ugui', 'src', 'projection_projector.rs'),
      path.join(aeRoot, 'ugui', 'src', 'projection_section.rs'),
      path.join(aeRoot, 'ugui', 'json', 'scene.schema.json'),
      path.join(aeRoot, 'quine', 'src', 'executive_applet.rs')
    ]
  },
  {
    manifest: path.join(aeRoot, 'butler', 'Cargo.toml'),
    bin: 'butler',
    source: path.join(aeRoot, 'butler', 'target', 'debug', `butler${suffix}`),
    inputs: [
      path.join(aeRoot, 'butler', 'src', 'daemon.rs'),
      path.join(aeRoot, 'butler', 'src', 'main.rs'),
      path.join(aeRoot, 'butler', 'src', 'server.rs'),
      path.join(aeRoot, 'envelope', 'LUCID.json'),
      path.join(aeRoot, 'envelope', 'MCP.json')
    ]
  }
]

mkdirSync(destinationDir, { recursive: true })
for (const artifact of artifacts) {
  if (!existsSync(artifact.manifest)) {
    throw new Error(`[stage-ae-executive] missing manifest: ${artifact.manifest}`)
  }
  const destination = path.join(destinationDir, `${artifact.bin}${suffix}`)
  const fresh =
    existsSync(destination) &&
    artifact.inputs.every(input => existsSync(input) && statSync(input).mtimeMs <= statSync(destination).mtimeMs)

  if (!fresh) {
    const result = spawnSync('cargo', ['build', '--manifest-path', artifact.manifest, '--bin', artifact.bin], {
      cwd: aeRoot,
      stdio: 'inherit'
    })
    if (result.error || result.status !== 0 || !existsSync(artifact.source)) {
      throw new Error(`[stage-ae-executive] ${artifact.bin} build failed (${result.status ?? result.error?.message})`)
    }
    copyFileSync(artifact.source, destination)
    if (process.platform !== 'win32') chmodSync(destination, 0o755)
  }
  console.log(`[stage-ae-executive] staged ${destination}`)
}

const skinBindingsSource = path.join(aeRoot, 'ugui', 'skins', 'bindings')
const skinBindingsDestination = path.join(destinationDir, 'skins')

if (!existsSync(skinBindingsSource)) {
  throw new Error(`[stage-ae-executive] missing generated UGUI skin bindings: ${skinBindingsSource}`)
}

rmSync(skinBindingsDestination, { force: true, recursive: true })
cpSync(skinBindingsSource, skinBindingsDestination, {
  recursive: true,
  filter: source => source === skinBindingsSource || source.endsWith('.json')
})
console.log(`[stage-ae-executive] staged ${skinBindingsDestination}`)
