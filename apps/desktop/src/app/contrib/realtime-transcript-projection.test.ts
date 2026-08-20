import { describe, expect, it } from 'vitest'

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'

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

  it('groups assistant continuation segments from one semantic turn', () => {
    const first = appendRealtimeTranscript(
      [],
      {
        item_id: 'assistant-1',
        message_id: 51,
        role: 'assistant',
        semantic_turn_id: 'voice-turn-7',
        text: 'First segment.'
      },
      1
    )

    const grouped = appendRealtimeTranscript(
      first,
      {
        item_id: 'assistant-2',
        message_id: 52,
        role: 'assistant',
        semantic_turn_id: 'voice-turn-7',
        text: 'Second segment.'
      },
      2
    )

    expect(grouped).toHaveLength(1)
    expect(chatMessageText(grouped[0])).toBe('First segment. Second segment.')
    expect(grouped[0]).toMatchObject({
      id: 'realtime-turn:voice-turn-7',
      realtimeItemIds: ['assistant-1', 'assistant-2'],
      realtimeRowIds: [51, 52],
      semanticTurnId: 'voice-turn-7'
    })
    expect(
      appendRealtimeTranscript(
        grouped,
        {
          item_id: 'assistant-2',
          message_id: 52,
          role: 'assistant',
          semantic_turn_id: 'voice-turn-7',
          text: 'Second segment.'
        },
        3
      )
    ).toBe(grouped)
  })

  it('does not move a late assistant continuation above a newer user turn', () => {
    const first = appendRealtimeTranscript(
      [],
      {
        item_id: 'assistant-1',
        message_id: 51,
        role: 'assistant',
        semantic_turn_id: 'voice-turn-7',
        text: 'Old answer.'
      },
      1
    )

    const withUser = appendRealtimeTranscript(
      first,
      {
        item_id: 'user-2',
        message_id: 52,
        role: 'user',
        semantic_turn_id: 'voice-turn-8',
        text: 'New question.'
      },
      2
    )

    const late = appendRealtimeTranscript(
      withUser,
      {
        item_id: 'assistant-late',
        message_id: 53,
        role: 'assistant',
        semantic_turn_id: 'voice-turn-7',
        text: 'Late old tail.'
      },
      3
    )

    expect(late.map(chatMessageText)).toEqual(['Old answer.', 'New question.', 'Late old tail.'])
  })

  it('ignores malformed or unsupported transcript events', () => {
    const messages = [existing]

    expect(appendRealtimeTranscript(messages, { item_id: '', message_id: 0, role: 'tool', text: '' }, 1)).toBe(messages)
  })
})
