import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import {
  type RealtimeTranscript,
  type RealtimeVoiceConnection,
  startRealtimeVoiceConnection
} from '@/lib/realtime-voice'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { $workbenchArtifact, type WorkbenchArtifact } from '@/store/workbench'

import type { ConversationStatus } from './use-voice-conversation'

interface RealtimeVoiceConversationOptions {
  beforeConnect?: () => Promise<void> | void
  enabled: boolean
  onFatalError?: () => void
  onTranscript?: (entry: RealtimeTranscript) => void
  runtimeSessionId: null | string | undefined
}

/**
 * How many recent turns to replay into a new realtime session.
 *
 * Enough to continue a train of thought, bounded because every seeded turn is
 * tokens on the realtime connection and a long transcript is both costly and
 * slower to start. `visualize` still reads the FULL durable transcript, so the
 * diagrammer is unaffected by this bound.
 */
const HISTORY_SEED_TURNS = 20

/**
 * Describe the current canvas to the voice model, per kind.
 *
 * Reading `payload.nodes` unconditionally throws for a timeline, quadrant, or
 * sketch — and because this runs inside connection setup, that failure would
 * silently cost the model all knowledge of what is on screen.
 */
const summarizeWorkbench = (artifact: WorkbenchArtifact): string => {
  const payload = artifact.payload as {
    axes?: unknown
    edges?: { from: string; label?: string; to: string }[]
    html?: string
    items?: { id: string; label?: string }[]
    nodes?: { id: string; kind?: string; label?: string }[]
  }

  const head = { kind: artifact.kind, revision: artifact.semantic_rev }

  switch (artifact.kind) {
    case 'quadrant':
      return JSON.stringify({
        ...head,
        axes: payload.axes,
        items: payload.items ?? []
      })

    case 'sketch':
      // Never ship the raw HTML: it is large, and the model does not need the
      // markup to talk about what it drew.
      return JSON.stringify({ ...head, note: 'a rendered visual sketch is on screen' })

    case 'timeline':
      return JSON.stringify({ ...head, items: payload.items ?? [] })

    default:
      return JSON.stringify({
        ...head,
        nodes: (payload.nodes ?? []).map(node => ({
          id: node.id,
          label: node.label,
          kind: node.kind
        })),
        edges: (payload.edges ?? []).map(edge => ({
          from: edge.from,
          to: edge.to,
          label: edge.label
        }))
      })
  }
}

const persistTranscriptWithRetry = async (
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  runtimeSessionId: string,
  entry: RealtimeTranscript
): Promise<void> => {
  const delays = [0, 500, 1_500]
  let lastError: unknown

  for (const delay of delays) {
    if (delay) {
      await new Promise<void>(resolve => window.setTimeout(resolve, delay))
    }

    try {
      await request('voice.realtime.transcript', {
        session_id: runtimeSessionId,
        item_id: entry.id,
        role: entry.role,
        text: entry.text
      })

      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

export function useRealtimeVoiceConversation({
  beforeConnect,
  enabled,
  onFatalError,
  onTranscript,
  runtimeSessionId
}: RealtimeVoiceConversationOptions) {
  const { t } = useI18n()
  const [muted, setMuted] = useState(false)
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const connectionRef = useRef<RealtimeVoiceConnection | null>(null)
  const startGenerationRef = useRef(0)
  const transcriptWriteChainRef = useRef(Promise.resolve())
  const failedTranscriptsRef = useRef<RealtimeTranscript[]>([])
  // Populated once the connection exists. `beforeToolCall` closes over the ref
  // (not the connection) because the callback is passed into the very call that
  // creates it.
  const pendingTranscriptionRef = useRef<(() => Promise<void>) | null>(null)
  const wasEnabledRef = useRef(enabled)

  const end = useCallback(() => {
    startGenerationRef.current += 1
    connectionRef.current?.close()
    connectionRef.current = null
    pendingTranscriptionRef.current = null
    setMuted(false)
    setStatus('idle')
  }, [])

  const start = useCallback(async () => {
    const gateway = $gateway.get()

    if (!gateway || !runtimeSessionId) {
      const error = new Error('Hermes gateway session is not ready for GPT Realtime')
      notifyError(error, t.notifications.voice.couldNotStartSession)
      onFatalError?.()

      return
    }

    end()
    const generation = startGenerationRef.current
    setStatus('thinking')

    try {
      // Yield so the parent voice-toggle effect can publish its wake.pause
      // barrier before we ask for the same capture device.
      await Promise.resolve()
      await beforeConnect?.()

      if (generation !== startGenerationRef.current) {
        return
      }

      const connection = await startRealtimeVoiceConnection({
        beforeToolCall: async () => {
          // Wait for the *specific* in-flight transcription events rather than
          // sleeping a fixed interval: a normal turn adds no latency, and a
          // slow one is still gated instead of raced. The tracker's internal
          // timeout only bounds a transcription event that never arrives.
          await pendingTranscriptionRef.current?.()
          await transcriptWriteChainRef.current

          while (failedTranscriptsRef.current.length > 0) {
            const entry = failedTranscriptsRef.current[0]

            await persistTranscriptWithRetry(
              (method, params) => gateway.request(method, params),
              runtimeSessionId,
              entry
            )
            failedTranscriptsRef.current.shift()
          }
        },
        onStatus: setStatus,
        onTranscript: entry => {
          transcriptWriteChainRef.current = transcriptWriteChainRef.current
            .then(() =>
              persistTranscriptWithRetry(
                (method, params) => gateway.request(method, params),
                runtimeSessionId,
                entry
              )
            )
            .catch(error => {
              if (!failedTranscriptsRef.current.some(failed => failed.id === entry.id)) {
                failedTranscriptsRef.current.push(entry)
              }

              notifyError(error, t.notifications.voice.transcriptionFailed)
            })
          onTranscript?.(entry)
        },
        request: (method, params) => gateway.request(method, params),
        runtimeSessionId
      })

      if (generation !== startGenerationRef.current) {
        connection.close()

        return
      }

      connectionRef.current = connection
      pendingTranscriptionRef.current = () => connection.awaitPendingTranscription()

      // Continue the conversation rather than starting cold. The typed chat and
      // the voice session share one session, so whatever was already discussed
      // (typed or spoken) is the context the user expects voice to have.
      try {
        const history = await gateway.request<{ messages?: { content?: unknown; role?: string }[] }>(
          'session.history',
          { session_id: runtimeSessionId }
        )

        const turns = (history.messages ?? [])
          .filter(
            (message): message is { content: string; role: 'assistant' | 'user' } =>
              (message.role === 'assistant' || message.role === 'user') &&
              typeof message.content === 'string' &&
              message.content.trim().length > 0
          )
          .slice(-HISTORY_SEED_TURNS)
          .map((message, index) => ({
            id: `seed-${index}`,
            role: message.role,
            text: message.content
          }))

        if (turns.length > 0 && generation === startGenerationRef.current) {
          connection.seedHistory(turns)
        }
      } catch {
        // Losing prior context is a degraded conversation, not a broken one —
        // never fail the connection over it.
      }

      const artifact = $workbenchArtifact.get()

      if (artifact) {
        connection.updateWorkbenchContext(summarizeWorkbench(artifact))
      }

      setMuted(false)
      setStatus('listening')
    } catch (error) {
      if (generation === startGenerationRef.current) {
        notifyError(error, t.notifications.voice.couldNotStartSession)
        setStatus('idle')
        onFatalError?.()
      }
    }
  }, [
    beforeConnect,
    end,
    onFatalError,
    onTranscript,
    runtimeSessionId,
    t.notifications.voice.couldNotStartSession,
    t.notifications.voice.transcriptionFailed
  ])

  const toggleMute = useCallback(() => {
    setMuted(current => {
      const next = !current
      connectionRef.current?.setMuted(next)

      return next
    })
  }, [])

  const stopTurn = useCallback(() => {
    connectionRef.current?.stopTurn()
  }, [])

  useEffect(
    () =>
      $workbenchArtifact.subscribe(artifact => {
        if (artifact) {
          connectionRef.current?.updateWorkbenchContext(summarizeWorkbench(artifact))
        }
      }),
    []
  )

  // eslint-disable-next-line no-restricted-syntax -- lifecycle edge detection, not an atom mirror
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      void start()
    } else if (!enabled && wasEnabledRef.current) {
      end()
    }

    wasEnabledRef.current = enabled
  }, [enabled, end, start])

  useEffect(() => end, [end])

  return {
    end,
    level: 0,
    muted,
    start,
    status,
    stopTurn,
    toggleMute
  }
}
