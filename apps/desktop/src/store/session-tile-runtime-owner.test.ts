import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useSessionTileDelegate } from '@/app/contrib/hooks/use-session-tile-delegate'
import { requestGatewayForAgent } from '@/store/gateway'
import type * as GatewayModule from '@/store/gateway'
import { runtimeSessionOwners } from '@/store/session-runtime-owner'
import { $sessionTiles, clearAllSessionStates, sessionTileDelegate } from '@/store/session-states'

vi.mock('@/store/gateway', async original => ({
  ...(await original<typeof GatewayModule>()),
  requestGatewayForAgent: vi.fn(async () => ({ session_id: 'recovered' }))
}))
afterEach(() => {
  cleanup()
  clearAllSessionStates()
  $sessionTiles.set([])
  vi.clearAllMocks()
})

it.each(['interrupt', 'submit'])('keeps tile %s and its recovery on the runtime owner', async action => {
  const owner = { connectionId: 'local', profile: 'default' }
  runtimeSessionOwners.set('original', owner)
  $sessionTiles.set([{ storedSessionId: 'copied', ownerRoute: { connectionId: 'local', profile: 'bot' } }])
  const ambient = vi.fn(async () => ({}))
  vi.mocked(requestGatewayForAgent).mockRejectedValueOnce(new Error('session not found'))
  renderHook(() =>
    useSessionTileDelegate({
      archiveSession: vi.fn(),
      branchStoredSession: vi.fn(),
      executeSlashCommand: vi.fn(),
      removeSession: vi.fn(),
      requestGateway: ambient as never,
      runtimeIdByStoredSessionIdRef: { current: new Map([['copied', 'original']]) },
      sessionStateByRuntimeIdRef: { current: new Map([['original', { storedSessionId: 'copied' }]]) } as never,
      updateSessionState: vi.fn()
    })
  )

  if (action === 'interrupt') {
    await sessionTileDelegate()!.interruptSession('original')
  } else {
    await sessionTileDelegate()!.submitToSession('original', 'hello')
  }

  expect(requestGatewayForAgent).toHaveBeenCalledTimes(3)

  for (const args of vi.mocked(requestGatewayForAgent).mock.calls) {
    expect(args.slice(0, 2)).toEqual(['local', 'default'])
  }

  expect(ambient).not.toHaveBeenCalled()
})
