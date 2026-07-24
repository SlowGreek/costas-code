/**
 * stale-bundles.ts
 *
 * Pure, electron-free helpers that identify superseded macOS app bundles left
 * behind by the product rename (Hermes -> Costas Code -> Catalyst) and by
 * hand-made rollback copies.
 *
 * Why this exists: every one of those bundles carries the SAME bundle id
 * (com.nousresearch.hermes) and registers the same `hermes://` URL scheme. When
 * several are present, LaunchServices picks a winner on its own, so a user who
 * "installed the update" can still be launching a months-old build — and deep
 * links can open the wrong app entirely. Removing the superseded copies is what
 * makes the newly-installed app unambiguously the one that runs.
 *
 * Kept standalone (no `import 'electron'`) so it can be unit-tested directly —
 * same pattern as desktop-uninstall.ts / desktop-user-data.ts. main.ts wires it
 * into the electron-coupled layer.
 *
 * Safety rules encoded here, in order of importance:
 *   1. NEVER propose the running bundle. Deleting yourself is the one
 *      unrecoverable mistake available to this code.
 *   2. Only ever consider bundles that are siblings of the running app, so a
 *      user-relocated install can't reach across the filesystem.
 *   3. Only match names this product has actually shipped or that follow the
 *      local `CostasCode.rollback*` convention — never a generic `.app` sweep.
 */

import path from 'node:path'

/** Bundle base-names this product has shipped under, past and present. */
const SHIPPED_BUNDLE_NAMES = ['Catalyst', 'Costas Code', 'CostasCode', 'Hermes'] as const

/**
 * Local rollback copies (`CostasCode.rollback.app`,
 * `CostasCode.rollback-final.app`, ...). Matched by prefix because the suffix
 * is ad-hoc, but still anchored to a shipped name so it can't match anything
 * unrelated that happens to live alongside the app.
 */
const ROLLBACK_SUFFIX_PATTERN = /^(.+?)\.rollback(?:-[A-Za-z0-9._-]+)?$/

interface StaleBundleOptions {
  /** Absolute path of the currently-running .app bundle. */
  runningAppPath: string
  /** Names of entries in the directory that contains the running bundle. */
  siblingNames: string[]
}

function bundleBaseName(entryName: string): string | null {
  if (!entryName.endsWith('.app')) {return null}

  return entryName.slice(0, -'.app'.length)
}

function isSupersededBundleName(baseName: string): boolean {
  if ((SHIPPED_BUNDLE_NAMES as readonly string[]).includes(baseName)) {return true}

  const rollback = ROLLBACK_SUFFIX_PATTERN.exec(baseName)

  if (!rollback) {return false}

  return (SHIPPED_BUNDLE_NAMES as readonly string[]).includes(rollback[1])
}

/**
 * Absolute paths of app bundles that are superseded by the running one.
 *
 * Returns an empty array when nothing qualifies — including when the running
 * bundle is the only shipped-name bundle present, which is the steady state
 * after the first cleanup.
 */
function staleBundlePaths({ runningAppPath, siblingNames }: StaleBundleOptions): string[] {
  const runningDir = path.dirname(runningAppPath)
  const runningName = path.basename(runningAppPath)

  const stale: string[] = []

  for (const entryName of siblingNames) {
    // Rule 1: never propose the running bundle.
    if (entryName === runningName) {continue}

    const baseName = bundleBaseName(entryName)

    if (!baseName) {continue}

    if (!isSupersededBundleName(baseName)) {continue}

    // Rule 2: siblings only — path.join keeps this inside runningDir.
    stale.push(path.join(runningDir, entryName))
  }

  return stale
}

export { ROLLBACK_SUFFIX_PATTERN, SHIPPED_BUNDLE_NAMES, staleBundlePaths }
export type { StaleBundleOptions }
