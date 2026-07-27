import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  computeAeGenerationId,
  publishAeGeneration,
  publishAeGenerationStore,
  reconcileAeOrphans,
  validateAeGenerationManifest
} from './ae-generation.mjs'

const roots = []
const temp = label => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ae-generation-${label}-`))
  roots.push(root)
  return root
}
const file = (root, relative, value) => {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, value)
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })))

describe('AE generation orphan reconciliation', () => {
  test('removes only exact dead-owner candidate directories', () => {
    const root = temp('orphans')
    fs.mkdirSync(path.join(root, '.ae-candidate-101-1001'))
    fs.mkdirSync(path.join(root, '.ae-cargo-202-2002'))
    fs.mkdirSync(path.join(root, '.ae-candidate-303-3003'))
    fs.mkdirSync(path.join(root, '.ae-candidate-not-a-pid-4'))

    assert.deepEqual(reconcileAeOrphans({ buildRoot: root, isAlive: pid => pid === 303 }), [
      '.ae-candidate-101-1001',
      '.ae-cargo-202-2002'
    ])
    assert.equal(fs.existsSync(path.join(root, '.ae-candidate-303-3003')), true)
    assert.equal(fs.existsSync(path.join(root, '.ae-candidate-not-a-pid-4')), true)
  })

  test('refuses an exact orphan name that is not a direct directory', () => {
    const root = temp('orphan-type')
    file(root, '.ae-candidate-101-1001', 'forged')
    assert.throws(
      () => reconcileAeOrphans({ buildRoot: root, isAlive: () => false }),
      /generation-orphan-type/
    )
  })
})

describe('transactional AE generation publication', () => {
  test('validation failure preserves the last-good generation', () => {
    const root = temp('validate')
    const destinationDir = path.join(root, 'ae')
    const candidateDir = path.join(root, 'candidate')
    file(destinationDir, 'marker', 'last-good')
    file(candidateDir, 'marker', 'candidate')

    assert.throws(
      () => publishAeGeneration({ candidateDir, destinationDir, validateCandidate: () => {throw new Error('smoke-red')} }),
      /smoke-red/
    )
    assert.equal(fs.readFileSync(path.join(destinationDir, 'marker'), 'utf8'), 'last-good')
    assert.equal(fs.existsSync(candidateDir), true)
  })

  test('successful publication swaps the complete candidate generation', () => {
    const root = temp('success')
    const destinationDir = path.join(root, 'ae')
    const candidateDir = path.join(root, 'candidate')
    file(destinationDir, 'old', 'old')
    file(candidateDir, 'one', '1')
    file(candidateDir, 'nested/two', '2')

    publishAeGeneration({ candidateDir, destinationDir, validateCandidate: () => undefined })

    assert.equal(fs.existsSync(path.join(destinationDir, 'old')), false)
    assert.equal(fs.readFileSync(path.join(destinationDir, 'one'), 'utf8'), '1')
    assert.equal(fs.readFileSync(path.join(destinationDir, 'nested/two'), 'utf8'), '2')
    assert.equal(fs.existsSync(candidateDir), false)
  })

  test('failed candidate rename rolls back the prior generation', () => {
    const root = temp('rollback')
    const destinationDir = path.join(root, 'ae')
    const candidateDir = path.join(root, 'candidate')
    file(destinationDir, 'marker', 'last-good')
    file(candidateDir, 'marker', 'candidate')
    let calls = 0

    assert.throws(
      () =>
        publishAeGeneration({
          candidateDir,
          destinationDir,
          validateCandidate: () => undefined,
          rename: (from, to) => {
            calls += 1
            if (calls === 2) throw new Error('rename-red')
            fs.renameSync(from, to)
          }
        }),
      /rename-red/
    )
    assert.equal(fs.readFileSync(path.join(destinationDir, 'marker'), 'utf8'), 'last-good')
    assert.equal(fs.existsSync(candidateDir), true)
  })
})

describe('AE generation manifest admission', () => {
  const valid = () => {
    const value = {
      schema: 'costas-ae-generation/1',
      generation_id: '',
      ae: {
        root_realpath: '/repo/AgentExperiments',
        commit: 'b'.repeat(40),
        dirty: true,
        status_sha256: `sha256:${'c'.repeat(64)}`
      },
      costas: {
        root_realpath: '/repo/costas-code',
        commit: '4'.repeat(40),
        dirty: true,
        status_sha256: `sha256:${'5'.repeat(64)}`
      },
      artifacts: [
        { name: 'ae-executive-scene', sha256: `sha256:${'d'.repeat(64)}`, bytes: 1 },
        { name: 'ae-skin-settings-scene', sha256: `sha256:${'e'.repeat(64)}`, bytes: 1 },
        { name: 'butler', sha256: `sha256:${'f'.repeat(64)}`, bytes: 1 }
      ],
      resources: [
        { name: 'shell-viewport', sha256: `sha256:${'2'.repeat(64)}`, files: 3, bytes: 3 },
        { name: 'skins', sha256: `sha256:${'3'.repeat(64)}`, files: 25, bytes: 25 }
      ],
      smoke: {
        executive_scenes: 10,
        executive_contract_sha256: `sha256:${'1'.repeat(64)}`,
        skin_settings_nodes: 78
      }
    }
    value.generation_id = computeAeGenerationId(value)
    return value
  }

  test('publishes an immutable generation and atomically selects it through CURRENT.json', () => {
    const root = temp('store')
    const storeDir = path.join(root, 'ae')
    const candidateDir = path.join(root, 'candidate')
    const manifest = valid()
    file(candidateDir, 'generation.json', `${JSON.stringify(manifest)}\n`)

    const result = publishAeGenerationStore({
      candidateDir,
      storeDir,
      manifest,
      validateCandidate: directory => validateAeGenerationManifest(
        JSON.parse(fs.readFileSync(path.join(directory, 'generation.json'), 'utf8'))
      )
    })

    assert.equal(fs.existsSync(result.generationDir), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storeDir, 'CURRENT.json'), 'utf8')), result.pointer)
  })

  test('pointer publication failure preserves the previous CURRENT selection', () => {
    const root = temp('pointer-red')
    const storeDir = path.join(root, 'ae')
    const candidateDir = path.join(root, 'candidate')
    const manifest = valid()
    const previous = { schema: 'costas-ae-current/1', generation_id: `sha256:${'9'.repeat(64)}`, manifest_sha256: `sha256:${'8'.repeat(64)}` }
    file(storeDir, 'CURRENT.json', `${JSON.stringify(previous)}\n`)
    file(candidateDir, 'generation.json', `${JSON.stringify(manifest)}\n`)
    let calls = 0

    assert.throws(() => publishAeGenerationStore({
      candidateDir,
      storeDir,
      manifest,
      validateCandidate: () => undefined,
      rename: (from, to) => {
        calls += 1
        if (calls === 2) throw new Error('pointer-red')
        fs.renameSync(from, to)
      }
    }), /pointer-red/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storeDir, 'CURRENT.json'), 'utf8')), previous)
  })

  test('admits one exact source-bound complete generation', () => {
    assert.deepEqual(validateAeGenerationManifest(valid()), valid())
  })

  test('rejects missing artifacts, unknown fields, and malformed hashes', () => {
    const missing = valid()
    missing.artifacts.pop()
    assert.throws(() => validateAeGenerationManifest(missing), /generation-artifacts/)
    assert.throws(() => validateAeGenerationManifest({ ...valid(), capability: 'forged' }), /generation-fields/)
    const hash = valid()
    hash.generation_id = 'latest'
    assert.throws(() => validateAeGenerationManifest(hash), /generation-hash/)
  })
})
