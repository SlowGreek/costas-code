import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { cachedScriptPath, resolveInstallScript } from './bootstrap-runner'

/**
 * Regression: "Repair install" could never reach a fixed installer.
 *
 * The install script is cached under a filename keyed by the packaged app's
 * build SHA, and a commit-pinned cache entry is treated as immutable — always
 * reused, never refetched. Repair only deletes the bootstrap-complete marker;
 * it does not invalidate that cache.
 *
 * So an app whose pinned `install.ps1` fails at the `dependencies` stage keeps
 * re-running *that same broken script* on every Retry and every Repair, forever.
 * A corrected installer on the distribution branch is unreachable from inside
 * the failing app — the user's only escape is a manual uninstall/reinstall.
 * This is precisely the state the Windows field report was stuck in.
 *
 * The fix: give the resolver an explicit `forceRefresh` so the recovery path
 * can bypass the commit-keyed cache, while the normal first-launch path keeps
 * its fast immutable-cache behavior.
 */

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-repair-cache-'))
}

test('forceRefresh refetches a pinned script instead of reusing the cache', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho STALE-BROKEN\n')

    let downloaded = false

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      forceRefresh: true,
      _download: async (_ref: string, dest: string) => {
        downloaded = true
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, '#!/bin/sh\necho FIXED\n')

        return dest
      }
    })

    assert.equal(
      downloaded,
      true,
      'Repair must refetch the installer; reusing the commit-keyed cache makes recovery impossible'
    )
    assert.equal(result.source, 'download')
    assert.match(fs.readFileSync(result.path, 'utf8'), /FIXED/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a refresh that fails still falls back to the cached script', async () => {
  // Repair on a machine that is briefly offline must not become *worse* than
  // no repair at all: if the refetch fails, the previously cached installer is
  // still better than nothing.
  const home = mkTmpHome()

  try {
    const commit = 'b'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho CACHED\n')

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      forceRefresh: true,
      _download: async () => {
        throw new Error('offline')
      }
    })

    assert.equal(result.source, 'cache', 'a failed refresh must degrade to the cached script')
    assert.match(fs.readFileSync(result.path, 'utf8'), /CACHED/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('without forceRefresh a pinned cache entry is still reused', async () => {
  // The normal first-launch path must keep its fast immutable-cache behavior;
  // only recovery pays for a refetch.
  const home = mkTmpHome()

  try {
    const commit = 'c'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho CACHED\n')

    let downloaded = false

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      _download: async () => {
        downloaded = true

        return cached
      }
    })

    assert.equal(downloaded, false, 'normal launches must not refetch a pinned script')
    assert.equal(result.source, 'cache')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
