import { describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TAB_IDS } from './contract'
import {
  documentForTab,
  parseExecutiveDocumentEnvelope,
  reconcileExecutiveDocuments,
  studioDesignerContext
} from './document'

const hash = (character: string) => `sha256:${character.repeat(64)}`

const document = (tab: string) => ({
  id: `${tab}.document`,
  type: 'document',
  header: [{ type: 'text', body: tab, style: 'heading' }],
  sections: [{ type: 'status', signal: 'GREEN', body: `${tab} ready` }],
  actions: [{ id: `tab-${tab}`, type: 'button', label: tab, action: `shell.tab.${tab}` }]
})

const envelope = (generation = 7) => ({
  schema: 'ae-executive-document-envelope/1',
  authority: 'RUN_EXECUTIVE_COMPOSER',
  executive_generation: generation,
  document_hash: hash(String(generation % 10)),
  source_set_hash: hash('b'),
  observed_ms: generation * 10,
  freshness: 'fresh',
  artifact_posture: 'observed',
  admission_code: 'admitted',
  blocker: null,
  artifact_generation: hash('f'),
  rows: AE_EXECUTIVE_TAB_IDS.map((tab, index) => ({
    schema: 'ae-executive-document-row/1',
    tab,
    source_hash: hash(String((index % 9) + 1)),
    source_generation: index + 1,
    observed_ms: generation * 10,
    freshness: 'fresh',
    posture: 'observed',
    artifact_posture: 'observed',
    document: document(tab),
    code: null
  }))
})

describe('executive Document envelope', () => {
  it('admits the ordered producer rows and resolves a tab Document', () => {
    const parsed = parseExecutiveDocumentEnvelope(envelope())

    expect(parsed.rows.map(row => row.tab)).toEqual(AE_EXECUTIVE_TAB_IDS)
    expect(documentForTab(parsed, 'mermaid').id).toBe('mermaid.document')
    expect(parsed.posture).toBe('live')
  })

  it('rejects retired Scene schemas and Scene fields', () => {
    expect(() => parseExecutiveDocumentEnvelope({
      ...envelope(), schema: 'ae-executive-scene-envelope/1'
    })).toThrow('ae-executive-document-envelope')

    const value = envelope()
    value.rows[0].document = {
      ...document('home'), sceneVersion: '1.0.0', root: 'root', nodes: []
    } as never
    expect(() => parseExecutiveDocumentEnvelope(value)).toThrow('ugui-document-legacy')
  })

  it('derives Studio action context from row provenance', () => {
    const parsed = parseExecutiveDocumentEnvelope(envelope())
    const studio = parsed.rows.find(row => row.tab === 'studio')!

    expect(studioDesignerContext(studio)).toEqual({
      revision: studio.source_generation,
      documentHash: studio.source_hash
    })
  })

  it('preserves the last valid Document across a newer unavailable row', () => {
    const previous = parseExecutiveDocumentEnvelope(envelope(7))
    const nextValue = envelope(8)
    const home = nextValue.rows[0] as Omit<typeof nextValue.rows[number], 'code'> & { code: string | null }
    home.document = null as never
    home.freshness = 'unavailable'
    home.posture = 'unavailable'
    home.artifact_posture = 'unavailable'
    home.code = 'home-unavailable'
    const result = reconcileExecutiveDocuments(previous, parseExecutiveDocumentEnvelope(nextValue))

    expect(result.accepted).toBe(true)
    expect(result.batch.rows[0].document).toEqual(previous.rows[0].document)
    expect(result.batch.rows[0].preserved).toBe(true)
  })
})
