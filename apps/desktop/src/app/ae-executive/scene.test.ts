import { describe, expect, it } from 'vitest'

import { parseExecutiveBatch, reconcileExecutiveBatch, sceneForTab } from './scene'

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
