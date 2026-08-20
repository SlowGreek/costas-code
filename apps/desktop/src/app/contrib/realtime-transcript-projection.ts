import type { ChatMessage } from '@/lib/chat-messages'

export interface RealtimeTranscriptEvent {
  item_id?: unknown
  message_id?: unknown
  role?: unknown
  semantic_turn_id?: unknown
  text?: unknown
}

/** Project one durably persisted Realtime transcript row into live Desktop history. */
export function appendRealtimeTranscript(
  messages: ChatMessage[],
  payload: RealtimeTranscriptEvent,
  timestamp = Date.now() / 1_000
): ChatMessage[] {
  const itemId = typeof payload.item_id === 'string' ? payload.item_id.trim() : ''
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const role = payload.role === 'user' || payload.role === 'assistant' ? payload.role : null
  const rowId = typeof payload.message_id === 'number' && Number.isInteger(payload.message_id) ? payload.message_id : null

  const semanticTurnId =
    typeof payload.semantic_turn_id === 'string' ? payload.semantic_turn_id.trim() : ''

  if (!itemId || !text || !role || rowId === null) {
    return messages
  }

  const id = `realtime:${itemId}`

  if (
    messages.some(
      message =>
        message.id === id ||
        message.rowId === rowId ||
        message.realtimeItemIds?.includes(itemId) ||
        message.realtimeRowIds?.includes(rowId)
    )
  ) {
    return messages
  }

  if (role === 'assistant' && semanticTurnId) {
    const targetIndex = messages.findLastIndex(
      message => message.role === 'assistant' && message.semanticTurnId === semanticTurnId
    )

    if (targetIndex >= 0) {
      const target = messages[targetIndex]

      const priorText = target.parts
        .filter((part): part is Extract<(typeof target.parts)[number], { type: 'text' }> => part.type === 'text')
        .map(part => part.text)
        .join('')

      const next = [...messages]

      next[targetIndex] = {
        ...target,
        parts: [
          ...target.parts,
          { text: `${priorText.endsWith(' ') ? '' : ' '}${text}`, timestamp, type: 'text' }
        ],
        realtimeItemIds: [...(target.realtimeItemIds ?? []), itemId],
        realtimeRowIds: [...(target.realtimeRowIds ?? []), rowId]
      }

      return next
    }
  }

  return [
    ...messages,
    {
      id,
      parts: [{ text, timestamp, type: 'text' }],
      ...(semanticTurnId
        ? {
            realtimeItemIds: [itemId],
            realtimeRowIds: [rowId],
            semanticTurnId
          }
        : {}),
      role,
      rowId,
      timestamp
    }
  ]
}
