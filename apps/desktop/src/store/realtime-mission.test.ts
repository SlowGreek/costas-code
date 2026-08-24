import { describe, expect, it } from 'vitest'

import type { RealtimeMissionSnapshot } from '@/lib/realtime-mission-controller'

import {
  $realtimeMissions,
  applyRealtimeMissionGatewayEvent,
  clearRealtimeMission,
  publishRealtimeMission,
  startRealtimeMission
} from './realtime-mission'

const mission = {
  artifactId: 'research_1',
  delegationId: 'deleg_1',
  label: 'Claude Code architecture',
  missionId: 'mission_1',
  runtimeSessionId: 'runtime-1'
}

describe('realtime mission store', () => {
  it('stores one researching projection per runtime session', () => {
    $realtimeMissions.set({})

    startRealtimeMission(mission)

    expect($realtimeMissions.get()['runtime-1']).toEqual({ ...mission, state: 'researching' })
  })

  it('accepts exact ready and failed gateway events while rejecting stale identities', () => {
    $realtimeMissions.set({})
    startRealtimeMission(mission)

    expect(
      applyRealtimeMissionGatewayEvent({
        type: 'voice.realtime.research.ready',
        session_id: 'runtime-1',
        payload: {
          mission_id: 'mission-old',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1'
        }
      })
    ).toBe(false)
    expect($realtimeMissions.get()['runtime-1']?.state).toBe('researching')

    expect(
      applyRealtimeMissionGatewayEvent({
        type: 'voice.realtime.research.ready',
        session_id: 'runtime-1',
        payload: {
          mission_id: 'mission_1',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1'
        }
      })
    ).toBe(true)
    expect($realtimeMissions.get()['runtime-1']?.state).toBe('ready')

    expect(
      applyRealtimeMissionGatewayEvent({
        type: 'voice.realtime.research.failed',
        session_id: 'runtime-1',
        payload: {
          mission_id: 'mission_1',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1',
          error: 'provider unavailable'
        }
      })
    ).toBe(true)
    expect($realtimeMissions.get()['runtime-1']).toMatchObject({
      error: 'provider unavailable',
      state: 'failed'
    })
  })

  it('publishes controller snapshots without touching other sessions', () => {
    $realtimeMissions.set({
      other: { ...mission, missionId: 'mission-other', runtimeSessionId: 'other', state: 'researching' }
    })
    const snapshot: RealtimeMissionSnapshot = { ...mission, state: 'awaiting_boundary' }

    publishRealtimeMission(snapshot)

    expect($realtimeMissions.get().other?.missionId).toBe('mission-other')
    expect($realtimeMissions.get()['runtime-1']).toEqual(snapshot)
  })

  it('clears only the matching mission identity', () => {
    $realtimeMissions.set({})
    startRealtimeMission(mission)

    expect(clearRealtimeMission('runtime-1', 'mission-old')).toBe(false)
    expect(clearRealtimeMission('runtime-1', 'mission_1')).toBe(true)
    expect($realtimeMissions.get()['runtime-1']).toBeUndefined()
  })
})
