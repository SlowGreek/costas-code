import { describe, expect, it, vi } from 'vitest'

import { createRealtimeTurnController } from './realtime-turn-controller'
import {
  executeRealtimeVoiceTool,
  VOICE_TOOL_NAMES,
  voiceToolLane
} from './realtime-voice'

const toolCall = (name: string, args: unknown) => ({
  arguments: JSON.stringify(args),
  callId: 'c1',
  name,
  responseId: 'r1'
})

const deps = (
  overrides: Partial<Parameters<typeof executeRealtimeVoiceTool>[1]> = {}
): Parameters<typeof executeRealtimeVoiceTool>[1] => ({
  request: vi.fn(),
  runtimeSessionId: 's1',
  ...overrides
})

describe('voice camera tools', () => {
  it('offers zoom_to as a playback-aware gesture', () => {
    expect(VOICE_TOOL_NAMES).toContain('zoom_to')
    expect(voiceToolLane(toolCall('zoom_to', { node_id: 'planner' }))).toBe('gesture')
  })

  it('frames one node without touching the gateway', async () => {
    const request = vi.fn()
    const onCameraCommand = vi.fn(() => true)

    const output = await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner' }),
      deps({ onCameraCommand, request })
    )

    expect(request).not.toHaveBeenCalled()
    expect(onCameraCommand).toHaveBeenCalledWith({
      anchor: 'center',
      kind: 'zoom_to',
      nodeId: 'planner',
      transition: 'smooth',
      zoom: undefined
    })
    expect(output).toEqual({ status: 'framed' })
  })

  it('never waits on the transcription gate', async () => {
    const beforeToolCall = vi.fn(async () => undefined)

    await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner' }),
      deps({ beforeToolCall, onCameraCommand: () => true })
    )

    expect(beforeToolCall).not.toHaveBeenCalled()
  })

  it('accepts and bounds an optional zoom level', async () => {
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner', zoom: 99 }),
      deps({ onCameraCommand })
    )

    expect(onCameraCommand).toHaveBeenCalledWith({
      anchor: 'center',
      kind: 'zoom_to',
      nodeId: 'planner',
      transition: 'smooth',
      zoom: 4
    })
  })

  it('keeps zoom_to without a node as a reset-compatible command', async () => {
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(toolCall('zoom_to', {}), deps({ onCameraCommand }))

    expect(onCameraCommand).toHaveBeenCalledWith({ kind: 'reset_view', transition: 'smooth' })
  })

  it('reports failure when a target is not on the canvas', async () => {
    const output = await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'ghost' }),
      deps({ onCameraCommand: () => false })
    )

    expect(output).toMatchObject({ error: expect.any(String) })
  })

  it('degrades safely when no canvas is mounted', async () => {
    const output = await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner' }),
      deps()
    )

    expect(output).toMatchObject({ error: expect.any(String) })
  })

  it('offers the full bounded 2D camera grammar as gesture tools', () => {
    for (const name of ['frame_nodes', 'pan_view', 'zoom_view', 'reset_view']) {
      expect(VOICE_TOOL_NAMES).toContain(name)
      expect(voiceToolLane(toolCall(name, {}))).toBe('gesture')
    }
  })

  it('frames a bounded node cluster with composition and transition', async () => {
    const request = vi.fn()
    const onCameraCommand = vi.fn(() => true)

    const output = await executeRealtimeVoiceTool(
      toolCall('frame_nodes', {
        node_ids: ['planner', 'executor', 'memory'],
        padding: 'tight',
        anchor: 'right',
        transition: 'dramatic'
      }),
      deps({ onCameraCommand, request })
    )

    expect(request).not.toHaveBeenCalled()
    expect(onCameraCommand).toHaveBeenCalledWith({
      anchor: 'right',
      kind: 'frame_nodes',
      nodeIds: ['planner', 'executor', 'memory'],
      padding: 'tight',
      transition: 'dramatic'
    })
    expect(output).toEqual({ status: 'framed' })
  })

  it('rejects an unbounded or underspecified cluster', async () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => `node-${index}`)

    await expect(
      executeRealtimeVoiceTool(
        toolCall('frame_nodes', { node_ids: tooMany }),
        deps({ onCameraCommand: () => true })
      )
    ).resolves.toMatchObject({ error: expect.any(String) })
    await expect(
      executeRealtimeVoiceTool(
        toolCall('frame_nodes', { node_ids: ['one'] }),
        deps({ onCameraCommand: () => true })
      )
    ).resolves.toMatchObject({ error: expect.any(String) })
  })

  it('rejects non-string, empty, or duplicate cluster ids exactly', async () => {
    const onCameraCommand = vi.fn(() => true)

    for (const nodeIds of [
      ['planner', 'executor', 7],
      ['planner', ''],
      ['planner', 'planner']
    ]) {
      await expect(
        executeRealtimeVoiceTool(
          toolCall('frame_nodes', { node_ids: nodeIds }),
          deps({ onCameraCommand })
        )
      ).resolves.toMatchObject({ error: expect.any(String) })
    }

    expect(onCameraCommand).not.toHaveBeenCalled()
  })

  it('pans only by bounded named directions and amounts', async () => {
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      toolCall('pan_view', { direction: 'right', amount: 'medium' }),
      deps({ onCameraCommand })
    )

    expect(onCameraCommand).toHaveBeenCalledWith({
      amount: 'medium',
      direction: 'right',
      kind: 'pan_view',
      transition: 'smooth'
    })
  })

  it('zooms the current composition relatively without naming a node', async () => {
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      toolCall('zoom_view', { direction: 'out', amount: 'small', transition: 'quick' }),
      deps({ onCameraCommand })
    )

    expect(onCameraCommand).toHaveBeenCalledWith({
      amount: 'small',
      direction: 'out',
      kind: 'zoom_view',
      transition: 'quick'
    })
  })

  it('resets explicitly with a cinematic transition', async () => {
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      toolCall('reset_view', { transition: 'dramatic' }),
      deps({ onCameraCommand })
    )

    expect(onCameraCommand).toHaveBeenCalledWith({
      kind: 'reset_view',
      transition: 'dramatic'
    })
  })

  it('dwells on the current frame until actual assistant playback ends', async () => {
    const executed: string[] = []

    const controller = createRealtimeTurnController({
      execute: async call => {
        executed.push(call.name)

        return { status: 'moved' }
      },
      laneFor: voiceToolLane,
      send: vi.fn()
    })

    controller.beginTurn('Walk through the architecture cinematically.')
    controller.responseCreated('response-1')
    controller.functionCallDone({
      ...toolCall('zoom_to', { node_id: 'planner' }),
      responseId: 'response-1'
    })
    await controller.responseDone('response-1')

    controller.responseCreated('response-2')
    controller.assistantTranscriptDone('response-2', 'The planner turns intent into a bounded plan.')
    controller.assistantAudioStarted()
    controller.functionCallDone({
      ...toolCall('zoom_view', { direction: 'out' }),
      callId: 'c2',
      responseId: 'response-2'
    })
    const completing = controller.responseDone('response-2')

    await Promise.resolve()
    expect(executed).toEqual(['zoom_to'])

    controller.assistantAudioEnded()
    await completing

    expect(executed).toEqual(['zoom_to', 'zoom_view'])
  })

  it('waits when response.done arrives before assistant playback starts', async () => {
    const executed: string[] = []

    const controller = createRealtimeTurnController({
      execute: async call => {
        executed.push(call.name)

        return { status: 'moved' }
      },
      laneFor: voiceToolLane,
      send: vi.fn()
    })

    controller.beginTurn('Walk through the architecture cinematically.')
    controller.responseCreated('response-1')
    controller.functionCallDone({
      ...toolCall('zoom_to', { node_id: 'planner' }),
      responseId: 'response-1'
    })
    await controller.responseDone('response-1')

    controller.responseCreated('response-2')
    controller.assistantTranscriptDone('response-2', 'The planner owns this decision.')
    controller.functionCallDone({
      ...toolCall('zoom_view', { direction: 'out' }),
      callId: 'c2',
      responseId: 'response-2'
    })
    const completing = controller.responseDone('response-2')

    await Promise.resolve()
    expect(executed).toEqual(['zoom_to'])

    controller.assistantAudioStarted()
    await Promise.resolve()
    expect(executed).toEqual(['zoom_to'])

    controller.assistantAudioEnded()
    await completing

    expect(executed).toEqual(['zoom_to', 'zoom_view'])
  })
})
