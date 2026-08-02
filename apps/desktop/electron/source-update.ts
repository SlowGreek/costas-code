import fs from 'node:fs'
import path from 'node:path'

import type { LifecycleSourceReceipt } from './lifecycle-readiness'

export interface DesktopSourceUpdateReady {
  schema: 'catalyst-source-update-ready/1'
  sourceRevision: string
  aeGeneration: string
  requiresRestart: true
}

export function sourceUpdateKey(receipt: LifecycleSourceReceipt) {
  return `${receipt.source_revision}:${receipt.ae_generation}`
}

export function nextSourceUpdate(
  active: LifecycleSourceReceipt | null,
  next: LifecycleSourceReceipt | null,
  announced: string | null
): DesktopSourceUpdateReady | null {
  if (!active || !next) {
    return null
  }

  const activeKey = sourceUpdateKey(active)
  const nextKey = sourceUpdateKey(next)

  if (nextKey === activeKey || nextKey === announced) {
    return null
  }

  return {
    schema: 'catalyst-source-update-ready/1',
    sourceRevision: next.source_revision,
    aeGeneration: next.ae_generation,
    requiresRestart: true
  }
}

export function requestRunSourceRestart(environment: NodeJS.ProcessEnv = process.env) {
  const requestPath = environment.AE_RUN_RESTART_REQUEST_PATH
  const childId = environment.AE_RUN_CHILD_ID
  const launchHash = environment.AE_RUN_LAUNCH_HASH

  if (
    childId !== 'catalyst-desktop' ||
    !requestPath || !path.isAbsolute(requestPath) || requestPath.includes('\0') ||
    !launchHash || !/^sha256:[0-9a-f]{64}$/.test(launchHash)
  ) {
    return { ok: false, error: 'run-restart-control-unavailable' }
  }

  const request = `${JSON.stringify({
    schema: 'ae-run-child-restart/1',
    child_id: childId,
    launch_hash: launchHash
  })}\n`

  const temporary = `${requestPath}.${process.pid}.tmp`

  try {
    const parent = path.dirname(requestPath)
    const parentMetadata = fs.lstatSync(parent)

    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      return { ok: false, error: 'run-restart-control-unsafe' }
    }

    if (fs.existsSync(requestPath)) {
      return fs.readFileSync(requestPath, 'utf8') === request
        ? { ok: true }
        : { ok: false, error: 'run-restart-control-conflict' }
    }

    fs.writeFileSync(temporary, request, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, requestPath)

    return { ok: true }
  } catch {
    try {fs.rmSync(temporary, { force: true })} catch {void 0}

    return { ok: false, error: 'run-restart-control-failed' }
  }
}
