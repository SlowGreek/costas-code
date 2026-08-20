export interface RealtimeTurnToolCall {
  arguments: string
  callId: string
  name: string
  responseId: string
}

export interface RealtimeTurnSnapshot {
  completedActions: string[]
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

export type RealtimeToolLane = 'edit' | 'gesture' | 'read' | 'serial' | 'slow'

interface RealtimeTurnControllerOptions {
  execute: (call: RealtimeTurnToolCall) => Promise<unknown>
  laneFor?: (call: RealtimeTurnToolCall) => RealtimeToolLane
  maxActions?: number
  maxToolRounds?: number
  maxTurnMs?: number
  now?: () => number
  onSettled?: (turn: RealtimeTurnSnapshot) => void
  send: (event: Record<string, unknown>) => void
  turnIdPrefix?: string
}

interface TrackedCall extends RealtimeTurnToolCall {
  outputSent: boolean
}

interface TrackedResponse {
  calls: TrackedCall[]
  done: boolean
  generation: number
  id: string
}

interface ActiveTurn {
  activeResponseId: null | string
  actions: number
  callIds: Set<string>
  cancelled: boolean
  completedActions: string[]
  generation: number
  goal: string
  id: string
  responses: Map<string, TrackedResponse>
  startedAt: number
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
  goal: turn.goal,
  id: turn.id,
  remainingActions: Math.max(0, maxActions - turn.actions),
  remainingToolRounds: Math.max(0, maxToolRounds - turn.toolRounds),
  toolRounds: turn.toolRounds
})

const continuationInstructions = (
  turn: ActiveTurn,
  maxActions: number,
  maxToolRounds: number,
  finalResponse: boolean
): string => {
  const state = snapshot(turn, maxActions, maxToolRounds)
  const completed = state.completedActions.length ? state.completedActions.join(', ') : 'none yet'
  const goal = state.goal || "Continue the user's current request."

  return [
    `Continue the same semantic turn (${state.id}).`,
    `User goal: ${goal}`,
    `Completed actions: ${completed}.`,
    finalResponse
      ? 'No tool rounds remain. Give the best current answer without calling tools.'
      : `Remaining tool rounds: ${state.remainingToolRounds}. You may call another tool when its result advances the goal.`,
    'Continue from the tool results without greeting, restarting, or recapping what you already said.'
  ].join(' ')
}

export interface RealtimeTurnController {
  activeTurn: () => null | RealtimeTurnSnapshot
  beginTurn: (goal?: string) => string
  close: () => void
  functionCallDone: (call: RealtimeTurnToolCall) => void
  interrupt: () => void
  responseCreated: (responseId: string) => void
  responseDone: (responseId: string) => Promise<RealtimeTurnOutcome>
  turnIdForResponse: (responseId?: string) => null | string
  updateGoal: (goal: string) => void
}

export function createRealtimeTurnController(options: RealtimeTurnControllerOptions): RealtimeTurnController {
  const maxActions = Math.max(1, options.maxActions ?? 8)
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

  const currentSnapshot = (): null | RealtimeTurnSnapshot =>
    current ? snapshot(current, maxActions, maxToolRounds) : null

  const start = (goal = ''): string => {
    generation += 1
    turnSequence += 1
    blockedUntilBegin = false
    current = {
      activeResponseId: null,
      actions: 0,
      callIds: new Set(),
      cancelled: false,
      completedActions: [],
      generation,
      goal: goal.trim(),
      id: `${turnIdPrefix}-${turnSequence}`,
      responses: new Map(),
      startedAt: now(),
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

    const response = { calls: [], done: false, generation: turn.generation, id }
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
    const turn = current

    if (!turn) {
      blockedUntilBegin = true

      return
    }

    turn.cancelled = true
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

      if (!turn || turn.cancelled || turn.callIds.has(call.callId)) {
        return
      }

      turn.callIds.add(call.callId)
      const response = ensureResponse(turn, call.responseId)
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
    responseDone: async responseId => {
      const turn = current

      if (closed || !turn || turn.cancelled) {
        return { continued: false, settled: false }
      }

      const response = ensureResponse(turn, responseId)

      if (response.done) {
        return { continued: false, settled: current === null }
      }

      response.done = true

      if (!response.calls.length) {
        current = null
        options.onSettled?.(snapshot(turn, maxActions, maxToolRounds))

        return { continued: false, settled: true }
      }

      turn.toolRounds += 1
      const generationAtStart = turn.generation

      const results = new Map<string, { executed: boolean; output: unknown }>()
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

        if (lane === 'gesture' && gestureLastIndex.get(call.name) !== index) {
          results.set(call.callId, { executed: false, output: { superseded: true } })

          return
        }

        if (turn.actions >= maxActions) {
          results.set(call.callId, {
            executed: false,
            output: { error: 'Voice action budget exhausted' }
          })

          return
        }

        turn.actions += 1
        let output: unknown
        let timeoutId: ReturnType<typeof setTimeout> | undefined

        try {
          const timeout = Symbol('voice-tool-timeout')
          const remainingMs = Math.max(0, maxTurnMs - (now() - turn.startedAt))

          const result = await Promise.race([
            options.execute(call),
            new Promise<typeof timeout>(resolve => {
              timeoutId = setTimeout(() => resolve(timeout), remainingMs)
            })
          ])

          output = result === timeout ? { error: 'Voice tool timed out' } : result
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) }
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId)
          }
        }

        if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart || call.outputSent) {
          return
        }

        results.set(call.callId, { executed: true, output })
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

      for (const call of response.calls) {
        const result = results.get(call.callId)

        if (!result || call.outputSent) {
          continue
        }

        call.outputSent = true

        if (result.executed) {
          turn.completedActions.push(call.name)
        }

        options.send(outputEvent(call.callId, result.output))
      }

      if (closed || current !== turn || turn.cancelled || turn.generation !== generationAtStart) {
        return { continued: false, settled: false }
      }

      const finalResponse =
        turn.toolRounds >= maxToolRounds || turn.actions >= maxActions || now() - turn.startedAt >= maxTurnMs

      options.send({
        type: 'response.create',
        response: {
          instructions: continuationInstructions(turn, maxActions, maxToolRounds, finalResponse),
          ...(finalResponse ? { tool_choice: 'none' } : {})
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
