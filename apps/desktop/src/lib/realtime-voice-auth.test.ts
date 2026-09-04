import { describe, expect, it, vi } from 'vitest'

import {
  completeRealtimePeepsAuth,
  createRealtimePeepsAuthCoordinator
} from './realtime-voice-auth'

const interaction = {
  auth_session_id: 'auth',
  authority: 'authority',
  client_id: 'client',
  redirect_uri: 'https://localhost:8080/',
  scope: 'scope',
  state: 'state',
  timeout_seconds: 1
}

describe('completeRealtimePeepsAuth', () => {
  it('uses the desktop-local bridge and relays the bearer only to complete', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    const start = vi.fn().mockResolvedValue(true)
    const wait = vi.fn().mockResolvedValue('peeps-bearer')
    vi.stubGlobal('window', {
      hermesDesktop: { peepsVoiceAuth: { start, wait, cancel: vi.fn().mockResolvedValue(true) } }
    })

    await completeRealtimePeepsAuth(request, 'runtime', interaction)

    expect(start).toHaveBeenCalledWith(
      'auth',
      expect.objectContaining({ redirectUri: 'https://localhost:8080/' })
    )
    expect(request).toHaveBeenCalledWith(
      'voice.realtime.peeps.complete',
      expect.objectContaining({ peeps_token: 'peeps-bearer' })
    )
    expect(request).not.toHaveBeenCalledWith(
      'voice.realtime.peeps.cancel',
      expect.anything()
    )
  })

  it('cancels the backend flow when the browser never returns a bearer', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    const cancel = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      hermesDesktop: {
        peepsVoiceAuth: { start: vi.fn(), wait: vi.fn().mockResolvedValue(null), cancel }
      }
    })

    await expect(
      completeRealtimePeepsAuth(request, 'runtime', interaction)
    ).rejects.toThrow(/cancelled/)

    expect(cancel).toHaveBeenCalledWith('auth')
    expect(request).toHaveBeenCalledWith(
      'voice.realtime.peeps.cancel',
      expect.objectContaining({ auth_session_id: 'auth', session_id: 'runtime' })
    )
  })

  it('aborts an in-flight auth wait and cancels both legs', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    const cancel = vi.fn().mockResolvedValue(true)
    const controller = new AbortController()
    let releaseWait: ((value: null | string) => void) | undefined

    vi.stubGlobal('window', {
      hermesDesktop: {
        peepsVoiceAuth: {
          cancel,
          start: vi.fn().mockResolvedValue(true),
          wait: vi.fn(
            () =>
              new Promise<null | string>(resolve => {
                releaseWait = resolve
              })
          )
        }
      }
    })

    const pending = completeRealtimePeepsAuth(request, 'runtime', interaction, {
      signal: controller.signal
    })
    controller.abort()
    releaseWait?.(null)

    await expect(pending).rejects.toThrow(/cancelled/)
    expect(cancel).toHaveBeenCalledWith('auth')
    expect(request).toHaveBeenCalledWith(
      'voice.realtime.peeps.cancel',
      expect.objectContaining({ auth_session_id: 'auth' })
    )
  })
})

describe('createRealtimePeepsAuthCoordinator', () => {
  it('cancels a stale generation when a newer auth flow starts', async () => {
    const firstRequest = vi.fn().mockResolvedValue({ ok: true })
    const secondRequest = vi.fn().mockResolvedValue({ ok: true })
    const cancel = vi.fn().mockResolvedValue(true)
    let releaseFirst: ((value: null | string) => void) | undefined
    const bridge = {
      cancel,
      start: vi.fn().mockResolvedValue(true),
      wait: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<null | string>(resolve => {
              releaseFirst = resolve
            })
        )
        .mockResolvedValueOnce('new-token')
    }
    const coordinator = createRealtimePeepsAuthCoordinator(() => bridge)

    const first = coordinator.complete(firstRequest, 'runtime', {
      ...interaction,
      auth_session_id: 'auth-1'
    })
    await vi.waitFor(() => expect(bridge.wait).toHaveBeenCalledTimes(1))
    const second = coordinator.complete(secondRequest, 'runtime', {
      ...interaction,
      auth_session_id: 'auth-2'
    })
    releaseFirst?.('old-token')

    await expect(first).rejects.toThrow(/cancelled/)
    await expect(second).resolves.toBeUndefined()

    expect(cancel).toHaveBeenCalledWith('auth-1')
    expect(firstRequest).toHaveBeenCalledWith(
      'voice.realtime.peeps.cancel',
      expect.objectContaining({ auth_session_id: 'auth-1' })
    )
    expect(secondRequest).toHaveBeenCalledWith(
      'voice.realtime.peeps.complete',
      expect.objectContaining({ peeps_token: 'new-token' })
    )
  })
})
