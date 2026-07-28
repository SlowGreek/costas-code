import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { discoverAeRepositoryRoot } from './ae-repository-root'

const roots: string[] = []

function temporary(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `catalyst-ae-root-${label}-`))
  roots.push(root)

  return root
}

function writeJson(root: string, relative: string, value: object) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`)
}

function canonicalAe(root: string) {
  writeJson(root, 'SPEC.json', { schema: 'ae-root-bootstrap-policy/1' })
  writeJson(root, 'run/SHELL-BUILDS.json', { schema: 'ae-shell-build-matrix/1' })
  writeJson(root, 'ugui/json/surface-profiles.json', { schema: 'ugui-surface-profiles/v1' })

  return fs.realpathSync(root)
}

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { force: true, recursive: true })}
})

describe('AgentExperiments repository discovery', () => {
  it('walks ancestors for a nested Catalyst submodule checkout', () => {
    const ae = temporary('nested')
    canonicalAe(ae)
    const catalyst = path.join(ae, 'third-party', 'catalyst', 'apps', 'desktop')
    fs.mkdirSync(catalyst, { recursive: true })

    expect(discoverAeRepositoryRoot({ start: catalyst, environment: {} })).toBe(fs.realpathSync(ae))
  })

  it('supports a standalone Catalyst checkout only with an explicit canonical root', () => {
    const standalone = temporary('standalone')
    const ae = temporary('explicit')
    canonicalAe(ae)
    const start = path.join(standalone, 'apps', 'desktop')
    fs.mkdirSync(start, { recursive: true })

    expect(() => discoverAeRepositoryRoot({ start, environment: {} })).toThrow('ae-repository-root-unavailable')
    expect(
      discoverAeRepositoryRoot({ start, environment: { AE_REPOSITORY_ROOT: fs.realpathSync(ae) } })
    ).toBe(fs.realpathSync(ae))
  })

  it('refuses explicit traversal and root or marker symlinks', () => {
    const ae = temporary('refusal')
    canonicalAe(ae)
    const start = temporary('start')

    expect(() =>
      discoverAeRepositoryRoot({ start, environment: { AE_REPOSITORY_ROOT: `${ae}${path.sep}nested${path.sep}..` } })
    ).toThrow('ae-repository-root-traversal')

    const linkedRoot = path.join(temporary('linked-parent'), 'ae')
    fs.symlinkSync(ae, linkedRoot, 'dir')
    expect(() =>
      discoverAeRepositoryRoot({ start, environment: { AE_REPOSITORY_ROOT: linkedRoot } })
    ).toThrow('ae-repository-root-symlink')

    fs.rmSync(path.join(ae, 'run', 'SHELL-BUILDS.json'))
    const external = path.join(temporary('marker'), 'SHELL-BUILDS.json')
    fs.writeFileSync(external, `${JSON.stringify({ schema: 'ae-shell-build-matrix/1' })}\n`)
    fs.symlinkSync(external, path.join(ae, 'run', 'SHELL-BUILDS.json'))
    expect(() =>
      discoverAeRepositoryRoot({ start, environment: { AE_REPOSITORY_ROOT: fs.realpathSync(ae) } })
    ).toThrow('ae-repository-root-marker')
  })
})
