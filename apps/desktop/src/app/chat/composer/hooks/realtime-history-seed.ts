import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import type { RealtimeTranscript } from '@/lib/realtime-voice'
import type { SessionMessage } from '@/types/hermes'

export function recentRealtimeSeedTurns(
  messages: SessionMessage[],
  maxTurns = 20
): RealtimeTranscript[] {
  const alternating: Array<Pick<RealtimeTranscript, 'role' | 'text'>> = []

  for (const message of toChatMessages(messages)) {
    if (message.role !== 'assistant' && message.role !== 'user') {
      continue
    }

    const text = chatMessageText(message).trim()

    if (!text) {
      continue
    }

    const prior = alternating.at(-1)

    if (prior?.role === message.role) {
      prior.text = `${prior.text.trimEnd()} ${text}`
    } else {
      alternating.push({ role: message.role, text })
    }
  }

  return alternating.slice(-Math.max(1, maxTurns)).map((turn, index) => ({
    id: `seed-${index}`,
    ...turn
  }))
}
