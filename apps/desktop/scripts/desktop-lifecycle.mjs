import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverAeRepositoryRoot } from './ae-repository-root.mjs'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const NONCE_RE = /^[0-9a-f]{32}$/
const MAX_INPUT_FILES = 50_000
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_READINESS_BYTES = 16 * 1024
const SOURCE_SCHEMA = 'catalyst-desktop-source/1'
const POINTER_SCHEMA = 'catalyst-desktop-current/1'
const READY_SCHEMA = 'catalyst-desktop-readiness/1'
const PROCESS_SCHEMA = 'catalyst-desktop-process/1'

export const CATALYST_INPUT_PATHS = ['package.json', 'package-lock.json', 'hermes_cli', 'apps/desktop']
export const AE_WATCH_PATHS = [
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
export const AE_INPUT_PATHS = [...AE_WATCH_PATHS, ':(exclude)run/state', ':(exclude)run/target']

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function directFile(target, maximum = MAX_READINESS_BYTES) {
  const metadata = fs.lstatSync(target)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) {
    throw new Error('desktop-lifecycle-direct-file')
  }
  return metadata
}

function readJson(target, maximum = MAX_READINESS_BYTES) {
  directFile(target, maximum)
  const value = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (!object(value)) throw new Error('desktop-lifecycle-json-shape')
  return value
}

function atomicJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
  const observed = readJson(target)
  if (JSON.stringify(observed) !== JSON.stringify(value)) throw new Error('desktop-lifecycle-write-readback')
}

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`desktop-lifecycle-git:${result.error?.message || result.status}`)
  }
  return result.stdout
}

function repositoryFiles(root, pathspecs) {
  const raw = runGit(root, ['ls-files', '-co', '--exclude-standard', '-z', '--', ...pathspecs])
  const files = [...new Set(raw.toString('utf8').split('\0').filter(Boolean))].sort()
  if (files.length > MAX_INPUT_FILES) throw new Error('desktop-lifecycle-input-file-limit')
  return files
}

function hashRepository(digest, label, root, pathspecs) {
  const files = repositoryFiles(root, pathspecs)
  let bytes = 0
  for (const relative of files) {
    const target = path.join(root, relative)
    const metadata = fs.lstatSync(target)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`desktop-lifecycle-input-type:${label}:${relative}`)
    }
    bytes += metadata.size
    if (bytes > MAX_INPUT_BYTES) throw new Error('desktop-lifecycle-input-byte-limit')
    digest.update(label).update('\0').update(relative).update('\0')
    const descriptor = fs.openSync(target, 'r')
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null)
        if (count === 0) break
        digest.update(chunk.subarray(0, count))
      }
    } finally {
      fs.closeSync(descriptor)
    }
    digest.update('\0')
  }
  return { files: files.length, bytes }
}

export function lifecycleRoots({ scriptUrl = import.meta.url, start, environment = process.env } = {}) {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(scriptUrl)), '..')
  const catalystRoot = fs.realpathSync(path.resolve(desktopRoot, '..', '..'))
  const aeRoot = discoverAeRepositoryRoot({ start: start || catalystRoot, environment })
  return { aeRoot, catalystRoot, desktopRoot }
}

export function computeSourceSnapshot({ catalystRoot, aeRoot }) {
  const digest = createHash('sha256')
  const catalyst = hashRepository(digest, 'catalyst', catalystRoot, CATALYST_INPUT_PATHS)
  const ae = hashRepository(digest, 'ae', aeRoot, AE_INPUT_PATHS)
  return {
    schema: 'catalyst-desktop-inputs/1',
    source_revision: `sha256:${digest.digest('hex')}`,
    roots: { catalyst: catalystRoot, ae: aeRoot },
    watch: {
      catalyst: CATALYST_INPUT_PATHS.map(relative => path.join(catalystRoot, relative)),
      ae: AE_WATCH_PATHS.map(relative => path.join(aeRoot, relative))
    },
    files: catalyst.files + ae.files,
    bytes: catalyst.bytes + ae.bytes
  }
}

export function readAeCurrent(desktopRoot) {
  const value = readJson(path.join(desktopRoot, 'build', 'ae', 'CURRENT.json'), 4096)
  if (
    !exact(value, ['schema', 'generation_id', 'manifest_sha256']) ||
    value.schema !== 'costas-ae-current/1' ||
    !HASH_RE.test(value.generation_id) ||
    !HASH_RE.test(value.manifest_sha256)
  ) throw new Error('desktop-lifecycle-ae-current')
  return value
}

export function writeLifecycleSourceReceipt({ desktopRoot, snapshot }) {
  const current = readAeCurrent(desktopRoot)
  const expected = process.env.HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION
  if (expected && expected !== snapshot.source_revision) throw new Error('desktop-lifecycle-source-drift')
  const receipt = {
    schema: SOURCE_SCHEMA,
    source_revision: snapshot.source_revision,
    ae_generation: current.generation_id
  }
  atomicJson(path.join(desktopRoot, 'build', 'lifecycle-source.json'), receipt)
  return receipt
}

function walkPackage(root) {
  const rows = []
  let bytes = 0
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const metadata = fs.lstatSync(absolute)
      if (metadata.isDirectory()) walk(absolute, relative)
      else if (metadata.isFile()) {
        bytes += metadata.size
        if (bytes > MAX_INPUT_BYTES) throw new Error('desktop-lifecycle-package-byte-limit')
        rows.push({ absolute, relative, kind: 'file', mode: metadata.mode & 0o111 })
      } else if (metadata.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute)
        if (path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
          throw new Error(`desktop-lifecycle-package-symlink:${relative}`)
        }
        rows.push({ absolute, relative, kind: 'link', target })
      } else throw new Error(`desktop-lifecycle-package-type:${relative}`)
      if (rows.length > MAX_INPUT_FILES) throw new Error('desktop-lifecycle-package-file-limit')
    }
  }
  walk(root)
  return rows
}

export function packageReceipt(root) {
  const digest = createHash('sha256')
  const rows = walkPackage(root)
  for (const row of rows) {
    digest.update(row.kind).update('\0').update(row.relative).update('\0')
    if (row.kind === 'link') digest.update(row.target)
    else digest.update(String(row.mode)).update('\0').update(fs.readFileSync(row.absolute))
    digest.update('\0')
  }
  return { package_revision: `sha256:${digest.digest('hex')}`, files: rows.length }
}

function locateReleasePackage(desktopRoot) {
  const release = path.join(desktopRoot, 'release')
  const candidates = []
  if (process.platform === 'darwin') {
    for (const directory of fs.existsSync(release) ? fs.readdirSync(release) : []) {
      if (!directory.startsWith('mac')) continue
      for (const product of ['Catalyst', 'Costas Code', 'Hermes']) {
        const root = path.join(release, directory, `${product}.app`)
        const executable = path.join(root, 'Contents', 'MacOS', product)
        if (fs.existsSync(executable)) candidates.push({ root, executableRelative: `Contents/MacOS/${product}` })
      }
    }
  } else {
    const directories = process.platform === 'win32'
      ? ['win-unpacked', 'win-ia32-unpacked', 'win-arm64-unpacked']
      : ['linux-unpacked', 'linux-arm64-unpacked']
    const products = process.platform === 'win32'
      ? ['Catalyst.exe', 'Costas Code.exe', 'Hermes.exe']
      : ['Catalyst', 'Costas Code', 'hermes', 'Hermes']
    for (const directory of directories) {
      const root = path.join(release, directory)
      for (const product of products) {
        if (fs.existsSync(path.join(root, product))) candidates.push({ root, executableRelative: product })
      }
    }
  }
  if (candidates.length === 0) throw new Error('desktop-lifecycle-package-missing')
  return candidates.sort((left, right) => fs.statSync(right.root).mtimeMs - fs.statSync(left.root).mtimeMs)[0]
}

function validateSourceReceipt(packageRoot, expected) {
  const resources = process.platform === 'darwin'
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources')
  const value = readJson(path.join(resources, 'lifecycle-source.json'), 4096)
  if (
    !exact(value, ['schema', 'source_revision', 'ae_generation']) ||
    value.schema !== SOURCE_SCHEMA ||
    value.source_revision !== expected.source_revision ||
    !HASH_RE.test(value.source_revision) ||
    !HASH_RE.test(value.ae_generation)
  ) throw new Error('desktop-lifecycle-package-source')
  return value
}

export function promotePackage({ candidateRoot, stateRoot, sourceRevision, aeGeneration, executableRelative, rename = fs.renameSync }) {
  const observed = packageReceipt(candidateRoot)
  if (observed.package_revision !== sourceRevision.package_revision) throw new Error('desktop-lifecycle-package-drift')
  const packageName = observed.package_revision.slice('sha256:'.length)
  const packagesRoot = path.join(stateRoot, 'packages')
  const packageRoot = path.join(packagesRoot, packageName)
  fs.mkdirSync(packagesRoot, { recursive: true })
  if (fs.existsSync(packageRoot)) {
    if (packageReceipt(packageRoot).package_revision !== observed.package_revision) {
      throw new Error('desktop-lifecycle-package-collision')
    }
    fs.rmSync(candidateRoot, { recursive: true, force: true })
  } else rename(candidateRoot, packageRoot)

  const currentPath = path.join(stateRoot, 'CURRENT.json')
  let previous = null
  if (fs.existsSync(currentPath)) {
    const current = readCurrent(stateRoot)
    previous = {
      package_revision: current.package_revision,
      source_revision: current.source_revision,
      ae_generation: current.ae_generation,
      executable_relative: current.executable_relative
    }
  }
  const pointer = {
    schema: POINTER_SCHEMA,
    package_revision: observed.package_revision,
    source_revision: sourceRevision.source_revision,
    ae_generation: aeGeneration,
    executable_relative: executableRelative.replaceAll(path.sep, '/'),
    last_known_good: previous
  }
  atomicJson(currentPath, pointer)
  return { packageRoot, pointer }
}

export function readCurrent(stateRoot) {
  const value = readJson(path.join(stateRoot, 'CURRENT.json'))
  const keys = ['schema', 'package_revision', 'source_revision', 'ae_generation', 'executable_relative', 'last_known_good']
  if (
    !exact(value, keys) || value.schema !== POINTER_SCHEMA || !HASH_RE.test(value.package_revision) ||
    !HASH_RE.test(value.source_revision) || !HASH_RE.test(value.ae_generation) ||
    typeof value.executable_relative !== 'string' || value.executable_relative.length < 1 ||
    path.isAbsolute(value.executable_relative) || value.executable_relative.split('/').includes('..')
  ) throw new Error('desktop-lifecycle-current')
  return value
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}

export function claimLaunch({ stateRoot, isAlive = processAlive }) {
  fs.mkdirSync(stateRoot, { recursive: true })
  const processPath = path.join(stateRoot, 'PROCESS.json')
  if (fs.existsSync(processPath)) {
    const active = readJson(processPath)
    if (active.schema === PROCESS_SCHEMA && Number.isSafeInteger(active.pid) && active.pid > 0 && isAlive(active.pid)) {
      throw new Error(`desktop-lifecycle-duplicate-process:${active.pid}`)
    }
    fs.rmSync(processPath, { force: true })
  }
  const lockPath = path.join(stateRoot, '.launch.lock')
  let descriptor
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('desktop-lifecycle-launch-locked')
    throw error
  }
  return {
    commit(value) { atomicJson(processPath, value) },
    release() { try { fs.closeSync(descriptor) } finally { fs.rmSync(lockPath, { force: true }) } }
  }
}

export function validateReadiness(value, expected) {
  if (!exact(value, ['schema', 'launch_id', 'launch_started_ms', 'pid', 'electron_main', 'renderer', 'package_revision', 'source_revision', 'ae_generation'])) {
    throw new Error('desktop-lifecycle-readiness-fields')
  }
  if (
    value.schema !== READY_SCHEMA || value.launch_id !== expected.launch_id || !NONCE_RE.test(value.launch_id) ||
    value.launch_started_ms !== expected.launch_started_ms || value.pid !== expected.pid ||
    value.electron_main !== true || value.renderer !== true ||
    value.package_revision !== expected.package_revision || value.source_revision !== expected.source_revision ||
    value.ae_generation !== expected.ae_generation
  ) throw new Error('desktop-lifecycle-readiness-stale')
  return value
}

function stopLaunched(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch {}
}

async function waitForReadiness({ stateRoot, expected, timeoutMs }) {
  const target = path.join(stateRoot, 'READY.json')
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try { return validateReadiness(readJson(target), expected) } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`desktop-lifecycle-readiness-timeout:${lastError?.message || 'missing'}`)
}

function parseBuildArgv(environment) {
  const raw = environment.HERMES_DESKTOP_LIFECYCLE_BUILD_ARGV
  if (!raw || raw.length > 16 * 1024) throw new Error('desktop-lifecycle-build-command')
  const value = JSON.parse(raw)
  if (!Array.isArray(value) || value.length < 2 || value.length > 16 || value.some(token => typeof token !== 'string' || token.length < 1 || token.length > 4096)) {
    throw new Error('desktop-lifecycle-build-command')
  }
  return value
}

function runBuild({ roots, snapshot, environment }) {
  const argv = parseBuildArgv(environment)
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: roots.catalystRoot,
    env: { ...environment, HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION: snapshot.source_revision },
    stdio: ['ignore', 2, 2]
  })
  if (result.error || result.status !== 0) throw new Error(`desktop-lifecycle-build-failed:${result.error?.message || result.status}`)
}

export function buildPackage({ roots, stateRoot, snapshot, build = runBuild }) {
  if (fs.existsSync(path.join(stateRoot, 'CURRENT.json'))) {
    const current = readCurrent(stateRoot)
    const packageRoot = path.join(stateRoot, 'packages', current.package_revision.slice('sha256:'.length))
    if (current.source_revision === snapshot.source_revision && fs.existsSync(packageRoot) && packageReceipt(packageRoot).package_revision === current.package_revision) {
      return { built: false, packageRoot, pointer: current }
    }
  }

  build({ roots, snapshot, environment: process.env })
  const release = locateReleasePackage(roots.desktopRoot)
  const source = validateSourceReceipt(release.root, snapshot)
  const candidate = path.join(stateRoot, `.candidate-${process.pid}-${Date.now()}`)
  fs.rmSync(candidate, { recursive: true, force: true })
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.cpSync(release.root, candidate, { recursive: true, dereference: false, preserveTimestamps: true })
  const receipt = packageReceipt(candidate)
  const promoted = promotePackage({
    candidateRoot: candidate,
    stateRoot,
    sourceRevision: { source_revision: snapshot.source_revision, package_revision: receipt.package_revision },
    aeGeneration: source.ae_generation,
    executableRelative: release.executableRelative
  })
  return { built: true, ...promoted }
}

function launchFlags(environment) {
  const raw = environment.HERMES_DESKTOP_LIFECYCLE_ELECTRON_FLAGS || '[]'
  if (raw.length > 16 * 1024) throw new Error('desktop-lifecycle-electron-flags')
  const value = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > 32 || value.some(token => typeof token !== 'string' || token.length < 1 || token.length > 1024)) {
    throw new Error('desktop-lifecycle-electron-flags')
  }
  return value
}

async function launchCurrent({ stateRoot, timeoutMs, environment }) {
  const current = readCurrent(stateRoot)
  const packageRoot = path.join(stateRoot, 'packages', current.package_revision.slice('sha256:'.length))
  if (packageReceipt(packageRoot).package_revision !== current.package_revision) throw new Error('desktop-lifecycle-package-readback')
  const executable = path.join(packageRoot, ...current.executable_relative.split('/'))
  directFile(executable, MAX_INPUT_BYTES)
  const claim = claimLaunch({ stateRoot })
  const launchId = randomBytes(16).toString('hex')
  const launchStartedMs = Date.now()
  const readyPath = path.join(stateRoot, 'READY.json')
  fs.rmSync(readyPath, { force: true })
  let child
  try {
    child = spawn(executable, launchFlags(environment), {
      cwd: packageRoot,
      detached: true,
      env: {
        ...environment,
        HERMES_DESKTOP_LIFECYCLE_READY_PATH: readyPath,
        HERMES_DESKTOP_LIFECYCLE_LAUNCH_ID: launchId,
        HERMES_DESKTOP_LIFECYCLE_LAUNCH_STARTED_MS: String(launchStartedMs),
        HERMES_DESKTOP_LIFECYCLE_PACKAGE_REVISION: current.package_revision,
        HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION: current.source_revision,
        HERMES_DESKTOP_LIFECYCLE_AE_GENERATION: current.ae_generation,
        HERMES_DESKTOP_LIFECYCLE_EXECUTABLE: fs.realpathSync(executable)
      },
      stdio: 'ignore'
    })
    if (!child.pid) throw new Error('desktop-lifecycle-launch-pid')
    child.unref()
    const processReceipt = {
      schema: PROCESS_SCHEMA,
      pid: child.pid,
      launch_id: launchId,
      launch_started_ms: launchStartedMs,
      package_revision: current.package_revision,
      source_revision: current.source_revision,
      ae_generation: current.ae_generation,
      executable
    }
    claim.commit(processReceipt)
    claim.release()
    try {
      const readiness = await waitForReadiness({ stateRoot, expected: processReceipt, timeoutMs })
      return { process: processReceipt, readiness }
    } catch (error) {
      stopLaunched(child.pid)
      throw error
    }
  } catch (error) {
    try { claim.release() } catch {}
    throw error
  }
}

function stateRootFor(desktopRoot, environment) {
  const override = environment.HERMES_DESKTOP_LIFECYCLE_STATE_ROOT
  if (!override) return path.join(desktopRoot, 'build', 'desktop-lifecycle')
  if (!path.isAbsolute(override) || override.length > 4096 || override.includes('\0') || override.includes('\n') || override.includes('\r')) {
    throw new Error('desktop-lifecycle-state-root')
  }
  return path.resolve(override)
}

export async function executeLifecycle(op, { environment = process.env, timeoutMs = 30_000 } = {}) {
  if (!['inspect', 'build', 'launch', 'run', 'readiness'].includes(op)) throw new Error('desktop-lifecycle-operation')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('desktop-lifecycle-timeout')
  const roots = lifecycleRoots({ environment })
  const stateRoot = stateRootFor(roots.desktopRoot, environment)
  const snapshot = computeSourceSnapshot(roots)
  if (op === 'inspect') {
    const current = fs.existsSync(path.join(stateRoot, 'CURRENT.json')) ? readCurrent(stateRoot) : null
    return { schema: 'catalyst-desktop-lifecycle-result/1', op, state_root: stateRoot, snapshot, current }
  }
  if (op === 'build' || op === 'run') {
    const build = buildPackage({ roots, stateRoot, snapshot })
    if (op === 'build') return { schema: 'catalyst-desktop-lifecycle-result/1', op, state_root: stateRoot, snapshot, build }
  }
  if (op === 'launch' || op === 'run') {
    const launch = await launchCurrent({ stateRoot, timeoutMs, environment })
    return { schema: 'catalyst-desktop-lifecycle-result/1', op, state_root: stateRoot, snapshot, launch }
  }
  const processReceipt = readJson(path.join(stateRoot, 'PROCESS.json'))
  const readiness = validateReadiness(readJson(path.join(stateRoot, 'READY.json')), processReceipt)
  return { schema: 'catalyst-desktop-lifecycle-result/1', op, state_root: stateRoot, snapshot, readiness }
}
