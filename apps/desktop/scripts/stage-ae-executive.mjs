#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeAeGenerationId,
  publishAeGenerationStore,
  reconcileAeOrphans,
  validateAeGenerationManifest
} from './ae-generation.mjs'
import { discoverAeRepositoryRoot } from './ae-repository-root.mjs'
import { stageAeShellViewport } from './stage-ae-shell-viewport.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const costasRoot = path.resolve(desktopRoot, '..', '..')
const costasRepositoryRoot = realpathSync(costasRoot)
const aeRoot = discoverAeRepositoryRoot({ start: costasRepositoryRoot })
const buildRoot = path.join(desktopRoot, 'build')
const destinationDir = path.join(buildRoot, 'ae')
const candidateDir = path.join(buildRoot, `.ae-candidate-${process.pid}-${Date.now()}`)
const cargoTargetRoot = path.join(buildRoot, `.ae-cargo-${process.pid}-${Date.now()}`)
const suffix = process.platform === 'win32' ? '.exe' : ''
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const AE_SOURCE_PATHS = [
  'Cargo.toml',
  'Cargo.lock',
  'run',
  'ugui',
  'butler',
  'quine/src',
  'quine/Cargo.toml',
  'quine/Cargo.lock',
  'quine/canon',
  'store',
  'marketplace'
]
const COSTAS_SOURCE_PATHS = [
  'QUINE-COMPANION.json',
  'package.json',
  'package-lock.json',
  'apps/desktop'
]

const artifacts = [
  {
    manifest: path.join(aeRoot, 'run', 'Cargo.toml'),
    bin: 'ae-skin-settings-scene',
    target: 'run'
  },
  {
    manifest: path.join(aeRoot, 'run', 'Cargo.toml'),
    bin: 'ae-executive-scene',
    target: 'run'
  },
  {
    manifest: path.join(aeRoot, 'butler', 'Cargo.toml'),
    bin: 'butler',
    target: 'butler'
  }
]

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? aeRoot,
    encoding: options.encoding,
    env: options.env,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || '').slice(-4096) || `exit ${result.status}`
    throw new Error(`[stage-ae-executive] ${program} failed: ${detail}`)
  }
  return result
}

function repositoryIdentity(root, pathspecs) {
  const commit = run('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024
  }).stdout.trim()
  const diff = run('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...pathspecs], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024
  }).stdout
  const untrackedRaw = run(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs],
    { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
  ).stdout
  const untracked = untrackedRaw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
  const digest = createHash('sha256')
  digest.update(diff)
  for (const relative of untracked) {
    const absolute = path.join(root, relative)
    const metadata = lstatSync(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
      throw new Error(`[stage-ae-executive] untracked source is not a bounded direct file: ${relative}`)
    }
    digest.update(relative)
    digest.update('\0')
    digest.update(readFileSync(absolute))
    digest.update('\0')
  }
  return {
    root_realpath: root,
    commit,
    dirty: diff.length > 0 || untracked.length > 0,
    status_sha256: `sha256:${digest.digest('hex')}`
  }
}

function regularFiles(root) {
  const output = []
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = statSync(absolute, { throwIfNoEntry: true })
      if (stat.isSymbolicLink()) throw new Error(`[stage-ae-executive] symlink refused: ${absolute}`)
      if (stat.isDirectory()) walk(absolute, relative)
      else if (stat.isFile()) output.push({ absolute, relative, bytes: stat.size })
      else throw new Error(`[stage-ae-executive] non-regular resource: ${absolute}`)
    }
  }
  walk(root)
  return output
}

function directoryReceipt(name, root) {
  const digest = createHash('sha256')
  let bytes = 0
  const files = regularFiles(root)
  for (const file of files) {
    const content = readFileSync(file.absolute)
    digest.update(file.relative)
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
    bytes += content.length
  }
  return { name, sha256: `sha256:${digest.digest('hex')}`, files: files.length, bytes }
}

function smokeCandidate(directory) {
  const tsx = path.join(costasRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const script = path.join(desktopRoot, 'scripts', 'smoke-ae-generation.ts')
  const result = run(tsx, [script, directory], {
    cwd: desktopRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  })
  return JSON.parse(result.stdout)
}

function candidateManifest(directory) {
  return JSON.parse(readFileSync(path.join(directory, 'generation.json'), 'utf8'))
}

function validateCandidate(directory) {
  const manifest = validateAeGenerationManifest(candidateManifest(directory))
  for (const artifact of manifest.artifacts) {
    const file = path.join(directory, `${artifact.name}${suffix}`)
    const bytes = readFileSync(file)
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`[stage-ae-executive] artifact read-back mismatch: ${artifact.name}`)
    }
  }
  const observedResources = [
    directoryReceipt('shell-viewport', path.join(directory, 'shell-viewport')),
    directoryReceipt('skins', path.join(directory, 'skins'))
  ]
  if (JSON.stringify(observedResources) !== JSON.stringify(manifest.resources)) {
    throw new Error('[stage-ae-executive] resource read-back mismatch')
  }
  const smoke = smokeCandidate(directory)
  if (
    smoke.executive_scenes !== manifest.smoke.executive_scenes ||
    smoke.skin_settings_nodes !== manifest.smoke.skin_settings_nodes
  ) {
    throw new Error('[stage-ae-executive] smoke read-back mismatch')
  }
}

function acquireStageLock(lockPath) {
  const create = () => {
    const descriptor = openSync(lockPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify({ schema: 'costas-ae-stage-lock/1', pid: process.pid })}\n`)
    return descriptor
  }
  try {
    return create()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const metadata = lstatSync(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
      throw new Error('[stage-ae-executive] invalid stage lock')
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (lock?.schema !== 'costas-ae-stage-lock/1' || !Number.isSafeInteger(lock.pid) || lock.pid < 1) {
      throw new Error('[stage-ae-executive] malformed stage lock')
    }
    try {
      process.kill(lock.pid, 0)
      throw new Error(`[stage-ae-executive] generation-locked by pid ${lock.pid}`)
    } catch (probe) {
      if (probe?.code !== 'ESRCH') throw probe
    }
    rmSync(lockPath, { force: true })
    return create()
  }
}

function releaseStageLock(descriptor, lockPath) {
  try { closeSync(descriptor) } catch {}
  rmSync(lockPath, { force: true })
}

mkdirSync(buildRoot, { recursive: true })
mkdirSync(destinationDir, { recursive: true })
const stageLockPath = path.join(destinationDir, '.stage.lock')
const stageLock = acquireStageLock(stageLockPath)
try {
  const removedOrphans = reconcileAeOrphans({ buildRoot })
  if (removedOrphans.length > 0) {
    console.log(`[stage-ae-executive] removed dead-owner candidates: ${removedOrphans.join(', ')}`)
  }
  rmSync(candidateDir, { force: true, recursive: true })
  rmSync(cargoTargetRoot, { force: true, recursive: true })
  mkdirSync(candidateDir, { recursive: true })

  const sourceBefore = {
    ae: repositoryIdentity(aeRoot, AE_SOURCE_PATHS),
    costas: repositoryIdentity(costasRepositoryRoot, COSTAS_SOURCE_PATHS)
  }

  for (const artifact of artifacts) {
    if (!existsSync(artifact.manifest)) throw new Error(`[stage-ae-executive] missing manifest: ${artifact.manifest}`)
    const targetDir = path.join(cargoTargetRoot, artifact.target)
    run(
      'cargo',
      ['build', '--locked', '--offline', '--manifest-path', artifact.manifest, '--bin', artifact.bin],
      { env: { ...process.env, CARGO_TARGET_DIR: targetDir }, stdio: 'inherit' }
    )
    const source = path.join(targetDir, 'debug', `${artifact.bin}${suffix}`)
    if (!existsSync(source)) throw new Error(`[stage-ae-executive] missing build output: ${source}`)
    const destination = path.join(candidateDir, `${artifact.bin}${suffix}`)
    copyFileSync(source, destination)
    if (process.platform !== 'win32') chmodSync(destination, 0o755)
  }

  const skinSource = path.join(aeRoot, 'ugui', 'skins', 'bindings')
  if (!existsSync(skinSource)) throw new Error(`[stage-ae-executive] missing generated UGUI skins: ${skinSource}`)
  cpSync(skinSource, path.join(candidateDir, 'skins'), {
    recursive: true,
    filter: source => source === skinSource || source.endsWith('.json')
  })
  stageAeShellViewport({ aeRoot, destination: path.join(candidateDir, 'shell-viewport') })

  const smoke = smokeCandidate(candidateDir)
  const sourceAfter = {
    ae: repositoryIdentity(aeRoot, AE_SOURCE_PATHS),
    costas: repositoryIdentity(costasRepositoryRoot, COSTAS_SOURCE_PATHS)
  }
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    const changed = [
      JSON.stringify(sourceAfter.ae) !== JSON.stringify(sourceBefore.ae) ? 'AgentExperiments' : null,
      JSON.stringify(sourceAfter.costas) !== JSON.stringify(sourceBefore.costas) ? 'costas-code' : null
    ].filter(Boolean)
    throw new Error(`[stage-ae-executive] repository source changed during candidate build: ${changed.join(',')}`)
  }

  const artifactReceipts = artifacts.map(artifact => {
    const bytes = readFileSync(path.join(candidateDir, `${artifact.bin}${suffix}`))
    return { name: artifact.bin, sha256: sha256(bytes), bytes: bytes.length }
  })
  const resources = [
    directoryReceipt('shell-viewport', path.join(candidateDir, 'shell-viewport')),
    directoryReceipt('skins', path.join(candidateDir, 'skins'))
  ]
  const unsigned = {
    schema: 'costas-ae-generation/1',
    ae: sourceAfter.ae,
    costas: sourceAfter.costas,
    artifacts: artifactReceipts,
    resources,
    smoke
  }
  const manifest = {
    schema: unsigned.schema,
    generation_id: computeAeGenerationId(unsigned),
    ae: unsigned.ae,
    costas: unsigned.costas,
    artifacts: unsigned.artifacts,
    resources: unsigned.resources,
    smoke: unsigned.smoke
  }
  validateAeGenerationManifest(manifest)
  writeFileSync(path.join(candidateDir, 'generation.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

  const publication = publishAeGenerationStore({
    candidateDir,
    storeDir: destinationDir,
    manifest,
    validateCandidate
  })
  console.log(
    `[stage-ae-executive] published ${manifest.generation_id} -> ${publication.generationDir}`
  )
  rmSync(cargoTargetRoot, { force: true, recursive: true })
  releaseStageLock(stageLock, stageLockPath)
} catch (error) {
  rmSync(candidateDir, { force: true, recursive: true })
  rmSync(cargoTargetRoot, { force: true, recursive: true })
  releaseStageLock(stageLock, stageLockPath)
  throw error
}
