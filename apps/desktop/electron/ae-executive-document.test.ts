import { describe, expect, it } from 'vitest'

import {
  AE_EXECUTIVE_DOCUMENT_TABS,
  validateAeExecutiveDocumentEnvelope
} from './ae-executive-document'

const hash = (character: string) => `sha256:${character.repeat(64)}`

const document = (tab: string) => ({
  id: `${tab}.document`,
  type: 'document',
  header: [{ type: 'text', body: tab, style: 'heading' }],
  sections: [{ type: 'status', signal: 'GREEN', body: `${tab} ready` }],
  actions: [{ id: `tab-${tab}`, type: 'button', label: tab, action: `shell.tab.${tab}` }]
})

const envelope = () => ({
  schema: 'ae-executive-document-envelope/1',
  authority: 'RUN_EXECUTIVE_COMPOSER',
  executive_generation: 7,
  document_hash: hash('a'),
  source_set_hash: hash('b'),
  observed_ms: 42,
  freshness: 'fresh',
  artifact_posture: 'observed',
  admission_code: 'admitted',
  blocker: null,
  rows: AE_EXECUTIVE_DOCUMENT_TABS.map((tab, index) => ({
    schema: 'ae-executive-document-row/1',
    tab,
    source_hash: hash(String((index % 9) + 1)),
    source_generation: index + 1,
    observed_ms: 42,
    freshness: 'fresh',
    posture: 'observed',
    artifact_posture: 'observed',
    document: document(tab),
    code: null
  }))
})

describe('AE executive Document envelope admission', () => {
  it('admits the producer-owned ordered Document rows', () => {
    const value = envelope()

    expect(validateAeExecutiveDocumentEnvelope(value)).toEqual(value)
  })

  it('admits a fail-closed unavailable envelope without documents', () => {
    const value = envelope()
    value.authority = 'none'
    value.executive_generation = 0
    value.document_hash = null as unknown as string
    value.source_set_hash = null as unknown as string
    value.observed_ms = null as unknown as number
    value.freshness = 'unavailable'
    value.artifact_posture = 'unavailable'
    value.admission_code = 'executive-episode-missing'
    value.blocker = { code: 'AE_EXECUTIVE_STORE_WRITER_UNAVAILABLE', boundary: 'B1-plan-proof', closed: true } as never
    value.rows = value.rows.map(row => ({
      ...row,
      source_hash: null as unknown as string,
      source_generation: 0,
      observed_ms: null as unknown as number,
      freshness: 'unavailable',
      posture: 'unavailable',
      artifact_posture: 'unavailable',
      document: null as unknown as ReturnType<typeof document>,
      code: 'executive-episode-missing'
    }))

    expect(validateAeExecutiveDocumentEnvelope(value).rows.every(row => row.document === null)).toBe(true)
  })

  it('rejects retired Scene envelopes and Scene fields inside Documents', () => {
    expect(() => validateAeExecutiveDocumentEnvelope({
      ...envelope(), schema: 'ae-executive-scene-envelope/1'
    })).toThrow('ae-executive-document-envelope')

    const value = envelope()
    value.rows[0].document = {
      ...document('home'), sceneVersion: '1.0.0', root: 'root', nodes: []
    } as never

    expect(() => validateAeExecutiveDocumentEnvelope(value)).toThrow('ugui-document-legacy')
  })
})
