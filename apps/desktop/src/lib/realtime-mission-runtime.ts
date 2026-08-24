import {
  createRealtimeMissionController,
  type RealtimeMission,
  type RealtimeMissionFailedEvent,
  type RealtimeMissionReadyEvent,
  type RealtimeMissionResumeAction,
  type RealtimeMissionSnapshot
} from './realtime-mission-controller'

export interface RealtimeMissionRuntimeOptions {
  publish: (snapshot: RealtimeMissionSnapshot) => void
  resume: (event: RealtimeMissionResumeAction['event']) => boolean
}

export interface RealtimeMissionRuntime {
  assistantAudioEnded(): void
  assistantAudioStarted(): void
  cancelActive(): void
  connectionClosed(): void
  connectionOpened(): void
  focusSession(runtimeSessionId: null | string): void
  providerResponseEnded(status: string, continued?: boolean): void
  providerResponseStarted(): void
  researchFailed(event: RealtimeMissionFailedEvent): void
  researchReady(event: RealtimeMissionReadyEvent): void
  snapshot(): null | RealtimeMissionSnapshot
  startMission(mission: RealtimeMission): void
  userSpeechEnded(): void
  userSpeechStarted(): void
}

export interface RealtimeResearchStatusSnapshot {
  artifact_id?: unknown
  delegation_id?: unknown
  error?: unknown
  mission_id?: unknown
  status?: unknown
}

type PendingTerminalEvent =
  | { event: RealtimeMissionFailedEvent; type: 'failed' }
  | { event: RealtimeMissionReadyEvent; type: 'ready' }

const terminalIdentity = (event: RealtimeMissionReadyEvent): string =>
  `${event.missionId}\u0000${event.artifactId}\u0000${event.delegationId ?? ''}`

const missionIdentity = (mission: RealtimeMission): string => terminalIdentity(mission)

export function reconcileRealtimeMissionStatus(
  runtime: RealtimeMissionRuntime,
  status: RealtimeResearchStatusSnapshot
): boolean {
  const mission = runtime.snapshot()

  const identity = {
    artifactId: typeof status.artifact_id === 'string' ? status.artifact_id.trim() : '',
    delegationId: typeof status.delegation_id === 'string' ? status.delegation_id.trim() : '',
    missionId: typeof status.mission_id === 'string' ? status.mission_id.trim() : ''
  }

  if (!mission || missionIdentity(mission) !== terminalIdentity(identity)) {
    return false
  }

  if (status.status === 'ready') {
    runtime.researchReady(identity)

    return true
  }

  if (status.status === 'failed') {
    runtime.researchFailed({
      ...identity,
      error:
        typeof status.error === 'string' && status.error.trim()
          ? status.error.trim()
          : 'Research failed'
    })

    return true
  }

  return false
}

export function createRealtimeMissionRuntime(
  options: RealtimeMissionRuntimeOptions
): RealtimeMissionRuntime {
  let controller: ReturnType<typeof createRealtimeMissionController>
  const pendingTerminalEvents = new Map<string, PendingTerminalEvent>()

  const bufferTerminalEvent = (pending: PendingTerminalEvent) => {
    pendingTerminalEvents.set(terminalIdentity(pending.event), pending)

    if (pendingTerminalEvents.size > 8) {
      pendingTerminalEvents.delete(pendingTerminalEvents.keys().next().value as string)
    }
  }

  const publish = () => {
    const snapshot = controller.snapshot()

    if (snapshot) {
      options.publish(snapshot)
    }
  }

  controller = createRealtimeMissionController({
    onResume: action => {
      if (!options.resume(action.event)) {
        controller.cancelMission(action.missionId)
      }
    }
  })

  const updateBoundary = (boundary: Parameters<typeof controller.updateBoundary>[0]) => {
    controller.updateBoundary(boundary)
    publish()
  }

  return {
    assistantAudioEnded: () => updateBoundary({ assistantAudioPlaying: false }),
    assistantAudioStarted: () => updateBoundary({ assistantAudioPlaying: true }),
    cancelActive() {
      const mission = controller.snapshot()

      if (mission) {
        controller.cancelMission(mission.missionId)
        publish()
      }
    },
    connectionClosed: () => updateBoundary({ connectionOpen: false }),
    connectionOpened: () => updateBoundary({ connectionOpen: true }),
    focusSession: runtimeSessionId =>
      updateBoundary({ focusedRuntimeSessionId: runtimeSessionId }),
    providerResponseEnded(status, continued = false) {
      if (continued) {
        controller.updateBoundary({ providerResponseActive: true })
        publish()

        return
      }

      const mission = controller.snapshot()

      if (mission?.state === 'presenting') {
        if (status === 'completed') {
          controller.markComplete(mission.missionId)
        } else {
          controller.bargeIn()
        }
      }

      controller.updateBoundary({ providerResponseActive: false })
      publish()
    },
    providerResponseStarted() {
      controller.updateBoundary({ providerResponseActive: true })
      const mission = controller.snapshot()

      if (mission?.state === 'resuming') {
        controller.markPresenting(mission.missionId)
      }

      publish()
    },
    researchFailed(event) {
      const mission = controller.snapshot()

      if (!mission || missionIdentity(mission) !== terminalIdentity(event)) {
        bufferTerminalEvent({ event, type: 'failed' })

        return
      }

      controller.researchFailed(event)
      publish()
    },
    researchReady(event) {
      const mission = controller.snapshot()

      if (!mission || missionIdentity(mission) !== terminalIdentity(event)) {
        bufferTerminalEvent({ event, type: 'ready' })

        return
      }

      controller.researchReady(event)
      publish()
    },
    snapshot: () => controller.snapshot(),
    startMission(mission) {
      controller.startMission(mission)
      const pending = pendingTerminalEvents.get(missionIdentity(mission))

      if (pending) {
        pendingTerminalEvents.delete(missionIdentity(mission))

        if (pending.type === 'ready') {
          controller.researchReady(pending.event)
        } else {
          controller.researchFailed(pending.event)
        }
      }

      publish()
    },
    userSpeechEnded: () => updateBoundary({ userSpeaking: false }),
    userSpeechStarted() {
      controller.bargeIn()
      controller.updateBoundary({ userSpeaking: true })
      publish()
    }
  }
}
