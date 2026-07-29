import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { performBootstrapRepair } from './bootstrap-repair'

/**
 * Regression: "Repair install" could report success without repairing anything.
 *
 * Three defects, all on the path a stuck Windows user actually clicks:
 *
 * 1. Marker deletion errors were logged but the IPC still returned
 *    `{ok: true}`, and the renderer reloads on any result. If antivirus,
 *    OneDrive, a permissions problem, or a file lock prevented removing the
 *    bootstrap-complete marker, the next boot trusted that same marker and
 *    skipped the repair entirely — the user clicks Repair, watches it "succeed",
 *    and lands in the identical failure.
 *
 * 2. Repair did not wait for the old backend to exit. Retry awaited
 *    `teardownPrimaryBackendAndWait()`, but Repair only called the synchronous
 *    `resetHermesConnection()` and the renderer reloaded immediately, so a new
 *    installer could race a still-exiting process holding venv DLLs open —
 *    on Windows that's a locked-file failure mid-reinstall.
 *
 * 3. Repair must force an installer refetch. See bootstrap-repair-cache.test.ts.
 */

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-repair-'))
}

test('a marker that cannot be removed reports failure instead of false success', async () => {
  const home = mkTmpHome()

  try {
    const marker = path.join(home, '.hermes-bootstrap-complete')
    fs.writeFileSync(marker, 'x')

    const result = await performBootstrapRepair({
      markerPath: marker,
      teardown: async () => {},
      resetConnection: () => {},
      log: () => {},
      // Simulate AV / OneDrive / permission denial on the unlink.
      removeFile: () => {
        throw new Error('EPERM: operation not permitted')
      },
      fileExists: (p: string) => fs.existsSync(p)
    })

    assert.equal(result.ok, false, 'a failed marker removal must not report success')
    assert.match(String(result.error), /EPERM|marker/i)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a marker that silently survives removal is caught by verification', async () => {
  const home = mkTmpHome()

  try {
    const marker = path.join(home, '.hermes-bootstrap-complete')
    fs.writeFileSync(marker, 'x')

    const result = await performBootstrapRepair({
      markerPath: marker,
      teardown: async () => {},
      resetConnection: () => {},
      log: () => {},
      // No throw, but the file is still there afterwards.
      removeFile: () => {},
      fileExists: (p: string) => fs.existsSync(p)
    })

    assert.equal(
      result.ok,
      false,
      'repair must verify the marker is actually gone, not trust a silent no-op'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the backend is torn down before the marker is removed', async () => {
  const home = mkTmpHome()

  try {
    const marker = path.join(home, '.hermes-bootstrap-complete')
    fs.writeFileSync(marker, 'x')

    const order: string[] = []

    const result = await performBootstrapRepair({
      markerPath: marker,
      teardown: async () => {
        // Simulate a process that takes a moment to actually exit.
        await new Promise(r => setTimeout(r, 10))
        order.push('teardown')
      },
      resetConnection: () => order.push('reset'),
      log: () => {},
      removeFile: (p: string) => {
        order.push('remove-marker')
        fs.rmSync(p, { force: true })
      },
      fileExists: (p: string) => fs.existsSync(p)
    })

    assert.equal(result.ok, true)
    assert.equal(
      order[0],
      'teardown',
      'the old backend must be fully stopped before reinstalling over its venv'
    )
    assert.ok(order.includes('remove-marker'))
    assert.ok(
      order.indexOf('teardown') < order.indexOf('remove-marker'),
      'teardown must complete before the marker is dropped'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a clean repair succeeds and requests a forced installer refresh', async () => {
  const home = mkTmpHome()

  try {
    const marker = path.join(home, '.hermes-bootstrap-complete')
    fs.writeFileSync(marker, 'x')

    const result = await performBootstrapRepair({
      markerPath: marker,
      teardown: async () => {},
      resetConnection: () => {},
      log: () => {},
      removeFile: (p: string) => fs.rmSync(p, { force: true }),
      fileExists: (p: string) => fs.existsSync(p)
    })

    assert.equal(result.ok, true)
    assert.equal(
      result.forceRefresh,
      true,
      'repair must instruct the next bootstrap to refetch the installer'
    )
    assert.equal(fs.existsSync(marker), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a missing marker is not an error', async () => {
  const home = mkTmpHome()

  try {
    const marker = path.join(home, '.hermes-bootstrap-complete')
    let removeCalled = false

    const result = await performBootstrapRepair({
      markerPath: marker,
      teardown: async () => {},
      resetConnection: () => {},
      log: () => {},
      removeFile: () => {
        removeCalled = true
      },
      fileExists: (p: string) => fs.existsSync(p)
    })

    assert.equal(result.ok, true, 'repairing an install with no marker is valid')
    assert.equal(removeCalled, false, 'nothing to remove')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
