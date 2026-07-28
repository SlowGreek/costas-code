import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  buildPackage,
  claimLaunch,
  computeSourceSnapshot,
  packageReceipt,
  promotePackage,
  readCurrent,
  validateReadiness
} from './desktop-lifecycle.mjs'

const roots = []
const temp = label => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `desktop-lifecycle-${label}-`))
  roots.push(root)
  return root
}
const write = (root, relative, content = relative) => {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}
const hash = character => `sha256:${character.repeat(64)}`

function gitFixture(label, files) {
  const root = temp(label)
  const init = spawnSync('git', ['init', '-q'], { cwd: root })
  assert.equal(init.status, 0)
  for (const [relative, content] of Object.entries(files)) write(root, relative, content)
  const add = spawnSync('git', ['add', '.'], { cwd: root })
  assert.equal(add.status, 0)
  return root
}

function pointer(overrides = {}) {
  return {
    schema: 'catalyst-desktop-current/1',
    package_revision: hash('1'),
    source_revision: hash('2'),
    ae_generation: hash('3'),
    executable_relative: 'Catalyst',
    last_known_good: null,
    ...overrides
  }
}

function readiness(overrides = {}) {
  return {
    schema: 'catalyst-desktop-readiness/1',
    launch_id: 'a'.repeat(32),
    launch_started_ms: 42,
    pid: 123,
    electron_main: true,
    renderer: true,
    package_revision: hash('1'),
    source_revision: hash('2'),
    ae_generation: hash('3'),
    ...overrides
  }
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('desktop lifecycle source hashing', () => {
  test('is a no-op when relevant bytes are unchanged despite mtime churn', () => {
    const catalystRoot = gitFixture('catalyst', {
      'package.json': '{}',
      'apps/desktop/main.ts': 'desktop',
      'hermes_cli/main.py': 'cli'
    })
    const aeRoot = gitFixture('ae', {
      'Cargo.toml': '[workspace]',
      'run/input.json': '{}',
      'ugui/skin.json': '{}'
    })
    const first = computeSourceSnapshot({ catalystRoot, aeRoot })
    const source = path.join(catalystRoot, 'apps/desktop/main.ts')
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(source, future, future)
    const second = computeSourceSnapshot({ catalystRoot, aeRoot })
    assert.equal(second.source_revision, first.source_revision)
    assert.equal(second.files, first.files)
  })
})

describe('desktop lifecycle build and promotion', () => {
  test('build failure preserves the selected last-known-good package', () => {
    const root = temp('build-red')
    const stateRoot = path.join(root, 'state')
    const packageRoot = path.join(stateRoot, 'packages', hash('1').slice(7))
    write(packageRoot, 'Catalyst', 'last-good')
    const actual = packageReceipt(packageRoot).package_revision
    const current = pointer({ package_revision: actual })
    write(stateRoot, 'CURRENT.json', `${JSON.stringify(current)}\n`)

    assert.throws(
      () => buildPackage({
        roots: { desktopRoot: path.join(root, 'desktop') },
        stateRoot,
        snapshot: { source_revision: hash('9') },
        build: () => { throw new Error('builder-red') }
      }),
      /builder-red/
    )
    assert.deepEqual(readCurrent(stateRoot), current)
    assert.equal(fs.readFileSync(path.join(packageRoot, 'Catalyst'), 'utf8'), 'last-good')
  })

  test('atomic pointer promotion binds new current and prior last-known-good together', () => {
    const root = temp('promote')
    const stateRoot = path.join(root, 'state')
    const oldRoot = path.join(stateRoot, 'packages', 'old')
    write(oldRoot, 'Catalyst', 'old')
    const oldRevision = packageReceipt(oldRoot).package_revision
    const old = pointer({ package_revision: oldRevision })
    write(stateRoot, 'CURRENT.json', `${JSON.stringify(old)}\n`)
    const candidate = path.join(root, 'candidate')
    write(candidate, 'Catalyst', 'new')
    const receipt = packageReceipt(candidate)

    const promoted = promotePackage({
      candidateRoot: candidate,
      stateRoot,
      sourceRevision: { source_revision: hash('8'), package_revision: receipt.package_revision },
      aeGeneration: hash('7'),
      executableRelative: 'Catalyst'
    })

    assert.equal(readCurrent(stateRoot).package_revision, receipt.package_revision)
    assert.deepEqual(promoted.pointer.last_known_good, {
      package_revision: old.package_revision,
      source_revision: old.source_revision,
      ae_generation: old.ae_generation,
      executable_relative: old.executable_relative
    })
    assert.equal(fs.readFileSync(path.join(promoted.packageRoot, 'Catalyst'), 'utf8'), 'new')
  })

  test('candidate publication failure leaves CURRENT untouched', () => {
    const root = temp('atomic-red')
    const stateRoot = path.join(root, 'state')
    const old = pointer()
    write(stateRoot, 'CURRENT.json', `${JSON.stringify(old)}\n`)
    const candidate = path.join(root, 'candidate')
    write(candidate, 'Catalyst', 'new')
    const receipt = packageReceipt(candidate)
    assert.throws(() => promotePackage({
      candidateRoot: candidate,
      stateRoot,
      sourceRevision: { source_revision: hash('8'), package_revision: receipt.package_revision },
      aeGeneration: hash('7'),
      executableRelative: 'Catalyst',
      rename: () => { throw new Error('rename-red') }
    }), /rename-red/)
    assert.deepEqual(readCurrent(stateRoot), old)
  })
})

describe('desktop lifecycle launch/readiness admission', () => {
  test('rejects malformed and stale readiness receipts', () => {
    const expected = readiness()
    assert.throws(() => validateReadiness({ ...expected, extra: true }, expected), /readiness-fields/)
    assert.throws(() => validateReadiness(readiness({ launch_id: 'b'.repeat(32) }), expected), /readiness-stale/)
    assert.throws(() => validateReadiness(readiness({ renderer: false }), expected), /readiness-stale/)
  })

  test('refuses a duplicate live process before taking the launch lock', () => {
    const stateRoot = temp('duplicate')
    write(stateRoot, 'PROCESS.json', `${JSON.stringify({ schema: 'catalyst-desktop-process/1', pid: 77 })}\n`)
    assert.throws(() => claimLaunch({ stateRoot, isAlive: pid => pid === 77 }), /duplicate-process:77/)
    assert.equal(fs.existsSync(path.join(stateRoot, '.launch.lock')), false)
  })
})
