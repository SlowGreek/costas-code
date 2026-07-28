import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLifecycleReadinessReporter, readLifecycleSourceReceipt } from './lifecycle-readiness'

const roots: string[] = []
const hash = (character: string) => `sha256:${character.repeat(64)}`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-readiness-'))
  roots.push(root)
  const executable = path.join(root, 'Catalyst')
  fs.writeFileSync(executable, 'binary')
  const source = { schema: 'catalyst-desktop-source/1' as const, source_revision: hash('1'), ae_generation: hash('2') }
  fs.writeFileSync(path.join(root, 'lifecycle-source.json'), `${JSON.stringify(source)}\n`)
  const environment = {
    HERMES_DESKTOP_LIFECYCLE_READY_PATH: path.join(root, 'READY.json'),
    HERMES_DESKTOP_LIFECYCLE_LAUNCH_ID: 'a'.repeat(32),
    HERMES_DESKTOP_LIFECYCLE_LAUNCH_STARTED_MS: '42',
    HERMES_DESKTOP_LIFECYCLE_PACKAGE_REVISION: hash('3'),
    HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION: source.source_revision,
    HERMES_DESKTOP_LIFECYCLE_AE_GENERATION: source.ae_generation,
    HERMES_DESKTOP_LIFECYCLE_EXECUTABLE: fs.realpathSync(executable)
  }
  return { root, executable, source, environment }
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('Electron lifecycle readiness', () => {
  it('writes one source/package/generation-bound receipt only after renderer acknowledgement', () => {
    const value = fixture()
    const reporter = createLifecycleReadinessReporter({
      environment: value.environment,
      execPath: value.executable,
      pid: 77,
      source: readLifecycleSourceReceipt(value.root),
      aeGeneration: value.source.ae_generation
    })
    expect(fs.existsSync(path.join(value.root, 'READY.json'))).toBe(false)
    expect(reporter?.rendererReady()).toBe(true)
    expect(reporter?.rendererReady()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(value.root, 'READY.json'), 'utf8'))).toMatchObject({
      electron_main: true,
      renderer: true,
      pid: 77,
      package_revision: hash('3'),
      source_revision: hash('1'),
      ae_generation: hash('2')
    })
  })

  it('rejects a package source or executable mismatch', () => {
    const value = fixture()
    expect(() => createLifecycleReadinessReporter({
      environment: { ...value.environment, HERMES_DESKTOP_LIFECYCLE_SOURCE_REVISION: hash('9') },
      execPath: value.executable,
      pid: 77,
      source: value.source,
      aeGeneration: value.source.ae_generation
    })).toThrow('desktop-lifecycle-readiness-binding')
  })
})
