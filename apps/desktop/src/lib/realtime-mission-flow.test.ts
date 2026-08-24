import { describe, expect, it, vi } from 'vitest'

import { $realtimeMissions, applyRealtimeMissionGatewayEvent, publishRealtimeMission } from '@/store/realtime-mission'

import { createRealtimeMissionRuntime } from './realtime-mission-runtime'
import { executeRealtimeVoiceTool } from './realtime-voice'

describe('Realtime Mission Mode assembled flow', () => {
  it('dispatches research, accepts its exact ready event, and resumes once', async () => {
    $realtimeMissions.set({})
    const resume = vi.fn(() => true)
    const runtime = createRealtimeMissionRuntime({ publish: publishRealtimeMission, resume })
    runtime.focusSession('runtime-1')
    runtime.connectionOpened()

    const request = vi.fn(async () => ({
      status: 'dispatched',
      mission_id: 'mission_flow',
      artifact_id: 'research_flow',
      delegation_id: 'deleg_flow'
    }))

    await executeRealtimeVoiceTool(
      {
        arguments: '{"query":"Trace the complete architecture"}',
        callId: 'call-research',
        name: 'delegate_research',
        responseId: 'response-1'
      },
      {
        createMissionId: () => 'mission_flow',
        onResearchDispatched: runtime.startMission,
        request,
        runtimeSessionId: 'runtime-1'
      }
    )

    expect($realtimeMissions.get()['runtime-1']?.state).toBe('researching')
    expect(request).toHaveBeenCalledWith('voice.realtime.delegate_research', {
      mission_id: 'mission_flow',
      query: 'Trace the complete architecture',
      session_id: 'runtime-1'
    })

    const readyEvent = {
      type: 'voice.realtime.research.ready',
      session_id: 'runtime-1',
      payload: {
        mission_id: 'mission_flow',
        artifact_id: 'research_flow',
        delegation_id: 'deleg_flow'
      }
    }

    expect(applyRealtimeMissionGatewayEvent(readyEvent)).toBe(true)
    runtime.researchReady({
      missionId: 'mission_flow',
      artifactId: 'research_flow',
      delegationId: 'deleg_flow'
    })

    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' }))
    expect($realtimeMissions.get()['runtime-1']?.state).toBe('resuming')

    expect(applyRealtimeMissionGatewayEvent(readyEvent)).toBe(true)
    runtime.researchReady({
      missionId: 'mission_flow',
      artifactId: 'research_flow',
      delegationId: 'deleg_flow'
    })
    expect(resume).toHaveBeenCalledOnce()
  })
})
