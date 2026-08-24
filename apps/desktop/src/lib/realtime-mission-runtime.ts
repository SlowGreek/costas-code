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

export function createRealtimeMissionRuntime(
  options: RealtimeMissionRuntimeOptions
): RealtimeMissionRuntime {
  let controller: ReturnType<typeof createRealtimeMissionController>

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
      controller.researchFailed(event)
      publish()
    },
    researchReady(event) {
      controller.researchReady(event)
      publish()
    },
    snapshot: () => controller.snapshot(),
    startMission(mission) {
      controller.startMission(mission)
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
