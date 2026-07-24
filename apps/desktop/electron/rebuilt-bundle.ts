/**
 * rebuilt-bundle.ts
 *
 * Pure, electron-free resolution of the macOS .app bundle produced by
 * `hermes desktop --build-only`, for the in-app update swap.
 *
 * Why this is not a hardcoded name list: the updater that performs a swap is
 * the OLD build, but the bundle it must find was produced by the NEW one. Any
 * list baked into the running app is therefore a list written before the name
 * it needs to match existed. That is exactly how the Costas Code -> Catalyst
 * rename stranded users: the installed build looked only for
 * `Costas Code.app` / `Hermes.app`, `--build-only` emitted `Catalyst.app`, the
 * swap silently no-oped, and the backend advanced while the GUI stayed stale.
 *
 * So we discover by shape instead of by name: scan the known release output
 * directories for `*.app`. A rename is then a non-event for every future
 * update, including renames nobody has thought of yet.
 *
 * Determinism matters — a swap must not depend on readdir order. When a
 * directory holds more than one bundle (stale output from a previous build
 * under the old name is the common case), we prefer, in order:
 *   1. a bundle whose name matches the running app (a same-name in-place
 *      update is the safest possible swap),
 *   2. then a `preferredName` supplied by the caller (the current product),
 *   3. then the most recently modified bundle, which is the one the rebuild
 *      just produced,
 *   4. then name order, purely to make ties reproducible.
 *
 * Kept standalone (no `import 'electron'`) so it is unit-testable — same
 * pattern as desktop-uninstall.ts / stale-bundles.ts. main.ts injects the
 * filesystem probes.
 */

import path from 'node:path'

/** electron-builder mac output dirs, most specific first. */
const MAC_RELEASE_DIRS = ['mac-arm64', 'mac', 'mac-universal', 'mac-x64'] as const

interface RebuiltBundleProbes {
  /** Entry names in a directory; must return [] for a missing directory. */
  readDir: (dirPath: string) => string[]
  /** True when the path is a directory (an .app bundle is one). */
  isDirectory: (candidatePath: string) => boolean
  /** Modification time in ms; return 0 when unavailable. */
  modifiedAtMs: (candidatePath: string) => number
}

interface ResolveRebuiltBundleOptions {
  /** Repo/install root that contains apps/desktop/release. */
  updateRoot: string
  probes: RebuiltBundleProbes
  /** Basename of the running bundle, e.g. 'Costas Code.app'. */
  runningBundleName?: string | null
  /** Current product bundle name, e.g. 'Catalyst.app'. */
  preferredName?: string | null
}

function releaseDirCandidates(updateRoot: string): string[] {
  const releaseRoot = path.join(updateRoot, 'apps', 'desktop', 'release')

  return MAC_RELEASE_DIRS.map(dirName => path.join(releaseRoot, dirName))
}

/**
 * Resolve the freshly-built .app bundle to swap into place, or null when the
 * rebuild produced nothing (dev run, non-mac, failed build).
 */
function resolveRebuiltMacBundle({
  updateRoot,
  probes,
  runningBundleName,
  preferredName
}: ResolveRebuiltBundleOptions): string | null {
  for (const releaseDir of releaseDirCandidates(updateRoot)) {
    let entries: string[]

    try {
      entries = probes.readDir(releaseDir)
    } catch {
      continue
    }

    const bundles = entries
      .filter(entryName => entryName.endsWith('.app'))
      .map(entryName => path.join(releaseDir, entryName))
      .filter(candidate => probes.isDirectory(candidate))

    if (bundles.length === 0) {
      continue
    }

    if (bundles.length === 1) {
      return bundles[0]
    }

    const ranked = bundles.slice().sort((left, right) => {
      const leftName = path.basename(left)
      const rightName = path.basename(right)

      // 1. same name as the running app — an in-place swap.
      if (runningBundleName) {
        const leftRunning = leftName === runningBundleName ? 0 : 1
        const rightRunning = rightName === runningBundleName ? 0 : 1

        if (leftRunning !== rightRunning) {
          return leftRunning - rightRunning
        }
      }

      // 2. the current product name.
      if (preferredName) {
        const leftPreferred = leftName === preferredName ? 0 : 1
        const rightPreferred = rightName === preferredName ? 0 : 1

        if (leftPreferred !== rightPreferred) {
          return leftPreferred - rightPreferred
        }
      }

      // 3. freshest build output wins.
      const mtimeDelta = probes.modifiedAtMs(right) - probes.modifiedAtMs(left)

      if (mtimeDelta !== 0) {
        return mtimeDelta
      }

      // 4. stable, reproducible tiebreak.
      return leftName.localeCompare(rightName)
    })

    return ranked[0]
  }

  return null
}

export { MAC_RELEASE_DIRS, releaseDirCandidates, resolveRebuiltMacBundle }
export type { RebuiltBundleProbes, ResolveRebuiltBundleOptions }
