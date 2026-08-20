import type { RealtimeTranscript } from '@/lib/realtime-voice'

export function realtimeTranscriptRpcParams(
  runtimeSessionId: string,
  entry: RealtimeTranscript
): Record<string, unknown> {
  return {
    session_id: runtimeSessionId,
    connection_id: entry.connectionId,
    item_id: entry.id,
    role: entry.role,
    ...(entry.semanticTurnId ? { semantic_turn_id: entry.semanticTurnId } : {}),
    text: entry.text
  }
}
