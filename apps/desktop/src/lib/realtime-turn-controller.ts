export interface RealtimeTurnToolCall {
  arguments: string
  callId: string
  name: string
  responseId: string
}

export interface RealtimeToolExecution extends RealtimeTurnToolCall {
  output: unknown
  status: 'failure' | 'skipped' | 'success'
}

export interface RealtimeTurnSnapshot {
  completedActions: string[]
  executions: RealtimeToolExecution[]
  goal: string
  id: string
  remainingActions: number
  remainingToolRounds: number
  toolRounds: number
}

export interface RealtimeTurnOutcome {
  continued: boolean
  settled: boolean
}

export interface RealtimeStopInput {
  candidateText: string
  canContinue: boolean
  responseId: string
  /** How many times this turn has already been challenged. Bounds the judge. */
  stopChallenges: number
  turn: RealtimeTurnSnapshot
}

export interface RealtimeTerminalProposalInput {
  candidateText: string
  proposal: RealtimeToolExecution
  responseId: string
  turn: RealtimeTurnSnapshot
}

export type RealtimeStopOutcome =
  | { kind: 'allow' }
  | { context: string; kind: 'continue_once'; toolChoice?: 'required' }

export type RealtimeToolLane = 'edit' | 'gesture' | 'presentation' | 'read' | 'serial' | 'slow' | 'terminal'

interface RealtimeTurnControllerOptions {
  baseInstructions?: () => string
  execute: (call: RealtimeTurnToolCall, signal: AbortSignal) => Promise<unknown>
  laneFor?: (call: RealtimeTurnToolCall) => RealtimeToolLane
  maxActions?: number
  /**
   * How many times one semantic turn may be challenged for ending without an
   * explicit completion declaration. The same bound applies across every tool
   * domain and remains inside the action/round/time budgets.
   */
  maxStopChallenges?: number
  maxToolRounds?: number
  maxTurnMs?: number
  now?: () => number
  onSettled?: (turn: RealtimeTurnSnapshot) => void
  send: (event: Record<string, unknown>) => void
  stop?: (input: RealtimeStopInput) => Promise<RealtimeStopOutcome> | RealtimeStopOutcome
  turnIdPrefix?: string
  verifyTerminal?: (
    input: RealtimeTerminalProposalInput
  ) => Promise<RealtimeStopOutcome> | RealtimeStopOutcome
}

interface TrackedCall extends RealtimeTurnToolCall {
  outputSent: boolean
}

interface TrackedResponse {
  assistantText: string
  calls: TrackedCall[]
  done: boolean
  generation: number
  id: string
}

interface ActiveTurn {
  activeResponseId: null | string
  actions: number
  abortController: AbortController
  callIds: Set<string>
  cancelled: boolean
  completedActions: string[]
  executions: RealtimeToolExecution[]
  generation: number
  gestureNarrationPending: boolean
  goal: string
  id: string
  responses: Map<string, TrackedResponse>
  startedAt: number
  stopChallenges: number
  toolRounds: number
}

const outputEvent = (callId: string, output: unknown): Record<string, unknown> => ({
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify(output)
  }
})

const snapshot = (turn: ActiveTurn, maxActions: number, maxToolRounds: number): RealtimeTurnSnapshot => ({
  completedActions: [...turn.completedActions],
  executions: turn.executions.map(execution => ({ ...execution })),
  goal: turn.goal,
  id: turn.id,
  remainingActions: Math.max(0, maxActions - turn.actions),
  remainingToolRounds: Math.max(0, maxToolRounds - turn.toolRounds),
  toolRounds: turn.toolRounds
})

const boundedJson = (value: unknown, maxChars: number): string => {
  let text: string

  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }

  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

const isStructuredToolError = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { error?: unknown }).error === 'string' &&
      (value as { error: string }).error.trim()
  )

const executionMemory = (turn: ActiveTurn): string => {
  if (!turn.executions.length) {
    return 'none yet'
  }

  return turn.executions
    .slice(-8)
    .map(execution => {
      const args =
        execution.arguments.length <= 200
          ? execution.arguments
          : `${execution.arguments.slice(0, 199)}…`

      return (
        `${execution.name}(${args}) -> ` +
        `[${execution.status}] ${boundedJson(execution.output, 300)}`
      )
    })
    .join('; ')
}

const continuationInstructions = (
  turn: ActiveTurn,
  maxActions: number,
  maxToolRounds: number,
  finalResponse: boolean,
  baseInstructions = '',
  stopContext = ''
): string => {
  const state = snapshot(turn, maxActions, maxToolRounds)
  const completed = state.completedActions.length ? state.completedActions.join(', ') : 'none yet'
  const executions = executionMemory(turn)
  const goal = state.goal || "Continue the user's current request."

  return [
    baseInstructions.trim(),
    `Continue the same semantic turn (${state.id}).`,
    `User goal: ${goal}`,
    stopContext.trim() ? `Stop checkpoint context:\n${stopContext.trim()}` : '',
    `Completed actions: ${completed}.`,
    `Execution memory: ${executions}.`,
    finalResponse
      ? 'No tool rounds remain. Give the best current answer without calling tools.'
      : `Remaining tool rounds: ${state.remainingToolRounds}. You may call another tool when its result advances the goal.`,
    'Continue from the tool results without greeting, restarting, or recapping what you already said.'
  ].filter(Boolean).join('\n\n')
}

export interface RealtimeTurnController {
  activeTurn: () => null | RealtimeTurnSnapshot
  assistantAudioEnded: () => void
  assistantAudioStarted: () => void
  assistantTranscriptDone: (responseId: string, text: string) => void
  beginTurn: (goal?: string) => string
  close: () => void
  functionCallDone: (call: RealtimeTurnToolCall) => void
  interrupt: () => void
  responseCreated: (responseId: string) => void
  responseDone: (responseId: string, status?: string) => Promise<RealtimeTurnOutcome>
  turnIdForResponse: (responseId?: string) => null | string
  updateGoal: (goal: string) => void
}

export function createRealtimeTurnController(options: RealtimeTurnControllerOptions): RealtimeTurnController {
  const maxActions = Math.max(1, options.maxActions ?? 8)
  const maxStopChallenges = Math.max(0, options.maxStopChallenges ?? 1)
  const maxToolRounds = Math.max(1, options.maxToolRounds ?? 4)
  const maxTurnMs = Math.max(1_000, options.maxTurnMs ?? 30_000)
  const now = options.now ?? Date.now
  const turnIdPrefix = options.turnIdPrefix?.trim() || 'voice-turn'

  let closed = false
  let generation = 0
  let lastTurnId: null | string = null
  let turnSequence = 0
  let blockedUntilBegin = false
  let current: ActiveTurn | null = null
  const responseTurnIds = new Map<string, string>()
  let audioPlaying = false
  let audioEndedPromise = Promise.resolve()
  let resolveAudioEnded: null | (() => void) = null

  const expectAudio = () => {
    if (resolveAudioEnded) {
      return
    }

    audioEndedPromise = new Promise<void>(resolve => {
      resolveAudioEnded = resolve
    })
  }

  const finishAudio = () => {
    if (!audioPlaying && !resolveAudioEnded) {
      return
    }

    audioPlaying = false
    resolveAudioEnded?.()
    resolveAudioEnded = null
    audioEndedPromise = Promise.resolve()
  }

  const startAudio = () => {
    if (audioPlaying) {
      return
    }

    audioPlaying = true
    expectAudio()
  }

  const currentSnapshot = (): null | RealtimeTurnSnapshot =>
    current ? snapshot(current, maxActions, maxToolRounds) : null

  const start = (goal = ''): string => {
    generation += 1
    turnSequence += 1
    blockedUntilBegin = false
    current = {
      activeResponseId: null,
      actions: 0,
      abortController: new AbortController(),
      callIds: new Set(),
      cancelled: false,
      completedActions: [],
      executions: [],
      generation,
      gestureNarrationPending: false,
      goal: goal.trim(),
      id: `${turnIdPrefix}-${turnSequence}`,
      responses: new Map(),
      startedAt: now(),
      stopChallenges: 0,
      toolRounds: 0
    }
    lastTurnId = current.id

    return current.id
  }

  const ensureResponse = (turn: ActiveTurn, responseId: string): TrackedResponse => {
    const id = responseId.trim() || turn.activeResponseId || `response-${turn.responses.size + 1}`
    const existing = turn.responses.get(id)

    if (existing) {
      turn.activeResponseId = id

      return existing
    }

    const response = { assistantText: '', calls: [], done: false, generation: turn.generation, id }
    turn.responses.set(id, response)
    turn.activeResponseId = id
    responseTurnIds.set(id, turn.id)

    if (responseTurnIds.size > 32) {
      const oldest = responseTurnIds.keys().next().value

      if (oldest) {
        responseTurnIds.delete(oldest)
      }
    }

    return response
  }

  const interrupt = () => {
    finishAudio()
    const turn = current

    if (!turn) {
      blockedUntilBegin = true

      return
    }

    turn.cancelled = true
    turn.abortController.abort()
    blockedUntilBegin = true

    for (const response of turn.responses.values()) {
      for (const call of response.calls) {
        if (call.outputSent) {
          continue
        }

        call.outputSent = true
        options.send(outputEvent(call.callId, { cancelled: true }))
      }
    }

    current = null
  }

  return {
    activeTurn: currentSnapshot,
    assistantAudioEnded: finishAudio,
    assistantAudioStarted: startAudio,
    assistantTranscriptDone: (responseId, text) => {
      const turn = current
      const id = responseId.trim()
      const response = turn && id ? turn.responses.get(id) : undefined

      if (!response || response.done || responseTurnIds.get(id) !== turn?.id) {
        return
      }

      response.assistantText = text.trim()

      if (response.assistantText) {
        // Transcript completion proves this response has spoken output even
        // when response.done beats output_audio_buffer.started over the wire.
        expectAudio()
      }
    },
    beginTurn: start,
    close: () => {
      if (closed) {
        return
      }

      closed = true
      interrupt()
    },
    functionCallDone: call => {
      if (closed || blockedUntilBegin || !call.callId.trim()) {
        return
      }

      const turn = current
      const responseId = call.responseId.trim()

      if (!turn || turn.cancelled || !responseId || turn.callIds.has(call.callId)) {
        return
      }

      const response = turn.responses.get(responseId)

      if (!response || response.done || responseTurnIds.get(responseId) !== turn.id) {
        return
      }

      turn.callIds.add(call.callId)
      response.calls.push({ ...call, outputSent: false })
    },
    interrupt,
    responseCreated: responseId => {
      if (closed || blockedUntilBegin) {
        return
      }

      const turn = current ?? (() => {
        start()

        return current!
      })()

      ensureResponse(turn, responseId)
    },
    responseDone: async (responseId, status = 'completed') => {
      const turn = current

      if (closed || !turn || turn.cancelled) {
        return { continued: false, settled: false }
      }

      const id = responseId.trim()
      const response = id ? turn.responses.get(id) : undefined

      if (!response || responseTurnIds.get(id) !== turn.id) {
        return { continued: false, settled: false }
      }

      if (response.done) {
        return { continued: false, settled: current === null }
      }

      response.done = true

      if (status !== 'completed') {
        current = null
        options.onSettled?.(snapshot(turn, maxActions, maxToolRounds))

        return { continued: false, settled: true }
      }

      if (response.assistantText.trim()) {
        turn.gestureNarrationPending = false
      }

      if (!response.calls.length) {
        const canContinue =
          turn.toolRounds < maxToolRounds &&
          turn.actions < maxActions &&
          now() - turn.startedAt < maxTurnMs

        if (turn.stopChallenges < maxStopChallenges && options.stop) {
          const stopChallenges = turn.stopChallenges

          turn.stopChallenges += 1
          let stopOutcome: RealtimeStopOutcome = { kind: 'allow' }

          try {
            stopOutcome = await options.stop({
              candidateText: response.assistantText,
              canContinue,
              responseId: response.id,
              stopChallenges,
              turn: snapshot(turn, maxActions, maxToolRounds)
            })
          } catch {
            stopOutcome = { kind: 'allow' }
          }

          if (closed || current !== turn || turn.cancelled || response.generation !== turn.generation) {
            return { continued: false, settled: false }
          }

          const context = stopOutcome.kind === 'continue_once' ? stopOutcome.context.trim() : ''

          if (stopOutcome.kind === 'continue_once' && canContinue && context && context.length <= 64_000) {
            options.send({
              type: 'response.create',
              response: {
                instructions: continuationInstructions(
                  turn,
                  maxActions,
                  maxToolRounds,
                  false,
                  options.baseInstructions?.(),
                  context
                ),
                ...(stopOutcome.toolChoice ? { tool_choice: stopOutcome.toolChoice } : {})
              }
            })

            return { continued: true, settled: false }
          }
        }

        current = null
        options.onSettled?.(snapshot(turn, maxActions, maxToolRounds))

        return { continued: false, settled: true }
      }

      turn.toolRounds += 1
      const generationAtStart = turn.generation

      const results = new Map<
        string,
        { executed: boolean; output: unknown; status: RealtimeToolExecution['status'] }
      >()

      const gestureLastIndex = new Map<string, number>()

      response.calls.forEach((call, index) => {
        if ((options.laneFor?.(call) ?? 'serial') === 'gesture') {
          gestureLastIndex.set(call.name, index)
        }
      })

      const runCall = async (call: TrackedCall, index: number) => {
        if (call.outputSent) {
          return
        }

        const lane = options.laneFor?.(call) ?? 'serial'
        const presentation = lane === 'gesture' || lane === 'presentation'

        if (lane === 'terminal' && response.calls.length !== 1) {
          results.set(call.callId, {
            executed: false,
            output: { error: 'finish_turn must be the only tool call in its response' },
            status: 'failure'
          })

          return
        }

        if (presentation && turn.gestureNarrationPending) {
          results.set(call.callId, {
            executed: false,
            output: {
              narration_required: true,
              message: 'Explain the currently focused item before moving focus again.'
            },
            status: 'skipped'
          })

          return
        }

        if (presentation && (audioPlaying || resolveAudioEnded !== null || response.assistantText.trim())) {
          const playbackRemainingMs = maxTurnMs - (now() - turn.startedAt)

          if (playbackRemainingMs <= 0) {
            results.set(call.callId, {
              executed: false,
              output: { error: 'Voice playback boundary timed out' },
              status: 'failure'
            })
            finishAudio()

            return
          }

          const playbackTimeout = Symbol('voice-playback-timeout')
          let playbackTimeoutId: ReturnType<typeof setTimeout> | undefined

          const playbackOutcome = await Promise.race([
            audioEndedPromise,
            new Promise<typeof playbackTimeout>(resolve => {
              playbackTimeoutId = setTimeout(() => resolve(playbackTimeout), playbackRemainingMs)
            })
          ])

          if (playbackTimeoutId !== undefined) {
            clearTimeout(playbackTimeoutId)
          }

          if (playbackOutcome === playbackTimeout) {
            results.set(call.callId, {
              executed: false,
              output: { error: 'Voice playback boundary timed out' },
              status: 'failure'
            })
            finishAudio()

            return
          }

          if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart) {
            return
          }
        }

        if (lane === 'gesture' && gestureLastIndex.get(call.name) !== index) {
          results.set(call.callId, {
            executed: false,
            output: { superseded: true },
            status: 'skipped'
          })

          return
        }

        if (turn.actions >= maxActions) {
          results.set(call.callId, {
            executed: false,
            output: { error: 'Voice action budget exhausted' },
            status: 'skipped'
          })

          return
        }

        const remainingMs = maxTurnMs - (now() - turn.startedAt)

        if (remainingMs <= 0) {
          results.set(call.callId, {
            executed: false,
            output: { error: 'Voice tool timed out' },
            status: 'failure'
          })

          return
        }

        turn.actions += 1
        let output: unknown
        let status: RealtimeToolExecution['status'] = 'success'
        let timeoutId: ReturnType<typeof setTimeout> | undefined

        try {
          if (lane === 'read') {
            const timeout = Symbol('voice-tool-timeout')

            const result = await Promise.race([
              options.execute(call, turn.abortController.signal),
              new Promise<typeof timeout>(resolve => {
                timeoutId = setTimeout(() => resolve(timeout), remainingMs)
              })
            ])

            if (result === timeout) {
              output = { error: 'Voice tool timed out' }
              status = 'failure'
            } else {
              output = result
            }
          } else {
            output = await options.execute(call, turn.abortController.signal)
          }
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) }
          status = 'failure'
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId)
          }
        }

        if (status === 'success' && isStructuredToolError(output)) {
          status = 'failure'
        }

        if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart || call.outputSent) {
          return
        }

        results.set(call.callId, { executed: true, output, status })
      }

      let callIndex = 0

      while (callIndex < response.calls.length) {
        const call = response.calls[callIndex]
        const lane = options.laneFor?.(call) ?? 'serial'

        if (lane === 'read') {
          const group: Array<{ call: TrackedCall; index: number }> = []

          while (
            callIndex < response.calls.length &&
            (options.laneFor?.(response.calls[callIndex]) ?? 'serial') === 'read'
          ) {
            group.push({ call: response.calls[callIndex], index: callIndex })
            callIndex += 1
          }

          await Promise.all(group.map(item => runCall(item.call, item.index)))
        } else {
          await runCall(call, callIndex)
          callIndex += 1
        }
      }

      if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart) {
        return { continued: false, settled: false }
      }

      let terminalRejection: Extract<RealtimeStopOutcome, { kind: 'continue_once' }> | null = null

      const terminalCall = response.calls.find(call => {
        const result = results.get(call.callId)

        return (
          (options.laneFor?.(call) ?? 'serial') === 'terminal' &&
          result?.executed === true &&
          result.status === 'success'
        )
      })

      if (terminalCall && options.verifyTerminal) {
        const result = results.get(terminalCall.callId)!
        let verification: RealtimeStopOutcome = { kind: 'allow' }

        try {
          verification = await options.verifyTerminal({
            candidateText: response.assistantText,
            proposal: {
              arguments: terminalCall.arguments,
              callId: terminalCall.callId,
              name: terminalCall.name,
              output: result.output,
              responseId: terminalCall.responseId,
              status: result.status
            },
            responseId: response.id,
            turn: snapshot(turn, maxActions, maxToolRounds)
          })
        } catch {
          verification = { kind: 'allow' }
        }

        if (verification.kind === 'continue_once') {
          terminalRejection = verification
          result.output = {
            accepted: false,
            error: 'Completion proposal rejected',
            reason: verification.context
          }
          result.status = 'failure'
        }
      }

      for (const call of response.calls) {
        const result = results.get(call.callId)

        if (!result || call.outputSent) {
          continue
        }

        call.outputSent = true
        turn.executions.push({
          arguments: call.arguments,
          callId: call.callId,
          name: call.name,
          output: result.output,
          responseId: call.responseId,
          status: result.status
        })

        if (result.executed) {
          turn.completedActions.push(call.name)

          const lane = options.laneFor?.(call) ?? 'serial'

          if ((lane === 'gesture' || lane === 'presentation') && result.status === 'success') {
            turn.gestureNarrationPending = true
          }
        }

        options.send(outputEvent(call.callId, result.output))
      }

      if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart) {
        return { continued: false, settled: false }
      }

      const terminalAccepted = response.calls.some(call => {
        const result = results.get(call.callId)

        return (
          (options.laneFor?.(call) ?? 'serial') === 'terminal' &&
          result?.executed === true &&
          result.status === 'success'
        )
      })

      if (terminalAccepted) {
        current = null
        options.onSettled?.(snapshot(turn, maxActions, maxToolRounds))

        return { continued: false, settled: true }
      }

      const finalResponse =
        turn.toolRounds >= maxToolRounds || turn.actions >= maxActions || now() - turn.startedAt >= maxTurnMs

      options.send({
        type: 'response.create',
        response: {
          instructions: continuationInstructions(
            turn,
            maxActions,
            maxToolRounds,
            finalResponse,
            options.baseInstructions?.(),
            terminalRejection?.context
          ),
          ...(finalResponse
            ? { tool_choice: 'none' }
            : terminalRejection?.toolChoice
              ? { tool_choice: terminalRejection.toolChoice }
              : {})
        }
      })

      return { continued: true, settled: false }
    },
    turnIdForResponse: responseId => {
      const id = responseId?.trim()

      return (id ? responseTurnIds.get(id) : undefined) ?? current?.id ?? lastTurnId
    },
    updateGoal: goal => {
      if (current && !current.cancelled) {
        current.goal = goal.trim()
      }
    }
  }
}
