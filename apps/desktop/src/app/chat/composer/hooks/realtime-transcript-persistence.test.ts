import { describe, expect, it } from 'vitest'

import { realtimeTranscriptRpcParams } from './realtime-transcript-persistence'

describe('realtimeTranscriptRpcParams', () => {
  it('carries connection, provider item, and semantic turn identity', () => {
    expect(
      realtimeTranscriptRpcParams('runtime-1', {
        connectionId: 'connection-1',
        id: 'assistant-item-2',
        role: 'assistant',
        semanticTurnId: 'voice-turn-7',
        text: 'Continuation segment.'
      })
    ).toEqual({
      connection_id: 'connection-1',
      item_id: 'assistant-item-2',
      role: 'assistant',
      semantic_turn_id: 'voice-turn-7',
      session_id: 'runtime-1',
      text: 'Continuation segment.'
    })
  })
})
