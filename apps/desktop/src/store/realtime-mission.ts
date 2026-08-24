import { atom, computed } from 'nanostores'

import type {
  RealtimeMission,
  RealtimeMissionSnapshot
} from '@/lib/realtime-mission-controller'
import type { RpcEvent } from '@/types/hermes'

export interface RealtimeResearchEventPayload {
  artifact_id?: string
  delegation_id?: string
  error?: string
  mission_id?: string
}

export const $realtimeMissions = atom<Record<string, RealtimeMissionSnapshot>>({})

export const realtimeMissionForSession = (runtimeSessionId: null | string) =>
  computed($realtimeMissions, missions =>
    runtimeSessionId ? (missions[runtimeSessionId] ?? null) : null
  )

const writeMission = (snapshot: RealtimeMissionSnapshot): void => {
  $realtimeMissions.set({
    ...$realtimeMissions.get(),
    [snapshot.runtimeSessionId]: snapshot
  })
}

export function startRealtimeMission(mission: RealtimeMission): void {
  const existing = $realtimeMissions.get()[mission.runtimeSessionId]

  if (existing?.missionId === mission.missionId) {
    return
  }

  writeMission({ ...mission, state: 'researching' })
}

export function publishRealtimeMission(snapshot: RealtimeMissionSnapshot): void {
  writeMission(snapshot)
}

export function applyRealtimeMissionGatewayEvent(
  event: Pick<RpcEvent, 'payload' | 'session_id' | 'type'>
): boolean {
  if (
    event.type !== 'voice.realtime.research.ready' &&
    event.type !== 'voice.realtime.research.failed'
  ) {
    return false
  }

  const runtimeSessionId = event.session_id ?? ''
  const current = $realtimeMissions.get()[runtimeSessionId]
  const payload = event.payload as RealtimeResearchEventPayload | undefined

  if (
    !current ||
    !payload ||
    payload.mission_id !== current.missionId ||
    payload.artifact_id !== current.artifactId ||
    payload.delegation_id !== current.delegationId
  ) {
    return false
  }

  writeMission(
    event.type === 'voice.realtime.research.ready'
      ? { ...current, state: 'ready' }
      : {
          ...current,
          error: payload.error?.trim() || 'Research failed',
          state: 'failed'
        }
  )

  return true
}

export function clearRealtimeMission(
  runtimeSessionId: string,
  missionId?: string
): boolean {
  const current = $realtimeMissions.get()
  const mission = current[runtimeSessionId]

  if (!mission || (missionId && mission.missionId !== missionId)) {
    return false
  }

  const next = { ...current }
  delete next[runtimeSessionId]
  $realtimeMissions.set(next)

  return true
}
