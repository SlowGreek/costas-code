import { describe, expect, it, vi } from 'vitest'

import { appendLiveSessionProjection } from '@/app/session/hooks/use-session-actions/utils'

import { toChatMessages } from './chat-messages'
import { toRuntimeMessage } from './chat-runtime'
import { mergeSteeringReceipt, sendSteeringInput } from './steering-input'

it('retains identified delivery state across durable hydration and AUI projection', () => {
  const receipt = { message_id: 'm', turn_id: 't', status: 'committed' as const }
  const [message] = toChatMessages([{ role: 'user', content: 'Correction', display_metadata: { steering: receipt } }])
  expect(message.id).toBe('m')
  expect(message.steering).toEqual(receipt)
  expect(toRuntimeMessage(message).metadata.custom?.steering).toEqual(receipt)
})

it('reconnect rebuilds pending inputs once by ID, not by repeated text', () => {
  const input = { message_id: 'pending-id', turn_id: 't', status: 'pending' as const, content: 'Correction' }

  const projection = {
    session_id: 's',
    inflight: { user: 'Start', assistant: 'Working', streaming: true, user_inputs: [input] }
  }

  const first = appendLiveSessionProjection([], projection)
  const second = appendLiveSessionProjection(first, projection)
  expect(second.filter(m => m.id === 'pending-id')).toHaveLength(1)
  expect(second.find(m => m.id === 'pending-id')?.steering?.status).toBe('pending')
})

it('a delayed accepted reply cannot replace the committed receipt', () => {
  const committed = { message_id: 'm', turn_id: 't', status: 'committed' as const }
  expect(mergeSteeringReceipt(committed, { ...committed, status: 'pending' })).toBe(committed)
})

describe('identified steering delivery', () => {
  it('captures the active generation before staging, then submits the same ID', async () => {
    const calls: Array<[string, unknown]> = []

    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])

      return method === 'session.input.status'
        ? { turn_id: 'turn-1', status: 'active' }
        : { turn_id: 'turn-1', message_id: 'm-1', status: 'pending' }
    })

    const staged = vi.fn(async () => ['stage.png'])

    const receipt = await sendSteeringInput(
      request as never,
      { session_id: 's', message_id: 'm-1', text: 'Look' },
      staged
    )

    expect(receipt.status).toBe('pending')
    expect(calls).toEqual([
      ['session.input.status', { session_id: 's' }],
      ['session.input', { session_id: 's', message_id: 'm-1', turn_id: 'turn-1', text: 'Look', images: ['stage.png'] }]
    ])
    expect(staged).toHaveBeenCalledOnce()
  })

  it('reconciles a timed-out write without submitting another user turn', async () => {
    let reads = 0

    const request = vi.fn(async (method: string) => {
      if (method === 'session.input.status') {
        return ++reads === 1
          ? { turn_id: 't', status: 'active' }
          : { message_id: 'm', turn_id: 't', status: 'committed' }
      }

      throw new Error('RPC timed out')
    })

    const result = await sendSteeringInput(request as never, { session_id: 's', message_id: 'm', text: 'X' })
    expect(result.status).toBe('committed')
    expect(request.mock.calls.map(c => c[0])).toEqual(['session.input.status', 'session.input', 'session.input.status'])
  })

  it('does not queue an uncertain write or lose its identity on retry', async () => {
    const request = vi.fn(async (method: string, params: Record<string, string>) => {
      if (method === 'session.input.status' && !params.message_id) {
        return { turn_id: 't', status: 'active' }
      }
      throw new Error('disconnected')
    })

    await expect(sendSteeringInput(request as never, { session_id: 's', message_id: 'm', text: 'X' })).rejects.toThrow()
    expect(request.mock.calls.every(c => c[0] !== 'prompt.submit')).toBe(true)
  })

  it('retries an uncertain attempt with the original turn and message IDs', async () => {
    let online = false
    const writes: unknown[] = []

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'session.input.status' && !params.message_id) {
        return { status: 'active', turn_id: online ? 'new-turn' : 'old-turn' }
      }

      if (method === 'session.input') {
        writes.push(params)

        if (online) {
          return { ...params, status: 'committed' }
        }
      }

      throw new Error('disconnected')
    })

    const attempt = { session_id: 's', message_id: 'm', text: 'Correction' }
    await expect(sendSteeringInput(request as never, attempt)).rejects.toThrow()
    online = true
    const receipt = await sendSteeringInput(request as never, attempt)
    expect(receipt.turn_id).toBe('old-turn')
    expect(writes[0]).toEqual(writes[1])
  })

  it.each([{}, { status: 'pending' }, { status: 'pending', message_id: 'other', turn_id: 't' }])(
    'treats a malformed write receipt as unknown, not rejection: %j',
    async response => {
      const request = vi.fn(async (method: string) =>
        method === 'session.input.status' ? { status: 'active', turn_id: 't' } : response
      )

      await expect(
        sendSteeringInput(request as never, { session_id: 's', message_id: 'm', text: 'X' })
      ).rejects.toThrow()
      expect(request.mock.calls.every(call => call[0] !== 'prompt.submit')).toBe(true)
    }
  )

  it('does not silently discard images when staging fails', async () => {
    const request = vi.fn(async () => ({ turn_id: 't', status: 'active' }))
    await expect(
      sendSteeringInput(request as never, { session_id: 's', message_id: 'm', text: 'X' }, async () => {
        throw new Error('upload failed')
      })
    ).rejects.toThrow('upload failed')
    expect(request).toHaveBeenCalledOnce()
  })

  it('never retargets a correction when its turn closes during upload', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'session.input.status'
        ? { turn_id: 'old', status: 'active' }
        : { status: 'stale', message_id: 'm', turn_id: 'old' }
    )

    const result = await sendSteeringInput(
      request as never,
      { session_id: 's', message_id: 'm', text: 'X' },
      async () => []
    )

    expect(result.status).toBe('stale')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
