import fs from 'node:fs'
import path from 'node:path'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const NONCE_RE = /^[0-9a-f]{32}$/
const SOURCE_SCHEMA = 'catalyst-desktop-source/1'
const READY_SCHEMA = 'catalyst-desktop-readiness/1'

export interface LifecycleSourceReceipt {
  schema: typeof SOURCE_SCHEMA
  source_revision: string
  ae_generation: string
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function readLifecycleSourceReceipt(resourcesPath: string): LifecycleSourceReceipt | null {
  const target = path.join(resourcesPath, 'lifecycle-source.json')

  try {
    const metadata = fs.lstatSync(target)

    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4096) {
      return null
    }

    const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))

    if (
      !object(value) || !exact(value, ['schema', 'source_revision', 'ae_generation']) ||
      value.schema !== SOURCE_SCHEMA || typeof value.source_revision !== 'string' ||
      typeof value.ae_generation !== 'string' || !HASH_RE.test(value.source_revision) ||
      !HASH_RE.test(value.ae_generation)
    ) {
      return null
    }

    return value as unknown as LifecycleSourceReceipt
  } catch {
    return null
  }
}

export function createLifecycleReadinessReporter({
  environment,
  execPath,
  pid,
  source,
  aeGeneration
}: {
  environment: NodeJS.ProcessEnv
  execPath: string
  pid: number
  source: LifecycleSourceReceipt | null
  aeGeneration: string
}) {
  const names = [
    'HERMES_DESKTOP_LIFECYCLE_READY_PATH',
    'HERMES_DESKTOP_LIFECYCLE_LAUNCH_ID',
    'HERMES_DESKTOP_LIFECYCLE_LAUNCH_STARTED_MS',
    'HERMES_DESKTOP_LIFECYCLE_PACKAGE_REVISION',
    'HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION',
    'HERMES_DESKTOP_LIFECYCLE_AE_GENERATION',
    'HERMES_DESKTOP_LIFECYCLE_EXECUTABLE'
  ] as const
  const present = names.filter(name => environment[name] !== undefined)

  if (present.length === 0) {
    return null
  }

  if (present.length !== names.length || !source) {
    throw new Error('desktop-lifecycle-readiness-environment')
  }

  const readyPath = environment.HERMES_DESKTOP_LIFECYCLE_READY_PATH!
  const launchId = environment.HERMES_DESKTOP_LIFECYCLE_LAUNCH_ID!
  const launchStartedMs = Number(environment.HERMES_DESKTOP_LIFECYCLE_LAUNCH_STARTED_MS)
  const packageRevision = environment.HERMES_DESKTOP_LIFECYCLE_PACKAGE_REVISION!
  const sourceRevision = environment.HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION!
  const expectedGeneration = environment.HERMES_DESKTOP_LIFECYCLE_AE_GENERATION!
  const expectedExecutable = environment.HERMES_DESKTOP_LIFECYCLE_EXECUTABLE!

  if (
    !path.isAbsolute(readyPath) || readyPath.length > 4096 || readyPath.includes('\0') ||
    !NONCE_RE.test(launchId) || !Number.isSafeInteger(launchStartedMs) || launchStartedMs < 1 ||
    !HASH_RE.test(packageRevision) || !HASH_RE.test(sourceRevision) || !HASH_RE.test(expectedGeneration) ||
    source.source_revision !== sourceRevision || source.ae_generation !== expectedGeneration ||
    aeGeneration !== expectedGeneration || fs.realpathSync(execPath) !== expectedExecutable
  ) {
    throw new Error('desktop-lifecycle-readiness-binding')
  }

  let written = false

  return Object.freeze({
    rendererReady() {
      if (written) {
        return false
      }

      const parent = path.dirname(readyPath)
      const parentMetadata = fs.lstatSync(parent)

      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw new Error('desktop-lifecycle-readiness-parent')
      }

      if (fs.existsSync(readyPath) && fs.lstatSync(readyPath).isSymbolicLink()) {
        throw new Error('desktop-lifecycle-readiness-symlink')
      }

      const receipt = {
        schema: READY_SCHEMA,
        launch_id: launchId,
        launch_started_ms: launchStartedMs,
        pid,
        electron_main: true,
        renderer: true,
        package_revision: packageRevision,
        source_revision: sourceRevision,
        ae_generation: expectedGeneration
      }
      const temporary = path.join(parent, `.READY.${pid}.${launchId}.tmp`)

      fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, readyPath)
      written = true

      return true
    }
  })
}
