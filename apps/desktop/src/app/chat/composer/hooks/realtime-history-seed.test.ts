import { describe, expect, it } from 'vitest'

import { recentRealtimeSeedTurns } from './realtime-history-seed'

describe('recentRealtimeSeedTurns', () => {
  it('groups semantic continuations and preserves strict role alternation', () => {
    const turns = recentRealtimeSeedTurns([
      { content: 'Question.', id: 1, role: 'user', timestamp: 1 },
      {
        content: 'First answer.',
        display_kind: 'realtime_transcript',
        display_metadata: { semantic_turn_id: 'voice-turn-1' },
        id: 2,
        role: 'assistant',
        timestamp: 2
      },
      {
        content: 'Continued answer.',
        display_kind: 'realtime_transcript',
        display_metadata: { semantic_turn_id: 'voice-turn-1' },
        id: 3,
        role: 'assistant',
        timestamp: 3
      },
      { content: 'Follow-up fragment.', id: 4, role: 'user', timestamp: 4 },
      { content: 'More follow-up.', id: 5, role: 'user', timestamp: 5 }
    ])

    expect(turns).toEqual([
      { id: 'seed-0', role: 'user', text: 'Question.' },
      { id: 'seed-1', role: 'assistant', text: 'First answer. Continued answer.' },
      { id: 'seed-2', role: 'user', text: 'Follow-up fragment. More follow-up.' }
    ])
  })
})
