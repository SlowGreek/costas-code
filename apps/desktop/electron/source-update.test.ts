import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { LifecycleSourceReceipt } from './lifecycle-readiness'
import { nextSourceUpdate, requestRunSourceRestart, sourceUpdateKey } from './source-update'

const roots: string[] = []
const hash = (character: string) => `sha256:${character.repeat(64)}`

const receipt = (source: string, generation: string): LifecycleSourceReceipt => ({
  schema: 'catalyst-desktop-source/1',
  source_revision: hash(source),
  ae_generation: hash(generation)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-source-update-'))
  roots.push(root)

  return {
    root,
    requestPath: path.join(root, 'restart-catalyst-desktop.request')
  }
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('source update admission', () => {
  it('announces a newer receipt once and requires a restart', () => {
    const active = receipt('a', 'b')
    const next = receipt('c', 'd')
    const update = nextSourceUpdate(active, next, null)

    expect(update).toEqual({
      schema: 'catalyst-source-update-ready/1',
      sourceRevision: hash('c'),
      aeGeneration: hash('d'),
      requiresRestart: true
    })
    expect(nextSourceUpdate(active, next, sourceUpdateKey(next))).toBeNull()
    expect(nextSourceUpdate(active, active, null)).toBeNull()
  })
})

describe('RUN restart request', () => {
  it('writes one launch-bound request and admits an identical retry', () => {
    const value = fixture()

    const environment = {
      AE_RUN_CHILD_ID: 'catalyst-desktop',
      AE_RUN_LAUNCH_HASH: hash('e'),
      AE_RUN_RESTART_REQUEST_PATH: value.requestPath
    }

    expect(requestRunSourceRestart(environment)).toEqual({ ok: true })
    expect(requestRunSourceRestart(environment)).toEqual({ ok: true })
    expect(JSON.parse(fs.readFileSync(value.requestPath, 'utf8'))).toEqual({
      schema: 'ae-run-child-restart/1',
      child_id: 'catalyst-desktop',
      launch_hash: hash('e')
    })
  })

  it('refuses an unbound or conflicting request', () => {
    const value = fixture()
    expect(requestRunSourceRestart({})).toEqual({
      ok: false,
      error: 'run-restart-control-unavailable'
    })
    fs.writeFileSync(value.requestPath, '{}\n')
    expect(requestRunSourceRestart({
      AE_RUN_CHILD_ID: 'catalyst-desktop',
      AE_RUN_LAUNCH_HASH: hash('f'),
      AE_RUN_RESTART_REQUEST_PATH: value.requestPath
    })).toEqual({
      ok: false,
      error: 'run-restart-control-conflict'
    })
  })
})
