import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DESKTOP = path.join(ROOT, 'apps', 'desktop')
export const QUALITY = path.join(ROOT, 'quality')
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_SOURCE_FILES = 20_000
const SOURCE_ENTRIES = [
  'SPEC.json',
  'package.json',
  'package-lock.json',
  'scripts/quality',
  'apps/desktop/package.json',
  'apps/desktop/eslint.config.mjs',
  'apps/desktop/vite.config.ts',
  'apps/desktop/vitest.config.ts',
  'apps/desktop/vitest.setup.ts',
  'apps/desktop/tsconfig.json',
  'apps/desktop/tsconfig.electron.json',
  'apps/desktop/tsconfig.e2e.json',
  'apps/desktop/electron',
  'apps/desktop/src',
  'apps/desktop/scripts'
]
const EXCLUDED_DIRECTORIES = new Set(['build', 'coverage', 'dist', 'node_modules', 'release'])

function safeFile(relative, absolute) {
  const metadata = fs.lstatSync(absolute)
  if (metadata.isSymbolicLink()) throw new Error(`quality-source-symlink:${relative}`)
  if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024) throw new Error(`quality-source-file:${relative}`)
  return metadata
}

function collect(relative, output) {
  const absolute = path.join(ROOT, ...relative.split('/'))
  const metadata = fs.lstatSync(absolute)
  if (metadata.isSymbolicLink()) throw new Error(`quality-source-symlink:${relative}`)
  if (metadata.isFile()) {
    safeFile(relative, absolute)
    output.push(relative)
    return
  }
  if (!metadata.isDirectory()) throw new Error(`quality-source-type:${relative}`)
  for (const name of fs.readdirSync(absolute).sort()) {
    if (EXCLUDED_DIRECTORIES.has(name)) continue
    collect(`${relative}/${name}`, output)
  }
}

export function sourceReceipt() {
  const files = []
  for (const entry of SOURCE_ENTRIES) collect(entry, files)
  files.sort()
  if (files.length === 0 || files.length > MAX_SOURCE_FILES) throw new Error('quality-source-file-bound')
  const digest = createHash('sha256')
  let bytes = 0
  for (const relative of files) {
    const absolute = path.join(ROOT, ...relative.split('/'))
    const content = fs.readFileSync(absolute)
    bytes += content.length
    if (bytes > MAX_SOURCE_BYTES) throw new Error('quality-source-byte-bound')
    digest.update(relative)
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return { sha256: `sha256:${digest.digest('hex')}`, files: files.length, bytes }
}

export function localPackage(name) {
  const manifest = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json')
  const metadata = safeFile(`node_modules/${name}/package.json`, manifest)
  if (metadata.size > 1024 * 1024) throw new Error(`quality-package-manifest:${name}`)
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new Error(`quality-package-version:${name}`)
  }
  return { root: path.dirname(manifest), version: value.version }
}

export function runNode(entry, args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: MAX_CAPTURE_BYTES,
    windowsHide: true
  })
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? '',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

export function requireSuccess(label, result) {
  if (result.ok) return true
  const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n').slice(-4096)
  process.stderr.write(`${label} failed${result.status === null ? '' : ` (exit ${result.status})`}: ${detail}\n`)
  process.exitCode = 1
  return false
}

export function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `catalyst-quality-${label}-`))
}

export function receiptLine(receipt) {
  return `source receipt: ${receipt.sha256}; ${receipt.files} files; ${receipt.bytes} bytes`
}

export function assertCheckFlag() {
  const unknown = process.argv.slice(2).filter(argument => argument !== '--check')
  if (unknown.length > 0) throw new Error(`quality-argument:${unknown[0]}`)
}

export function isCheckMode() {
  return process.argv.includes('--check')
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function publishReport(name, value) {
  const destination = path.join(QUALITY, name)
  const content = stableJson(value)
  if (isCheckMode()) {
    const current = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null
    if (current !== content) {
      process.stderr.write(`quality report drift: quality/${name}; run without --check to update it\n`)
      process.exitCode = 1
      return false
    }
    return true
  }
  fs.mkdirSync(QUALITY, { recursive: true })
  const temporary = path.join(QUALITY, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return true
}

export function repositoryPath(value) {
  const absolute = path.isAbsolute(value) ? value : path.resolve(DESKTOP, value)
  const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
  if (relative === '' || relative === '..' || relative.startsWith('../')) {
    throw new Error(`quality-path-outside-root:${value}`)
  }
  return relative
}

export function normalizeDiagnostic(value) {
  return value
    .replaceAll(`${ROOT}${path.sep}`, '')
    .replaceAll(ROOT, '.')
    .replaceAll('\\', '/')
    .replace(/\r\n?/g, '\n')
    .trim()
}
