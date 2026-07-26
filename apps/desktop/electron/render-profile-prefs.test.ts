import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RenderProfilePreferenceStore } from './render-profile-prefs'

const roots: string[] = []

const store = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-profile-prefs-'))
  roots.push(root)

  return new RenderProfilePreferenceStore(path.join(root, 'profiles.json'))
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })))

describe('Electron render-profile preference authority', () => {
  it('commits with CAS, read-back receipt, and profile isolation', () => {
    const prefs = store()
    expect(prefs.get('default')).toMatchObject({ revision: 0, profile_id: 'glassmorphism' })

    const receipt = prefs.commit({
      profile: 'default',
      profile_id: 'windows-95',
      expected_revision: 0,
      idempotency_key: 'op-1'
    })

    expect(receipt).toMatchObject({ revision: 1, profile: 'default', profile_id: 'windows-95', idempotent: false })
    expect(receipt.receipt_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(prefs.get('default')).toMatchObject({ revision: 1, profile_id: 'windows-95' })
    expect(prefs.get('other')).toMatchObject({ revision: 1, profile_id: 'glassmorphism' })
  })

  it('replays an idempotency key and refuses stale revisions', () => {
    const prefs = store()

    const request = {
      profile: 'default',
      profile_id: 'windows-95',
      expected_revision: 0,
      idempotency_key: 'same-op'
    }

    const first = prefs.commit(request)
    expect(prefs.commit(request)).toEqual({ ...first, idempotent: true })
    expect(() =>
      prefs.commit({ ...request, profile_id: 'glassmorphism', idempotency_key: 'new-op' })
    ).toThrow('render-profile-revision-conflict')
  })

  it('fails closed on malformed durable state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-profile-prefs-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    fs.writeFileSync(file, '{"schema":"evil","profiles":{"default":"windows-95"}}')
    expect(() => new RenderProfilePreferenceStore(file).get('default')).toThrow('render-profile-store-invalid')
  })
})
