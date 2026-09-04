export interface PeepsInteraction {
  auth_session_id: string
  timeout_seconds: number
}

export interface PeepsMainPreparation {
  challenge: string
  handle: string
}

export interface PeepsVoiceAuthRoute {
  connectionId: null | string
  profile: string
}

interface PeepsVoiceAuthBridge {
  prepare: () => Promise<PeepsMainPreparation>
  cancel: (request: { authSessionId?: string; handle: string }) => Promise<boolean>
  complete: (request: {
    authSessionId: string
    connectionId: null | string
    handle: string
    profile: string
    runtimeSessionId: string
  }) => Promise<boolean>
}

export interface CompleteRealtimePeepsAuthOptions {
  signal?: AbortSignal
}

function cancellationError(): Error {
  return new Error('Peeps voice authorization was cancelled or timed out')
}

export function createRealtimePeepsAuthCoordinator(
  resolveBridge: () => PeepsVoiceAuthBridge | undefined = () => window.hermesDesktop?.peepsVoiceAuth
) {
  let activeRunId = 0
  let activeCancel: null | (() => Promise<void>) = null

  return {
    async complete(
      runtimeSessionId: string,
      interaction: PeepsInteraction,
      prepared: PeepsMainPreparation,
      route: PeepsVoiceAuthRoute,
      options: CompleteRealtimePeepsAuthOptions = {}
    ): Promise<void> {
      const bridge = resolveBridge()

      if (!bridge) {
        throw new Error('Peeps voice authorization is unavailable in this client')
      }

      const runId = ++activeRunId
      const previousCancel = activeCancel

      if (previousCancel) {
        await previousCancel()
      }

      let cancelled = false
      let rejectCancelled: ((error: Error) => void) | null = null
      const cancelledPromise = new Promise<never>((_resolve, reject) => {
        rejectCancelled = reject
      })
      const cancelCurrent = async () => {
        if (cancelled) {
          return
        }
        cancelled = true
        rejectCancelled?.(cancellationError())
        await Promise.allSettled([
          bridge.cancel({ authSessionId: interaction.auth_session_id, handle: prepared.handle })
        ])
      }
      const onAbort = () => {
        void cancelCurrent()
      }

      activeCancel = cancelCurrent
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        if (options.signal?.aborted) {
          await cancelCurrent()
        }

        await Promise.race([
          bridge.complete({
            authSessionId: interaction.auth_session_id,
            connectionId: route.connectionId,
            handle: prepared.handle,
            profile: route.profile,
            runtimeSessionId
          }),
          cancelledPromise
        ])

        if (cancelled || runId !== activeRunId || options.signal?.aborted) {
          throw cancellationError()
        }
      } catch (error) {
        if (cancelled || runId !== activeRunId || options.signal?.aborted) {
          throw cancellationError()
        }

        throw error
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        if (runId === activeRunId) {
          activeCancel = null
        }
      }
    }
  }
}

const realtimePeepsAuthCoordinator = createRealtimePeepsAuthCoordinator()

/** Ask Electron main to resolve and complete one backend-bound Peeps flow. */
export async function completeRealtimePeepsAuth(
  runtimeSessionId: string,
  interaction: PeepsInteraction,
  prepared: PeepsMainPreparation,
  route: PeepsVoiceAuthRoute,
  options?: CompleteRealtimePeepsAuthOptions
): Promise<void> {
  await realtimePeepsAuthCoordinator.complete(runtimeSessionId, interaction, prepared, route, options)
}
