import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { appendRealtimeTranscript } from './realtime-transcript-projection'

const existing: ChatMessage = {
  id: 'earlier',
  parts: [{ text: 'Earlier turn', type: 'text' }],
  role: 'user'
}

describe('appendRealtimeTranscript', () => {
  it('projects a persisted Realtime row into visible history', () => {
    const result = appendRealtimeTranscript(
      [existing],
      {
        item_id: 'item-user-1',
        message_id: 42,
        role: 'user',
        text: 'Spoken turn.'
      },
      123.5
    )

    expect(result).toEqual([
      existing,
      {
        id: 'realtime:item-user-1',
        parts: [{ text: 'Spoken turn.', timestamp: 123.5, type: 'text' }],
        role: 'user',
        rowId: 42,
        timestamp: 123.5
      }
    ])
  })

  it('dedupes a repeated event by provider item or durable row id', () => {
    const once = appendRealtimeTranscript(
      [],
      { item_id: 'item-a', message_id: 42, role: 'assistant', text: 'Answer.' },
      1
    )

    expect(appendRealtimeTranscript(once, { item_id: 'item-a', message_id: 42, role: 'assistant', text: 'Answer.' }, 2)).toBe(
      once
    )
    expect(appendRealtimeTranscript(once, { item_id: 'item-b', message_id: 42, role: 'assistant', text: 'Answer.' }, 2)).toBe(
      once
    )
  })

  it('ignores malformed or unsupported transcript events', () => {
    const messages = [existing]

    expect(appendRealtimeTranscript(messages, { item_id: '', message_id: 0, role: 'tool', text: '' }, 1)).toBe(messages)
  })
})
