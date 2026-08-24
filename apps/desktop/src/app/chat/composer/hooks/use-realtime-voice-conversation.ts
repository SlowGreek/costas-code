import { useCallback, useEffect, useRef, useState } from 'react'

import { onGatewayEvent } from '@/contrib/events'
import { useI18n } from '@/i18n'
import { createRealtimeMissionRuntime } from '@/lib/realtime-mission-runtime'
import {
  type RealtimeTranscript,
  type RealtimeVoiceConnection,
  startRealtimeVoiceConnection
} from '@/lib/realtime-voice'
import {
  startWorkbenchContextSync,
  summarizeWorkbench
} from '@/lib/workbench-context-sync'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import {
  applyRealtimeMissionGatewayEvent,
  publishRealtimeMission,
  type RealtimeResearchEventPayload
} from '@/store/realtime-mission'
import {
  $workbenchArtifact,
  $workbenchLayout,
  $workbenchSelection
} from '@/store/workbench'
import type { RpcEvent, SessionMessage } from '@/types/hermes'

import { recentRealtimeSeedTurns } from './realtime-history-seed'
import { realtimeTranscriptRpcParams } from './realtime-transcript-persistence'
import type { ConversationStatus } from './use-voice-conversation'
import { voiceStartReadiness } from './voice-start-readiness'

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
      await request('voice.realtime.transcript', realtimeTranscriptRpcParams(runtimeSessionId, entry))

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
  const missionRuntimeRef = useRef<ReturnType<typeof createRealtimeMissionRuntime> | null>(null)

  if (!missionRuntimeRef.current) {
    missionRuntimeRef.current = createRealtimeMissionRuntime({
      publish: publishRealtimeMission,
      resume: event => connectionRef.current?.resumeMission(event) ?? false
    })
  }

  const missionRuntime = missionRuntimeRef.current
  const startGenerationRef = useRef(0)
  // A start attempted before the chat had a session, waiting for one.
  const pendingStartRef = useRef(false)
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
    missionRuntime.connectionClosed()
    pendingTranscriptionRef.current = null
    setMuted(false)
    setStatus('idle')
  }, [missionRuntime])

  const start = useCallback(async () => {
    const gateway = $gateway.get()
    const readiness = voiceStartReadiness({ hasGateway: !!gateway, sessionId: runtimeSessionId })

    if (readiness.kind === 'wait-for-session') {
      // A brand-new chat has no runtime session until its first message
      // creates one. Park the intent instead of discarding it: the effect
      // below starts as soon as the session lands, so the user does not have
      // to press the button a second time.
      pendingStartRef.current = true

      return
    }

    if (readiness.kind === 'fail' || !gateway || !runtimeSessionId) {
      const error = new Error(readiness.kind === 'fail' ? readiness.reason : 'Voice is unavailable')
      notifyError(error, t.notifications.voice.couldNotStartSession)
      onFatalError?.()

      return
    }

    pendingStartRef.current = false

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
        onAssistantAudioEnded: missionRuntime.assistantAudioEnded,
        onAssistantAudioStarted: missionRuntime.assistantAudioStarted,
        onProviderResponseEnded: missionRuntime.providerResponseEnded,
        onProviderResponseStarted: missionRuntime.providerResponseStarted,
        onResearchDispatched: missionRuntime.startMission,
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
        onUserSpeechEnded: missionRuntime.userSpeechEnded,
        onUserSpeechStarted: missionRuntime.userSpeechStarted,
        request: (method, params) => gateway.request(method, params),
        runtimeSessionId
      })

      if (generation !== startGenerationRef.current) {
        connection.close()

        return
      }

      connectionRef.current = connection
      missionRuntime.focusSession(runtimeSessionId)
      missionRuntime.connectionOpened()
      pendingTranscriptionRef.current = () => connection.awaitPendingTranscription()

      // Continue the conversation rather than starting cold. The typed chat and
      // the voice session share one session, so whatever was already discussed
      // (typed or spoken) is the context the user expects voice to have.
      try {
        const history = await gateway.request<{ messages?: SessionMessage[] }>(
          'session.history',
          { session_id: runtimeSessionId }
        )

        const turns = recentRealtimeSeedTurns(history.messages ?? [], HISTORY_SEED_TURNS)

        if (turns.length > 0 && generation === startGenerationRef.current) {
          connection.seedHistory(turns)
        }
      } catch {
        // Losing prior context is a degraded conversation, not a broken one —
        // never fail the connection over it.
      }

      const artifact = $workbenchArtifact.get()

      if (artifact) {
        connection.updateWorkbenchContext(
          summarizeWorkbench(artifact, {
            layout: $workbenchLayout.get(),
            selection: $workbenchSelection.get()
          })
        )
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
    missionRuntime,
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
    missionRuntime.cancelActive()
    connectionRef.current?.stopTurn()
  }, [missionRuntime])

  useEffect(() => {
    missionRuntime.focusSession(runtimeSessionId ?? null)
  }, [missionRuntime, runtimeSessionId])

  useEffect(() => {
    const handle = (event: RpcEvent) => {
      if (event.session_id !== runtimeSessionId || !applyRealtimeMissionGatewayEvent(event)) {
        return
      }

      const payload = event.payload as RealtimeResearchEventPayload | undefined

      if (!payload?.mission_id || !payload.artifact_id) {
        return
      }

      const identity = {
        artifactId: payload.artifact_id,
        delegationId: payload.delegation_id,
        missionId: payload.mission_id
      }

      if (event.type === 'voice.realtime.research.ready') {
        missionRuntime.researchReady(identity)
      } else {
        missionRuntime.researchFailed({
          ...identity,
          error: payload.error?.trim() || 'Research failed'
        })
      }
    }

    const stopReady = onGatewayEvent('voice.realtime.research.ready', handle)
    const stopFailed = onGatewayEvent('voice.realtime.research.failed', handle)

    return () => {
      stopReady()
      stopFailed()
    }
  }, [missionRuntime, runtimeSessionId])

  // Contract invariant §8: exactly ONE owner of context freshness. Every
  // source that can change what the model believes about the canvas —
  // artifact, layout, selection, pin/hide — funnels through this subscription.
  useEffect(
    () =>
      startWorkbenchContextSync({
        // The transition, appended silently. The model learns "Memory just
        // appeared" without being made to speak about it, so the canvas can
        // change mid-conversation without interrupting.
        appendEvent: event => {
          connectionRef.current?.appendContext(event)
        },
        // Pin/hide is Track B's concern and lives on the artifact's view_state.
        // Read lazily so the model is told a node is pinned or hidden rather
        // than silently describing a canvas the user has already rearranged.
        overlay: () => {
          const viewState = $workbenchArtifact.get()?.view_state as
            | undefined
            | { hidden?: string[]; user_pins?: Record<string, unknown> }

          return {
            hidden: viewState?.hidden,
            pinned: viewState?.user_pins ? Object.keys(viewState.user_pins) : undefined
          }
        },
        push: summary => {
          connectionRef.current?.updateWorkbenchContext(summary)
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

  // Resume a start that was parked because the chat had no session yet. A new
  // chat gets its runtime session when the first message creates one; without
  // this the parked intent would sit there forever and the mic would look
  // broken.
  useEffect(() => {
    if (enabled && runtimeSessionId && pendingStartRef.current) {
      void start()
    }
  }, [enabled, runtimeSessionId, start])

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
