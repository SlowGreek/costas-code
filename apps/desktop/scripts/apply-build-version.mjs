/**
 * apply-build-version.mjs
 *
 * Stamp a unique, SemVer-2.0.0-valid version into apps/desktop/package.json
 * before electron-builder reads it.
 *
 * Without this every CI artifact is `Catalyst-0.17.0-<os>-<arch>` regardless of
 * which commit produced it. A tester who downloads a new build sees the same
 * filename and the same About-box version as the old one and cannot tell
 * whether anything changed — and a bug report citing "0.17.0" identifies no
 * particular code. That confusion was reported from the field.
 *
 * Runs only when CI env vars are present, so a developer's local build keeps
 * its plain `0.17.0`. The write is reverted by `--restore` after packaging so
 * the working tree is never left dirty (electron-builder needs the version in
 * the file; it has no override flag for it).
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { buildVersionFromEnv, isValidSemver, baseOf } from './build-version.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..', 'package.json')
const BACKUP = join(HERE, '..', '.package.json.version-backup')

function readPkg() {
  return JSON.parse(readFileSync(PKG, 'utf8'))
}

/** Rewrite only the version line, preserving key order and formatting. */
function writeVersion(version) {
  const raw = readFileSync(PKG, 'utf8')
  const next = raw.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)

  if (next === raw) {
    throw new Error('could not locate the version field in package.json')
  }

  writeFileSync(PKG, next, 'utf8')
}

function apply() {
  const pkg = readPkg()
  const base = baseOf(pkg.version)
  const stamped = buildVersionFromEnv(base)

  if (stamped === pkg.version) {
    console.log(`[build-version] local build — keeping ${pkg.version}`)

    return
  }

  if (!isValidSemver(stamped)) {
    // Never ship an invalid version: electron-builder's failure here is
    // obscure, and a malformed version breaks update comparisons downstream.
    console.error(`[build-version] refusing invalid version: ${stamped}`)
    process.exit(1)
  }

  writeFileSync(BACKUP, pkg.version, 'utf8')
  writeVersion(stamped)
  console.log(`[build-version] ${pkg.version} -> ${stamped}`)
}

function restore() {
  let original
  try {
    original = readFileSync(BACKUP, 'utf8').trim()
  } catch {
    return // nothing was applied
  }

  if (original) {
    writeVersion(original)
    console.log(`[build-version] restored ${original}`)
  }

  try {
    writeFileSync(BACKUP, '', 'utf8')
  } catch {
    /* best effort */
  }
}

if (process.argv.includes('--restore')) {
  restore()
} else {
  apply()
}
