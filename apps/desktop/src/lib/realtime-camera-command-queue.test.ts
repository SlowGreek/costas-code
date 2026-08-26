import { describe, expect, it, vi } from 'vitest'

import { applyCameraCommandWhenReady } from './realtime-camera-command-queue'

describe('applyCameraCommandWhenReady', () => {
  it('applies immediately when the target already exists', async () => {
    const apply = vi.fn(() => true)
    const listen = vi.fn()

    await expect(
      applyCameraCommandWhenReady({ apply, listen }, { kind: 'zoom_to' } as never)
    ).resolves.toBe(true)
    expect(apply).toHaveBeenCalledOnce()
    expect(listen).not.toHaveBeenCalled()
  })

  it('waits for a layout publication when a newly added node is not ready yet', async () => {
    let publish!: () => void
    const stop = vi.fn()
    const apply = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)

    const listen = vi.fn((callback: () => void) => {
      publish = callback

      return stop
    })

    const result = applyCameraCommandWhenReady(
      { apply, listen, timeoutMs: 1_000 },
      { kind: 'zoom_to' } as never
    )

    expect(apply).toHaveBeenCalledTimes(2)
    publish()
    await expect(result).resolves.toBe(true)
    expect(apply).toHaveBeenCalledTimes(3)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('rechecks after subscribing so a publication cannot slip through the setup gap', async () => {
    const stop = vi.fn()
    const apply = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const listen = vi.fn(() => stop)

    await expect(
      applyCameraCommandWhenReady({ apply, listen }, { kind: 'zoom_to' } as never)
    ).resolves.toBe(true)
    expect(listen).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('cleans up when the listener publishes synchronously during subscription', async () => {
    const stop = vi.fn()
    const apply = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)

    const listen = vi.fn((callback: () => void) => {
      callback()

      return stop
    })

    await expect(
      applyCameraCommandWhenReady({ apply, listen }, { kind: 'zoom_to' } as never)
    ).resolves.toBe(true)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('fails closed when no matching layout arrives before the bound', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const apply = vi.fn(() => false)
    const listen = vi.fn(() => stop)

    const result = applyCameraCommandWhenReady(
      { apply, listen, timeoutMs: 250 },
      { kind: 'zoom_to' } as never
    )

    await vi.advanceTimersByTimeAsync(250)
    await expect(result).resolves.toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels a queued camera before a later layout can mutate the canvas', async () => {
    const abort = new AbortController()
    let publish!: () => void
    let active = true

    const stop = vi.fn(() => {
      active = false
    })

    const apply = vi.fn(() => false)

    const listen = vi.fn((callback: () => void) => {
      publish = () => {
        if (active) {
          callback()
        }
      }

      return stop
    })

    const result = applyCameraCommandWhenReady(
      { apply, listen, signal: abort.signal },
      { kind: 'zoom_to' } as never
    )

    const callsBeforeAbort = apply.mock.calls.length

    abort.abort()
    await expect(result).resolves.toBe(false)
    publish()
    expect(apply).toHaveBeenCalledTimes(callsBeforeAbort)
    expect(stop).toHaveBeenCalledOnce()
  })
})
