export type VoiceStartReadiness =
  | { kind: 'fail'; reason: string }
  | { kind: 'ready' }
  | { kind: 'wait-for-session' }

interface ReadinessInput {
  hasGateway: boolean
  sessionId: null | string | undefined
}

/**
 * Whether a voice session can start right now.
 *
 * Reported from a real attempt: hitting the mic on a brand-new chat produced
 * "Could not start voice session — Hermes gateway session is not ready for GPT
 * Realtime". Two separate faults were collapsed into one hard failure:
 *
 * - **No session yet.** A new chat has no runtime session until the first
 *   message creates one. That is the common case, it resolves on its own in a
 *   moment, and discarding the attempt makes the user press the button twice.
 * - **No gateway.** The backend genuinely is not connected. Waiting will not
 *   help, so this one is a real failure — but the message has to say something
 *   the user can act on rather than naming our internals.
 */
export function voiceStartReadiness(input: ReadinessInput): VoiceStartReadiness {
  if (!input.hasGateway) {
    return {
      kind: 'fail',
      reason: 'Hermes is not connected yet — reconnect and try again.'
    }
  }

  if (!input.sessionId) {
    return { kind: 'wait-for-session' }
  }

  return { kind: 'ready' }
}
