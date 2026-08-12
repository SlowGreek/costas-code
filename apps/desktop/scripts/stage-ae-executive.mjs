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
  sourceChurnAction,
  validateAeGenerationManifest
} from './ae-generation.mjs'
import { discoverAeRepositoryRoot } from './ae-repository-root.mjs'
import { stageAeShellViewport } from './stage-ae-shell-viewport.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalystRoot = path.resolve(desktopRoot, '..', '..')
const catalystRepositoryRoot = realpathSync(catalystRoot)
const aeRoot = discoverAeRepositoryRoot({ start: catalystRepositoryRoot })
const buildRoot = path.join(desktopRoot, 'build')
const destinationDir = path.join(buildRoot, 'ae')
const candidateDir = path.join(buildRoot, `.ae-candidate-${process.pid}-${Date.now()}`)
const cargoTargetRoot = path.join(buildRoot, `.ae-cargo-${process.pid}-${Date.now()}`)
const suffix = process.platform === 'win32' ? '.exe' : ''
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const MAX_SOURCE_CHURN_RETRIES = 1
const AE_SOURCE_PATHS = [
  'Cargo.toml',
  'Cargo.lock',
  'run',
  ':(exclude)run/BUTLER-PACKAGE-LOCK.json',
  'genui',
  'butler',
  'envelope/LUCID.json',
  'envelope/MCP.json',
  'quine/src',
  'quine/Cargo.toml',
  'quine/Cargo.lock',
  'quine/canon',
  'quine/mcp/onboarding/index.json',
  // A receipt is evidence *about* this source, not an input to it. The quine
  // daemon rewrites them while we build, which would otherwise read as the
  // source moving underneath the candidate.
  ':(exclude)run/receipts',
  ':(exclude)genui/ugui/receipts',
  ':(exclude)butler/receipts',
  ':(exclude)genui/store/receipts',
  ':(exclude)genui/marketplace/receipts'
]
const CATALYST_SOURCE_PATHS = [
  'QUINE-COMPANION.json',
  'package.json',
  'package-lock.json',
  'apps/desktop'
]

const artifacts = [
  {
    manifest: path.join(aeRoot, 'run', 'Cargo.toml'),
    bin: 'ae-skin-settings-document',
    target: 'run'
  },
  {
    manifest: path.join(aeRoot, 'run', 'Cargo.toml'),
    bin: 'ae-executive-document',
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

function repositoryIdentity(root, pathspecs, base) {
  const commit = run('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024
  }).stdout.trim()
  // Diff against the base captured before the build: the quine daemon commits
  // green fixpoints while we build, and a commit must not read as a source
  // change when the watched files are byte-identical.
  const diff = run('git', ['diff', '--binary', '--no-ext-diff', base ?? commit, '--', ...pathspecs], {
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
  // Per-path digests so a mid-build change can name the files that moved
  // rather than only the repository that contains them.
  const touched = run('git', ['diff', '--name-only', base ?? commit, '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
    .stdout.split('\n')
    .filter(Boolean)
    .sort()

  return {
    root_realpath: root,
    commit,
    dirty: diff.length > 0 || untracked.length > 0,
    status_sha256: `sha256:${digest.digest('hex')}`,
    touched,
    untracked
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
  const tsx = path.join(catalystRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
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
    smoke.executive_documents !== manifest.smoke.executive_documents ||
    smoke.skin_settings_items !== manifest.smoke.skin_settings_items
  ) {
    throw new Error('[stage-ae-executive] smoke read-back mismatch')
  }
}

function acquireStageLock(lockPath) {
  const create = () => {
    const descriptor = openSync(lockPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify({ schema: 'catalyst-ae-stage-lock/1', pid: process.pid })}\n`)
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
    if (lock?.schema !== 'catalyst-ae-stage-lock/1' || !Number.isSafeInteger(lock.pid) || lock.pid < 1) {
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
  let smoke
  let sourceAfter
  for (let attempt = 0; ; attempt += 1) {
    rmSync(candidateDir, { force: true, recursive: true })
    rmSync(cargoTargetRoot, { force: true, recursive: true })
    mkdirSync(candidateDir, { recursive: true })

    const sourceBefore = {
      ae: repositoryIdentity(aeRoot, AE_SOURCE_PATHS),
      catalyst: repositoryIdentity(catalystRepositoryRoot, CATALYST_SOURCE_PATHS)
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

    const skinSource = path.join(aeRoot, 'genui', 'ugui', 'skins', 'bindings')
    if (!existsSync(skinSource)) throw new Error(`[stage-ae-executive] missing generated UGUI skins: ${skinSource}`)
    cpSync(skinSource, path.join(candidateDir, 'skins'), {
      recursive: true,
      filter: source => source === skinSource || source.endsWith('.json')
    })
    stageAeShellViewport({ aeRoot, destination: path.join(candidateDir, 'shell-viewport') })

    smoke = smokeCandidate(candidateDir)
    sourceAfter = {
      ae: repositoryIdentity(aeRoot, AE_SOURCE_PATHS, sourceBefore.ae.commit),
      catalyst: repositoryIdentity(
        catalystRepositoryRoot,
        CATALYST_SOURCE_PATHS,
        sourceBefore.catalyst.commit
      )
    }
    // Compare the watched content, not the commit that happens to contain it.
    const watchedContent = identity => ({
      root_realpath: identity.root_realpath,
      dirty: identity.dirty,
      status_sha256: identity.status_sha256
    })
    const changed = [
      JSON.stringify(watchedContent(sourceAfter.ae)) !==
      JSON.stringify(watchedContent(sourceBefore.ae))
        ? 'AgentExperiments'
        : null,
      JSON.stringify(watchedContent(sourceAfter.catalyst)) !==
      JSON.stringify(watchedContent(sourceBefore.catalyst))
        ? 'catalyst'
        : null
    ].filter(Boolean)
    if (changed.length === 0) break

    const moved = [
      ...new Set([
        ...sourceAfter.ae.touched,
        ...sourceAfter.ae.untracked,
        ...sourceAfter.catalyst.touched,
        ...sourceAfter.catalyst.untracked
      ])
    ].filter(
      file =>
        ![
          ...sourceBefore.ae.touched,
          ...sourceBefore.ae.untracked,
          ...sourceBefore.catalyst.touched,
          ...sourceBefore.catalyst.untracked
        ].includes(file)
    )
    const detail =
      `[stage-ae-executive] repository source changed during candidate build: ${changed.join(',')}` +
      (moved.length > 0 ? ` · moved: ${moved.slice(0, 12).join(' ')}` : ' · same files, new content')

    if (sourceChurnAction(attempt, MAX_SOURCE_CHURN_RETRIES) === 'retry') {
      console.warn(`${detail} · rebuilding candidate once`)
      continue
    }

    // Churn is evidence, not a launch veto. The candidate has built and smoked;
    // persistent edits are picked up by the next generation instead of blocking RUN.
    console.warn(`${detail} · publishing smoke-validated candidate after retry`)
    break
  }

  const artifactReceipts = artifacts.map(artifact => {
    const bytes = readFileSync(path.join(candidateDir, `${artifact.bin}${suffix}`))
    return { name: artifact.bin, sha256: sha256(bytes), bytes: bytes.length }
  })
  const resources = [
    directoryReceipt('shell-viewport', path.join(candidateDir, 'shell-viewport')),
    directoryReceipt('skins', path.join(candidateDir, 'skins'))
  ]
  // The manifest's identity is a closed four-field record; `touched` and
  // `untracked` exist only to name files when the guard above trips.
  const recorded = ({ root_realpath, commit, dirty, status_sha256 }) => ({
    root_realpath,
    commit,
    dirty,
    status_sha256
  })
  const unsigned = {
    schema: 'catalyst-ae-generation/1',
    ae: recorded(sourceAfter.ae),
    catalyst: recorded(sourceAfter.catalyst),
    artifacts: artifactReceipts,
    resources,
    smoke
  }
  const manifest = {
    schema: unsigned.schema,
    generation_id: computeAeGenerationId(unsigned),
    ae: unsigned.ae,
    catalyst: unsigned.catalyst,
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
