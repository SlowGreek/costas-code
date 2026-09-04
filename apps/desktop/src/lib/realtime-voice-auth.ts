export interface PeepsInteraction {
  auth_session_id: string
  authority: string
  client_id: string
  public_key: string
  redirect_uri: string
  scope: string
  state: string
  timeout_seconds: number
}

interface PeepsVoiceAuthBridge {
  cancel: (id: string) => Promise<boolean>
  start: (
    id: string,
    flow: {
      authSessionId: string
      authority: string
      clientId: string
      publicKey: string
      redirectUri: string
      scope: string
      state: string
    }
  ) => Promise<boolean>
  wait: (id: string, timeoutMs: number) => Promise<null | {
    version: 1
    ephemeral_public_key: string
    nonce: string
    ciphertext: string
    tag: string
  }>
}

export interface CompleteRealtimePeepsAuthOptions {
  signal?: AbortSignal
}

function cancellationError(): Error {
  return new Error('Peeps voice authorization was cancelled or timed out')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw cancellationError()
  }
}

async function cancelAuthFlow(
  bridge: PeepsVoiceAuthBridge,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  runtimeSessionId: string,
  interaction: PeepsInteraction
): Promise<void> {
  await Promise.allSettled([
    bridge.cancel(interaction.auth_session_id),
    request('voice.realtime.peeps.cancel', {
      auth_session_id: interaction.auth_session_id,
      session_id: runtimeSessionId
    })
  ])
}

function waitForBridgeResult(
  bridge: PeepsVoiceAuthBridge,
  runtimeSessionId: string,
  interaction: PeepsInteraction,
  options: CompleteRealtimePeepsAuthOptions,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
): ReturnType<PeepsVoiceAuthBridge['wait']> {
  const waitPromise = bridge.wait(interaction.auth_session_id, interaction.timeout_seconds * 1000)

  if (!options.signal) {
    return waitPromise
  }

  const signal = options.signal

  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) {
        return
      }

      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = () => {
      void cancelAuthFlow(bridge, request, runtimeSessionId, interaction).finally(() =>
        finish(() => reject(cancellationError()))
      )
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void waitPromise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    )

    if (signal.aborted) {
      onAbort()
    }
  })
}

export function createRealtimePeepsAuthCoordinator(
  resolveBridge: () => PeepsVoiceAuthBridge | undefined = () => window.hermesDesktop?.peepsVoiceAuth
) {
  let activeRunId = 0
  let activeCancel: null | (() => Promise<void>) = null

  return {
    async complete(
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
      runtimeSessionId: string,
      interaction: PeepsInteraction,
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
      let resolveCancelledWait: ((value: null) => void) | null = null

      const cancelledWait = new Promise<null>(resolve => {
        resolveCancelledWait = resolve
      })

      const cancelCurrent = async () => {
        if (cancelled) {
          return
        }

        cancelled = true
        resolveCancelledWait?.(null)
        await cancelAuthFlow(bridge, request, runtimeSessionId, interaction)
      }

      activeCancel = cancelCurrent

      const ensureCurrent = () => {
        throwIfAborted(options.signal)

        if (runId !== activeRunId) {
          throw cancellationError()
        }
      }

      try {
        ensureCurrent()
        await bridge.start(interaction.auth_session_id, {
          authSessionId: interaction.auth_session_id,
          authority: interaction.authority,
          clientId: interaction.client_id,
          publicKey: interaction.public_key,
          redirectUri: interaction.redirect_uri,
          scope: interaction.scope,
          state: interaction.state
        })
        ensureCurrent()

        let envelope = await Promise.race([
          waitForBridgeResult(bridge, runtimeSessionId, interaction, options, request),
          cancelledWait
        ])

        ensureCurrent()

        if (!envelope) {
          await cancelCurrent()
          throw cancellationError()
        }

        try {
          await request('voice.realtime.peeps.complete', {
            auth_session_id: interaction.auth_session_id,
            envelope,
            session_id: runtimeSessionId,
            state: interaction.state
          })
        } finally {
          envelope = null
        }
      } catch (error) {
        if (!cancelled && (options.signal?.aborted || runId !== activeRunId)) {
          await cancelCurrent()
        }

        throw error
      } finally {
        if (runId === activeRunId) {
          activeCancel = null
        }
      }
    }
  }
}

const realtimePeepsAuthCoordinator = createRealtimePeepsAuthCoordinator()

/** Complete one backend-requested, desktop-local Peeps authorization handoff. */
export async function completeRealtimePeepsAuth(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  runtimeSessionId: string,
  interaction: PeepsInteraction,
  options?: CompleteRealtimePeepsAuthOptions
): Promise<void> {
  await realtimePeepsAuthCoordinator.complete(request, runtimeSessionId, interaction, options)
}
