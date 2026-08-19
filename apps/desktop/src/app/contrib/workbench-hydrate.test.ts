import { describe, expect, it, vi } from 'vitest'

import {
  $workbenchArtifact,
  resetWorkbenchForTests,
  type WorkbenchArtifact
} from '@/store/workbench'

import { createWorkbenchHydrator } from './workbench-hydrate'

const artifact = {
  artifact_id: 'map.main',
  kind: 'map',
  payload: { edges: [], nodes: [{ id: 'a', label: 'A' }] },
  semantic_rev: 1,
  view_rev: 1,
  view_state: {}
} as unknown as WorkbenchArtifact

describe('createWorkbenchHydrator', () => {
  it('recovers when the gateway connects AFTER the session is set', async () => {
    // The real cold-start ordering: session id lands first, socket later. A
    // session-only subscription took the `!gateway` early return once and
    // never retried, so the canvas stayed empty for the whole session even
    // though the artifact was sitting in the database.
    resetWorkbenchForTests()

    let gateway: null | { request: ReturnType<typeof vi.fn> } = null
    const request = vi.fn(async () => ({ artifacts: [artifact] }))

    const hydrate = createWorkbenchHydrator({
      getGateway: () => gateway as never,
      getSessionId: () => 'runtime-1'
    })

    // Session known, gateway still down.
    await hydrate('runtime-1')
    expect($workbenchArtifact.get()).toBeNull()
    expect(request).not.toHaveBeenCalled()

    // Socket opens — the gateway subscription re-runs the same hydrate.
    gateway = { request }
    await hydrate('runtime-1')

    expect(request).toHaveBeenCalledWith('artifact.list', { session_id: 'runtime-1' })
    expect($workbenchArtifact.get()?.artifact_id).toBe('map.main')
  })

  it('drops a slow reply that a newer hydrate already superseded', async () => {
    resetWorkbenchForTests()

    let active = 'runtime-1'
    let release: (() => void) | undefined

    const gate = new Promise<void>(resolve => {
      release = resolve
    })

    const request = vi.fn(async () => {
      await gate

      return { artifacts: [artifact] }
    })

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => active
    })

    const inFlight = hydrate('runtime-1')

    // User switches away before the first reply lands.
    active = 'runtime-2'
    release?.()
    await inFlight

    // The stale reply must not paint session 1's map over session 2.
    expect($workbenchArtifact.get()).toBeNull()
  })
})
