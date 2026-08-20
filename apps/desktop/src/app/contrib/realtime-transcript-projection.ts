import type { ChatMessage } from '@/lib/chat-messages'

export interface RealtimeTranscriptEvent {
  item_id?: unknown
  message_id?: unknown
  role?: unknown
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

  if (!itemId || !text || !role || rowId === null) {
    return messages
  }

  const id = `realtime:${itemId}`

  if (messages.some(message => message.id === id || message.rowId === rowId)) {
    return messages
  }

  return [
    ...messages,
    {
      id,
      parts: [{ text, timestamp, type: 'text' }],
      role,
      rowId,
      timestamp
    }
  ]
}
