import { describe, expect, it, vi } from 'vitest'

import { completeRealtimePeepsAuth, createRealtimePeepsAuthCoordinator } from './realtime-voice-auth'

const interaction = {
  auth_session_id: 'auth',
  authority: 'renderer-authority',
  client_id: 'renderer-client',
  public_key: 'renderer-key',
  redirect_uri: 'https://renderer.invalid/',
  scope: 'renderer-scope',
  state: 'renderer-state',
  timeout_seconds: 1
}
const route = { connectionId: 'remote-1', profile: 'work' }

describe('completeRealtimePeepsAuth', () => {
  it('gives Electron only route and session identifiers, never OAuth values or an envelope', async () => {
    const complete = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      hermesDesktop: { peepsVoiceAuth: { complete, cancel: vi.fn().mockResolvedValue(true) } }
    })

    await completeRealtimePeepsAuth('runtime', interaction, route)

    expect(complete).toHaveBeenCalledWith({
      authSessionId: 'auth',
      connectionId: 'remote-1',
      profile: 'work',
      runtimeSessionId: 'runtime'
    })
    expect(JSON.stringify(complete.mock.calls)).not.toMatch(/renderer-key|renderer-client|renderer-scope|envelope/)
  })

  it('aborts an in-flight completion without exposing a wait result', async () => {
    const controller = new AbortController()
    const cancel = vi.fn().mockResolvedValue(true)
    let release: (() => void) | undefined
    const complete = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          release = () => resolve(true)
        })
    )
    vi.stubGlobal('window', { hermesDesktop: { peepsVoiceAuth: { complete, cancel } } })

    const pending = completeRealtimePeepsAuth('runtime', interaction, route, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/)
    expect(cancel).toHaveBeenCalledWith('auth')
    release?.()
  })
})

describe('createRealtimePeepsAuthCoordinator', () => {
  it('cancels a stale generation when a newer auth flow starts', async () => {
    const cancel = vi.fn().mockResolvedValue(true)
    let releaseFirst: (() => void) | undefined
    const bridge = {
      cancel,
      complete: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>(resolve => {
              releaseFirst = () => resolve(true)
            })
        )
        .mockResolvedValueOnce(true)
    }
    const coordinator = createRealtimePeepsAuthCoordinator(() => bridge)

    const first = coordinator.complete('runtime', { ...interaction, auth_session_id: 'auth-1' }, route)
    await vi.waitFor(() => expect(bridge.complete).toHaveBeenCalledTimes(1))
    const second = coordinator.complete('runtime', { ...interaction, auth_session_id: 'auth-2' }, route)
    releaseFirst?.()

    await expect(first).rejects.toThrow(/cancelled/)
    await expect(second).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledWith('auth-1')
  })
})
