import fs from 'node:fs'
import path from 'node:path'

const ENVIRONMENT_VARIABLE = 'AE_REPOSITORY_ROOT'
const MAX_ANCESTORS = 64

const MARKERS: Array<[string, (value: any) => boolean]> = [
  ['SPEC.json', value => value?.schema === 'ae-root-bootstrap-policy/1'],
  ['run/SHELL-BUILDS.json', value => value?.schema === 'ae-shell-build-matrix/1'],
  ['ugui/json/surface-profiles.json', value => value?.schema === 'ugui-surface-profiles/v1']
]

function directDirectory(candidate, label) {
  let metadata

  try {
    metadata = fs.lstatSync(candidate)
  } catch {
    throw new Error(`ae-repository-root-${label}`)
  }

  if (metadata.isSymbolicLink()) {throw new Error('ae-repository-root-symlink')}

  if (!metadata.isDirectory()) {throw new Error(`ae-repository-root-${label}`)}
}

function directDescendantDirectory(root, relative) {
  let current = root

  for (const component of relative.split('/')) {
    current = path.join(current, component)
    directDirectory(current, 'marker-parent')
  }
}

function readMarker(root, relative) {
  const target = path.join(root, ...relative.split('/'))
  const parentRelative = path.posix.dirname(relative)

  if (parentRelative !== '.') {directDescendantDirectory(root, parentRelative)}
  const metadata = fs.lstatSync(target)

  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 2 * 1024 * 1024) {
    throw new Error('ae-repository-root-marker')
  }

  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

function validateRoot(candidate) {
  const absolute = path.resolve(candidate)
  directDirectory(absolute, 'directory')
  const real = fs.realpathSync(absolute)

  if (real !== absolute) {throw new Error('ae-repository-root-symlink')}

  for (const [relative, validates] of MARKERS) {
    if (!validates(readMarker(real, relative))) {throw new Error('ae-repository-root-marker')}
  }

  return real
}

function explicitRoot(raw) {
  if (raw.length === 0 || raw.length > 4096 || raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
    throw new Error('ae-repository-root-env')
  }

  if (!path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    throw new Error('ae-repository-root-traversal')
  }

  return validateRoot(raw)
}

export function discoverAeRepositoryRoot({ start = process.cwd(), environment = process.env } = {}) {
  if (Object.hasOwn(environment, ENVIRONMENT_VARIABLE)) {
    const raw = environment[ENVIRONMENT_VARIABLE]

    if (typeof raw !== 'string') {throw new Error('ae-repository-root-env')}

    return explicitRoot(raw)
  }

  const requestedStart = path.resolve(start)
  directDirectory(requestedStart, 'start')
  let current = fs.realpathSync(requestedStart)

  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    try {
      return validateRoot(current)
    } catch (error) {
      if (error instanceof Error && error.message === 'ae-repository-root-symlink') {throw error}
    }

    const parent = path.dirname(current)

    if (parent === current) {break}
    directDirectory(parent, 'ancestor')
    current = fs.realpathSync(parent)
  }

  throw new Error('ae-repository-root-unavailable')
}
