import { afterEach, expect, it, vi } from 'vitest'

import {
  clearSingleFlightSessionResumeState,
  singleFlightSessionResume
} from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { resumeStoredRuntimeSession, withSessionNotFoundResume } from '@/app/session/hooks/use-prompt-actions/utils'
import { createClientSessionState } from '@/lib/chat-runtime'
import type * as GatewayModule from '@/store/gateway'
import { $connection } from '@/store/session'
import { runtimeSessionOwners } from '@/store/session-runtime-owner'
import {
  $sessionTiles,
  clearAllSessionStates,
  isSessionRemote,
  publishSessionState,
  recordSessionEventScope
} from '@/store/session-states'

afterEach(() => {
  clearAllSessionStates()
  $sessionTiles.set([])
  clearSingleFlightSessionResumeState()
})

vi.mock('@/store/gateway', async original => ({
  ...(await original<typeof GatewayModule>()),
  requestGatewayForAgent: vi.fn(async connection => ({ session_id: `runtime-${connection}` }))
}))

it('uses the captured exact owner for recovery coalescing, not a profile-only lookup', async () => {
  const owners = [
    { connectionId: 'one', profile: 'default' },
    { connectionId: 'two', profile: 'default' }
  ]

  const results = await Promise.all(
    owners.map((owner, index) =>
      resumeStoredRuntimeSession('copied', {
        owner,
        resolveProfile: async () => 'default',
        requestGateway: vi.fn(async () => ({ session_id: `runtime-${index}` })) as never
      })
    )
  )

  expect(results).toEqual(['runtime-one', 'runtime-two'])
})

it('joins foreground admission and recovery on the same captured owner', async () => {
  const owner = { connectionId: 'local', profile: 'default' }
  let release!: (value: { session_id: string }) => void

  const foreground = singleFlightSessionResume(
    'stored',
    () =>
      new Promise<{ session_id: string }>(resolve => {
        release = resolve
      }),
    owner
  )

  await Promise.resolve()
  const requestGateway = vi.fn(async () => ({ session_id: 'extra' }))
  const recovery = resumeStoredRuntimeSession('stored', { owner, requestGateway: requestGateway as never })
  await Promise.resolve()
  release({ session_id: 'original' })
  expect(await Promise.all([foreground.then(x => x.session_id), recovery])).toEqual(['original', 'original'])
  expect(requestGateway).not.toHaveBeenCalled()
})

it('preserves the original failure when recovery owner lookup fails', async () => {
  const original = new Error('session not found: original')
  await expect(
    withSessionNotFoundResume(
      'dead',
      'stored',
      async () => {
        throw original
      },
      {
        requestGateway: vi.fn() as never,
        resolveProfile: async () => {
          throw new Error('owner lookup failed')
        }
      }
    )
  ).rejects.toBe(original)
})

it.each([true, false])('preserves matching remote metadata with admission=%s', admitted => {
  $connection.set({ mode: 'local' } as never)
  const owner = { connectionId: 'remote-host', profile: 'default', targetProfile: 'target', mode: 'remote' as const }

  if (admitted) {
    runtimeSessionOwners.set('remote-runtime', owner)
  }

  publishSessionState('remote-runtime', createClientSessionState('stored'))
  $sessionTiles.set([{ storedSessionId: 'stored', ownerRoute: owner }])
  recordSessionEventScope({ connectionId: owner.connectionId, profile: owner.profile, session_id: 'remote-runtime' })
  expect(isSessionRemote('remote-runtime')).toBe(true)

  if (admitted) {
    expect(runtimeSessionOwners.get('remote-runtime')).toEqual(owner)
  }
})
