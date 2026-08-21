import assert from 'node:assert/strict'

import { test } from 'vitest'

import { chooseUpdaterArgs, hasUsableInstall } from './windows-hermes-path'

/**
 * Regression: Windows recovery deadlocked between --update and --repair.
 *
 * `handOffWindowsBootstrapRecovery` decided between the gentle in-place
 * `--update` and the destructive `--repair` purely from FILE EXISTENCE:
 *
 *     haveRealInstall = venvPython || venvHermes || bootstrapMarker
 *
 * Consider the exact field-report state — the `venv` stage succeeded and the
 * `dependencies` stage failed:
 *
 *   - `venv\Scripts\python.exe`  EXISTS  (venv stage created it)
 *   - `venv\Scripts\hermes.exe`  MISSING (console script is written at the END
 *                                        of a successful dependency install)
 *   - bootstrap-complete marker  MISSING (never finished)
 *
 * Because ANY one signal sufficed, `haveRealInstall` was true and recovery
 * chose `--update`. But the updater's `resolve_hermes()` REQUIRES `hermes.exe`
 * and exits with "Could not find the hermes CLI. Re-run the installer to
 * repair the install."
 *
 * Every Retry and every Repair returns through the same existence-only
 * classification, so the user is told to run the repair the app refuses to
 * run. That is the loop the field report was stuck in.
 *
 * The fix is NOT to revert to gating on `hermes.exe` alone — an earlier bug
 * (documented in windows-hermes-path.ts) came from exactly that and forced
 * needless destructive repairs on healthy installs. The fix is that "usable"
 * must mean the updater can actually be driven: an interpreter AND an entry
 * point it can invoke. Existence of one file is not proof of a working
 * install.
 */

test('interpreter present but no CLI entry point is NOT usable', () => {
  // The exact field-report state: venv stage succeeded, dependencies failed.
  assert.equal(
    hasUsableInstall({ venvPython: true, venvHermes: false, bootstrapMarker: false }),
    false,
    'a half-built venv must not be classified as a real install; --update dies on the missing CLI'
  )
})

test('a half-built venv routes to --repair', () => {
  const signals = { hasBootstrapMarker: false, hasVenvHermes: false, hasVenvPython: true }

  assert.deepEqual(chooseUpdaterArgs(signals, 'costas-code'), [
    '--repair',
    '--branch',
    'costas-code'
  ])
})

test('a completed install (marker + CLI) is usable and gets the gentle --update', () => {
  const signals = { hasBootstrapMarker: true, hasVenvHermes: true, hasVenvPython: true }

  assert.equal(hasUsableInstall({ venvPython: true, venvHermes: true, bootstrapMarker: true }), true)
  assert.deepEqual(chooseUpdaterArgs(signals, 'main'), ['--update', '--branch', 'main'])
})

test('a CLI shim without the marker is still usable', () => {
  // The updater only needs an entry point it can drive; a missing marker on an
  // otherwise working install must not trigger a destructive venv recreate.
  // This is the case the earlier fix was protecting.
  assert.equal(
    hasUsableInstall({ venvPython: true, venvHermes: true, bootstrapMarker: false }),
    true
  )
})

test('a completed bootstrap marker alone is trusted', () => {
  // A PATH-installed hermes (no venv shim in the update root) that finished
  // bootstrapping is a real install — repairing it would be destructive.
  assert.equal(
    hasUsableInstall({ venvPython: false, venvHermes: false, bootstrapMarker: true }),
    true
  )
})

test('nothing present is not usable', () => {
  assert.equal(
    hasUsableInstall({ venvPython: false, venvHermes: false, bootstrapMarker: false }),
    false
  )
})
