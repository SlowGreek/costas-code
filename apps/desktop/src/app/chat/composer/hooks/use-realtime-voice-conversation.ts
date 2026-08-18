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

const summarizeWorkbench = (artifact: WorkbenchArtifact): string =>
  JSON.stringify({
    revision: artifact.semantic_rev,
    nodes: artifact.payload.nodes.map(node => ({ id: node.id, label: node.label, kind: node.kind })),
    edges: artifact.payload.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      label: edge.label
    }))
  })

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
  const transcriptWriteErrorRef = useRef<unknown>(null)
  const wasEnabledRef = useRef(enabled)

  const end = useCallback(() => {
    startGenerationRef.current += 1
    connectionRef.current?.close()
    connectionRef.current = null
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
          await transcriptWriteChainRef.current

          if (transcriptWriteErrorRef.current) {
            throw transcriptWriteErrorRef.current
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
            .then(() => {
              transcriptWriteErrorRef.current = null
            })
            .catch(error => {
              transcriptWriteErrorRef.current = error
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
    stopTurn: undefined,
    toggleMute
  }
}
