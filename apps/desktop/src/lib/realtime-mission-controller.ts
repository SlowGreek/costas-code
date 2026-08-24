export type RealtimeMissionState =
  'researching' | 'ready' | 'awaiting_boundary' | 'resuming' | 'presenting' | 'complete' | 'failed' | 'cancelled'

export interface RealtimeMission {
  artifactId: string
  delegationId?: string
  label: string
  missionId: string
  runtimeSessionId: string
}

export interface RealtimeMissionSnapshot extends RealtimeMission {
  error?: string
  state: RealtimeMissionState
}

export interface RealtimeMissionBoundary {
  assistantAudioPlaying: boolean
  connectionOpen: boolean
  focusedRuntimeSessionId: null | string
  providerResponseActive: boolean
  userSpeaking: boolean
}

export interface RealtimeMissionReadyEvent {
  artifactId: string
  delegationId?: string
  missionId: string
}

export interface RealtimeMissionFailedEvent extends RealtimeMissionReadyEvent {
  error: string
}

export interface RealtimeMissionResumeAction {
  event: {
    type: 'response.create'
    response: { instructions: string }
  }
  missionId: string
  runtimeSessionId: string
}

export interface RealtimeMissionControllerOptions {
  onResume: (action: RealtimeMissionResumeAction) => void
}

export interface RealtimeMissionController {
  bargeIn(): void
  cancelMission(missionId: string): void
  markComplete(missionId: string): void
  markPresenting(missionId: string): void
  researchFailed(event: RealtimeMissionFailedEvent): void
  researchReady(event: RealtimeMissionReadyEvent): void
  snapshot(): null | RealtimeMissionSnapshot
  startMission(mission: RealtimeMission): void
  updateBoundary(boundary: Partial<RealtimeMissionBoundary>): void
}

const RESUME_INSTRUCTIONS =
  "Background research for the current mission is ready. Call research_status for the current artifact, inspect relevant evidence with research_search and research_read, then continue the user's original mission."

const initialBoundary: RealtimeMissionBoundary = {
  assistantAudioPlaying: false,
  connectionOpen: false,
  focusedRuntimeSessionId: null,
  providerResponseActive: false,
  userSpeaking: false
}

const cancellableStates = new Set<RealtimeMissionState>([
  'researching',
  'ready',
  'awaiting_boundary',
  'resuming',
  'presenting'
])

const bargeInStates = new Set<RealtimeMissionState>([
  'ready',
  'awaiting_boundary',
  'resuming',
  'presenting'
])

const failureStates = new Set<RealtimeMissionState>(['researching', 'ready', 'awaiting_boundary', 'resuming'])

export function createRealtimeMissionController(options: RealtimeMissionControllerOptions): RealtimeMissionController {
  let boundary = { ...initialBoundary }
  let active: null | RealtimeMissionSnapshot = null

  const matches = (event: RealtimeMissionReadyEvent) =>
    active !== null &&
    event.missionId === active.missionId &&
    event.artifactId === active.artifactId &&
    event.delegationId === active.delegationId

  const cancelActive = () => {
    if (active && cancellableStates.has(active.state)) {
      active = { ...active, state: 'cancelled' }
    }
  }

  const tryResume = () => {
    if (!active || (active.state !== 'ready' && active.state !== 'awaiting_boundary')) {
      return
    }

    const safe =
      boundary.connectionOpen &&
      boundary.focusedRuntimeSessionId === active.runtimeSessionId &&
      !boundary.userSpeaking &&
      !boundary.assistantAudioPlaying &&
      !boundary.providerResponseActive

    if (!safe) {
      active = { ...active, state: 'awaiting_boundary' }

      return
    }

    active = { ...active, state: 'resuming' }
    options.onResume({
      event: {
        type: 'response.create',
        response: { instructions: RESUME_INSTRUCTIONS }
      },
      missionId: active.missionId,
      runtimeSessionId: active.runtimeSessionId
    })
  }

  return {
    bargeIn() {
      if (active && bargeInStates.has(active.state)) {
        active = { ...active, state: 'cancelled' }
      }
    },
    cancelMission(missionId) {
      if (active?.missionId === missionId) {
        cancelActive()
      }
    },
    markComplete(missionId) {
      if (active?.missionId === missionId && active.state === 'presenting') {
        active = { ...active, state: 'complete' }
      }
    },
    markPresenting(missionId) {
      if (active?.missionId === missionId && active.state === 'resuming') {
        active = { ...active, state: 'presenting' }
      }
    },
    researchFailed(event) {
      if (!matches(event) || !active || !failureStates.has(active.state)) {
        return
      }

      active = { ...active, error: event.error, state: 'failed' }
    },
    researchReady(event) {
      if (!matches(event) || active?.state !== 'researching') {
        return
      }

      active = { ...active, state: 'ready' }
      tryResume()
    },
    snapshot: () => (active ? { ...active } : null),
    startMission(mission) {
      if (active?.missionId === mission.missionId) {
        return
      }

      active = { ...mission, state: 'researching' }
    },
    updateBoundary(next) {
      const previousFocusedSession = boundary.focusedRuntimeSessionId
      boundary = { ...boundary, ...next }

      if (
        active &&
        previousFocusedSession === active.runtimeSessionId &&
        boundary.focusedRuntimeSessionId !== null &&
        boundary.focusedRuntimeSessionId !== active.runtimeSessionId
      ) {
        cancelActive()
      }

      tryResume()
    }
  }
}
