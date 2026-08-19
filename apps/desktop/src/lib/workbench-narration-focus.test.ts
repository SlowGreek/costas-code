import { describe, expect, it } from 'vitest'

import { matchNarrationNode } from './workbench-narration-focus'

const nodes = [
  { id: 'api-gateway', label: 'API Gateway' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'database', label: 'DB' },
  { id: 'worker-2', label: 'Background Worker' }
]

describe('matchNarrationNode', () => {
  it('exact-matches visible labels and ids inside streamed narration', () => {
    expect(matchNarrationNode('Now the API Gateway hands off.', nodes)).toBe('api-gateway')
    expect(matchNarrationNode('Next is worker-2.', nodes)).toBe('worker-2')
  })

  it('normalizes case and punctuation without fuzzy matching', () => {
    expect(matchNarrationNode('The api, gateway is next.', nodes)).toBe('api-gateway')
    expect(matchNarrationNode('The background workers are next.', nodes)).toBeNull()
  })

  it('chooses the longest exact label when matches overlap', () => {
    expect(matchNarrationNode('Start at API Gateway.', nodes)).toBe('api-gateway')
  })

  it('skips labels shorter than three normalized characters', () => {
    expect(matchNarrationNode('The DB is durable.', nodes)).toBeNull()
  })

  it('matches a label once streamed chunks accumulate into the full name', () => {
    expect(matchNarrationNode('Move to Background', nodes)).toBeNull()
    expect(matchNarrationNode('Move to Background Worker', nodes)).toBe('worker-2')
  })
})
