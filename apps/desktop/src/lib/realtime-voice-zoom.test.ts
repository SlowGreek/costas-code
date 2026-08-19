import { describe, expect, it, vi } from 'vitest'

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

describe('zoom_to voice tool', () => {
  it('is offered to the model as a playback-aware gesture', () => {
    expect(VOICE_TOOL_NAMES).toContain('zoom_to')
    expect(voiceToolLane(toolCall('zoom_to', { node_id: 'planner' }))).toBe('gesture')
  })

  it('frames the node without touching the gateway', async () => {
    const request = vi.fn()
    const onCameraTarget = vi.fn(() => true)

    const output = await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner' }),
      deps({ onCameraTarget, request })
    )

    expect(request).not.toHaveBeenCalled()
    expect(onCameraTarget).toHaveBeenCalledWith('planner', undefined)
    expect(output).toEqual({ status: 'framed' })
  })

  it('never waits on the transcription gate', async () => {
    const beforeToolCall = vi.fn(async () => undefined)

    await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner' }),
      deps({ beforeToolCall, onCameraTarget: () => true })
    )

    expect(beforeToolCall).not.toHaveBeenCalled()
  })

  it('accepts and bounds an optional zoom level', async () => {
    const onCameraTarget = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'planner', zoom: 99 }),
      deps({ onCameraTarget })
    )

    expect(onCameraTarget).toHaveBeenCalledWith('planner', 4)
  })

  it('resets the view when asked with no node', async () => {
    const onCameraTarget = vi.fn(() => true)

    await executeRealtimeVoiceTool(toolCall('zoom_to', {}), deps({ onCameraTarget }))

    expect(onCameraTarget).toHaveBeenCalledWith(null, undefined)
  })

  it('reports failure when the node is not on the canvas', async () => {
    const output = await executeRealtimeVoiceTool(
      toolCall('zoom_to', { node_id: 'ghost' }),
      deps({ onCameraTarget: () => false })
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
})
