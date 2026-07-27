import { describe, expect, it } from 'vitest'

import {
  parseExecutiveBatch,
  reconcileExecutiveBatch,
  sceneForTab,
  studioDesignerContext
} from './scene'

const artifact = `sha256:${'a'.repeat(64)}`
const hash = (digit: string) => `sha256:${digit.repeat(64)}`
const tabs = ['home', 'marketplace'] as const
const labels = { home: '[H]OME', marketplace: 'MA[R]KETPLACE' }

function scene(tab: string, text = tab.toUpperCase()) {
  return {
    sceneVersion: '1.0.0' as const,
    id: `run-${tab}`,
    root: `${tab}-root`,
    nodes: [
      { id: `${tab}-root`, p: 'column' as const, kids: [`${tab}-text`, ...tabs.map(id => `${tab}-tab-${id}`)] },
      { id: `${tab}-text`, p: 'text' as const, a: { text } },
      ...tabs.map(id => ({
        id: `${tab}-tab-${id}`,
        p: 'button' as const,
        a: { label: labels[id] },
        on: { tap: `shell.tab.${id}` }
      }))
    ]
  }
}

function sceneEnvelope(generation: number, options: { blocker?: boolean } = {}) {
  const digit = (generation % 10).toString()

  return {
    schema: 'ae-executive-scene-envelope/1',
    authority: options.blocker ? 'none' : 'RUN_EXECUTIVE_COMPOSER',
    executive_generation: generation,
    document_hash: hash(digit),
    source_set_hash: hash(((generation + 5) % 10).toString()),
    observed_ms: 2_000 + generation,
    freshness: options.blocker ? 'degraded' : 'fresh',
    artifact_posture: 'observed',
    admission_code: 'admitted',
    blocker: options.blocker
      ? { code: 'AE_EXECUTIVE_STORE_WRITER_UNAVAILABLE', boundary: 'B1-plan-proof', closed: true as const }
      : null,
    artifact_generation: artifact,
    scenes: tabs.map(tab => ({ tab, state: 'fresh', scene: scene(tab) }))
  }
}

function unavailableSceneEnvelope() {
  return {
    schema: 'ae-executive-scene-envelope/1',
    authority: 'none',
    executive_generation: 0,
    document_hash: null,
    source_set_hash: null,
    observed_ms: null,
    freshness: 'unavailable',
    artifact_posture: 'unavailable',
    admission_code: 'executive-episode-missing',
    blocker: { code: 'AE_EXECUTIVE_STORE_WRITER_UNAVAILABLE', boundary: 'B1-plan-proof', closed: true as const },
    artifact_generation: artifact,
    scenes: tabs.map(tab => ({ tab, state: 'unavailable', reason: 'executive-episode-missing' }))
  }
}

function envelope(generation: number, textByTab: Readonly<Record<string, string>> = {}) {
  const digit = (generation % 10).toString()

  return {
    schema: 'ae-executive-scene-batch/2',
    authority: 'none',
    projector: 'run::executive->ugui::project',
    generation,
    document_hash: hash(digit),
    source_set_hash: hash(((generation + 5) % 10).toString()),
    observed_ms: 1_000 + generation,
    freshness: 'fresh',
    artifact_generation: artifact,
    scenes: tabs.map(tab => ({ tab, state: 'fresh', scene: scene(tab, textByTab[tab]) }))
  }
}

describe('generation executive envelope', () => {
  it('parses exact generation, document/source hashes, observation, freshness, and artifact generation', () => {
    const parsed = parseExecutiveBatch(envelope(4))

    expect(parsed).toMatchObject({
      generation: 4,
      document_hash: hash('4'),
      source_set_hash: hash('9'),
      observed_ms: 1_004,
      freshness: 'fresh',
      artifact_generation: artifact,
      posture: 'live'
    })
  })

  it('parses the Rust scene envelope and preserves nullable admission provenance', () => {
    const parsed = parseExecutiveBatch(sceneEnvelope(6, { blocker: true }))

    expect(parsed).toMatchObject({
      schema: 'ae-executive-scene-envelope/1',
      generation: 6,
      document_hash: hash('6'),
      source_set_hash: hash('1'),
      observed_ms: 2_006,
      freshness: 'degraded',
      artifact_generation: artifact,
      artifact_posture: 'observed',
      admission_code: 'admitted',
      blocker: { code: 'AE_EXECUTIVE_STORE_WRITER_UNAVAILABLE', closed: true },
      posture: 'degraded'
    })
    expect(sceneForTab(parsed, 'home').id).toBe('run-home')
  })

  it('admits a generation-zero unavailable envelope without requiring scenes and later recovers', () => {
    const unavailable = parseExecutiveBatch(unavailableSceneEnvelope())

    expect(unavailable).toMatchObject({
      schema: 'ae-executive-scene-envelope/1',
      generation: null,
      document_hash: null,
      source_set_hash: null,
      observed_ms: null,
      posture: 'unavailable',
      admission_code: 'executive-episode-missing'
    })
    expect(unavailable.scenes).toEqual([
      { tab: 'home', state: 'unavailable', reason: 'executive-episode-missing' },
      { tab: 'marketplace', state: 'unavailable', reason: 'executive-episode-missing' }
    ])
    expect(() => sceneForTab(unavailable, 'home')).toThrow('executive-episode-missing')

    const recovered = reconcileExecutiveBatch(unavailable, parseExecutiveBatch(sceneEnvelope(1)))

    expect(recovered).toMatchObject({ accepted: true, reason: 'accepted' })
    expect(recovered.batch.generation).toBe(1)
  })

  it('refuses mixed generation-zero provenance and preserves a live generation over unavailable input', () => {
    const mixed = { ...unavailableSceneEnvelope(), document_hash: hash('1') }

    expect(() => parseExecutiveBatch(mixed)).toThrow('ae-executive-envelope-unavailable-provenance')

    const current = parseExecutiveBatch(sceneEnvelope(2))
    const unavailable = parseExecutiveBatch(unavailableSceneEnvelope())

    expect(reconcileExecutiveBatch(current, unavailable)).toMatchObject({
      accepted: false,
      reason: 'unavailable-episode-not-live',
      batch: current
    })
  })

  it('admits a structural Shell row without requiring shell.tab.shell in producer Scenes', () => {
    const base = sceneEnvelope(7)

    const value = {
      ...base,
      scenes: [...base.scenes, { tab: 'shell', state: 'structural', scene: scene('shell') }]
    }

    const parsed = parseExecutiveBatch(value)

    expect(parsed.scenes).toHaveLength(3)
    expect(sceneForTab(parsed, 'home').nodes.some(node => node.on?.tap === 'shell.tab.shell')).toBe(false)
    expect(sceneForTab(parsed, 'shell').id).toBe('run-shell')
  })

  it('admits only exact Studio editor revision and document hash metadata', () => {
    const studio = {
      ...scene('home'),
      receipt: {
        editor: {
          selectable_node_ids: ['home-text'],
          selected_node_id: 'home-text',
          revision: 7,
          document_hash: hash('7')
        }
      }
    }

    expect(studioDesignerContext(studio)).toEqual({ revision: 7, documentHash: hash('7') })
    expect(studioDesignerContext({ ...studio, receipt: { editor: { revision: -1, document_hash: hash('7') } } }))
      .toBeNull()
  })

  it('isolates one malformed tab instead of rejecting unrelated valid rows', () => {
    const value = envelope(2)

    const marketplace = value.scenes.find(row => row.tab === 'marketplace')!

    ;(marketplace.scene.nodes[0] as { kids: string[] }).kids = ['missing']
    const parsed = parseExecutiveBatch(value)

    expect(sceneForTab(parsed, 'home').id).toBe('run-home')
    expect(parsed.scenes.find(row => row.tab === 'marketplace')).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('child-missing')
    })
  })

  it('admits v1 only with explicit legacy/unverified posture and no live generation', () => {
    const legacy = {
      schema: 'ae-executive-scene-batch/1',
      authority: 'none',
      projector: 'legacy',
      artifact_generation: artifact,
      scenes: tabs.map(tab => ({ tab, scene: scene(tab) }))
    }

    const parsed = parseExecutiveBatch(legacy)

    expect(parsed.generation).toBeNull()
    expect(parsed.freshness).toBe('unverified')
    expect(parsed.posture).toBe('legacy-unverified')
    expect(reconcileExecutiveBatch(parsed, parseExecutiveBatch(legacy))).toMatchObject({
      accepted: false,
      reason: 'legacy-unverified-not-live'
    })
  })
})

describe('monotonic executive reconciliation', () => {
  it('accepts an authority upgrade for the same generation and rejects regression', () => {
    const proven = parseExecutiveBatch(sceneEnvelope(5))
    const held = parseExecutiveBatch({ ...sceneEnvelope(5), authority: 'none' })

    expect(reconcileExecutiveBatch(held, proven)).toMatchObject({
      accepted: true,
      reason: 'accepted',
      batch: proven
    })
    expect(reconcileExecutiveBatch(proven, held)).toMatchObject({
      accepted: false,
      reason: 'authority-regression',
      batch: proven
    })
  })

  it('accepts a newer generation and treats exact equality as idempotent', () => {
    const first = parseExecutiveBatch(envelope(1))
    const second = parseExecutiveBatch(envelope(2, { home: 'NEW HOME' }))
    const advanced = reconcileExecutiveBatch(first, second)

    expect(advanced).toMatchObject({ accepted: true, reason: 'accepted' })
    expect(sceneForTab(advanced.batch, 'home').nodes[1].a?.text).toBe('NEW HOME')
    expect(reconcileExecutiveBatch(advanced.batch, parseExecutiveBatch(envelope(2)))).toMatchObject({
      accepted: true,
      reason: 'duplicate',
      batch: advanced.batch
    })
  })

  it('rejects stale/out-of-order and conflicting same-generation responses', () => {
    const current = parseExecutiveBatch(envelope(3))
    const stale = parseExecutiveBatch(envelope(2))
    const conflictValue = envelope(3)

    conflictValue.document_hash = hash('f')
    const conflict = parseExecutiveBatch(conflictValue)

    expect(reconcileExecutiveBatch(current, stale)).toMatchObject({
      accepted: false,
      reason: 'out-of-order-generation',
      batch: current
    })
    expect(reconcileExecutiveBatch(current, conflict)).toMatchObject({
      accepted: false,
      reason: 'same-generation-conflict',
      batch: current
    })
  })

  it('rejects stale observation time even when the response generation is newer', () => {
    const current = parseExecutiveBatch(envelope(3))
    const staleValue = envelope(4)

    staleValue.observed_ms = 900
    const stale = parseExecutiveBatch(staleValue)

    expect(reconcileExecutiveBatch(current, stale)).toMatchObject({
      accepted: false,
      reason: 'stale-observation',
      batch: current
    })
  })

  it('preserves only the failed tab Scene while admitting valid rows from a newer generation', () => {
    const current = parseExecutiveBatch(envelope(1, { home: 'OLD HOME', marketplace: 'OLD MARKETPLACE' }))
    const nextValue = envelope(2, { home: 'NEW HOME', marketplace: 'BROKEN MARKETPLACE' })

    const marketplace = nextValue.scenes.find(row => row.tab === 'marketplace')!

    ;(marketplace.scene.nodes[0] as { kids: string[] }).kids = ['missing']
    const reconciled = reconcileExecutiveBatch(current, parseExecutiveBatch(nextValue))

    expect(reconciled.accepted).toBe(true)
    expect(sceneForTab(reconciled.batch, 'home').nodes[1].a?.text).toBe('NEW HOME')
    expect(sceneForTab(reconciled.batch, 'marketplace').nodes[1].a?.text).toBe('OLD MARKETPLACE')
    expect(reconciled.batch.scenes.find(row => row.tab === 'marketplace')).toMatchObject({
      state: 'unavailable',
      preserved: true
    })
  })
})
