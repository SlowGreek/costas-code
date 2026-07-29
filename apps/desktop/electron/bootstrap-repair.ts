/**
 * "Repair install" recovery logic, extracted from the IPC handler so it can be
 * tested for real instead of only exercised through Electron.
 *
 * Repair is the affordance a stuck user clicks, so it must be honest about
 * failing. Previously it deleted the bootstrap-complete marker on a best-effort
 * basis, logged any error, and returned `{ok: true}` regardless; the renderer
 * reloads on any result. When antivirus, OneDrive, a permission problem, or a
 * file lock prevented the removal, the next boot trusted the surviving marker
 * and skipped the repair — the user watched Repair "succeed" and landed back in
 * the identical failure with no way out of the app.
 */

export interface BootstrapRepairDeps {
  /** Absolute path to the bootstrap-complete marker. */
  markerPath: string
  /** Fully stop the running backend and WAIT for the process to exit. */
  teardown: () => Promise<void>
  /** Drop in-memory connection state. */
  resetConnection: () => void
  log: (line: string) => void
  removeFile: (p: string) => void
  fileExists: (p: string) => boolean
}

export interface BootstrapRepairResult {
  ok: boolean
  error?: string
  /** Tells the next bootstrap pass to bypass the commit-keyed script cache. */
  forceRefresh?: boolean
}

export async function performBootstrapRepair(
  deps: BootstrapRepairDeps
): Promise<BootstrapRepairResult> {
  const { markerPath, teardown, resetConnection, log, removeFile, fileExists } = deps

  log('[bootstrap] repair requested; stopping backend before touching the install')

  // Stop the old backend FIRST and wait for it to actually exit. Reinstalling
  // over a venv whose DLLs are still mapped by a live process is a locked-file
  // failure on Windows.
  try {
    await teardown()
  } catch (error: any) {
    log(`[bootstrap] repair: backend teardown failed: ${error?.message ?? error}`)
  }

  if (fileExists(markerPath)) {
    try {
      removeFile(markerPath)
    } catch (error: any) {
      const message = `Could not remove the bootstrap marker: ${error?.message ?? error}`
      log(`[bootstrap] repair failed: ${message}`)

      return { ok: false, error: message }
    }

    // Verify rather than trust. A silent no-op leaves the marker in place and
    // the next boot skips repair.
    if (fileExists(markerPath)) {
      const message =
        'The bootstrap marker still exists after removal. Antivirus, OneDrive, or a ' +
        'file lock may be protecting it. Close the app and delete it manually: ' +
        markerPath
      log(`[bootstrap] repair failed: ${message}`)

      return { ok: false, error: message }
    }
  }

  resetConnection()

  return { ok: true, forceRefresh: true }
}
