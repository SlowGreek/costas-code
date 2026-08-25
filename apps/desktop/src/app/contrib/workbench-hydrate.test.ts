import { describe, expect, it, vi } from 'vitest'

import {
  $workbenchArtifact,
  $workbenchCamera,
  resetWorkbenchCameraFor,
  resetWorkbenchForTests,
  setWorkbenchCamera,
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
  it('clears the canvas when the chat has no runtime session to load from', async () => {
    // Reported: switching chats in the sidebar leaves the previous chat's
    // diagram on screen, so a new chat opens showing someone else's canvas.
    //
    // Confirmed live: runtime session dd93eb95, selected chat 65e9d7, and the
    // canvas holding 65e9d7's 12-node map at revision 7. A stored chat that
    // has never been resumed has NO runtime session, so hydrating it must
    // still blank the canvas rather than leave the last drawing up.
    resetWorkbenchForTests()

    const request = vi.fn(async () => ({ artifacts: [] }))

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => null
    })

    $workbenchArtifact.set(artifact)

    await hydrate(null)

    expect($workbenchArtifact.get()).toBeNull()
  })

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

  it('resets camera ownership when two sessions both use map.main', async () => {
    resetWorkbenchForTests()
    let active = 'runtime-1'
    const request = vi.fn(async () => ({ artifacts: [artifact] }))

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => active
    })

    await hydrate('runtime-1')
    resetWorkbenchCameraFor('map.main')
    setWorkbenchCamera({ x: 40, y: 20, zoom: 2 })

    active = 'runtime-2'
    await hydrate('runtime-2')
    resetWorkbenchCameraFor('map.main')

    expect($workbenchCamera.get()).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('preserves camera on a same-session hydration retry', async () => {
    resetWorkbenchForTests()
    const request = vi.fn(async () => ({ artifacts: [artifact] }))

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => 'runtime-1'
    })

    await hydrate('runtime-1')
    resetWorkbenchCameraFor('map.main')
    setWorkbenchCamera({ x: 40, y: 20, zoom: 2 })

    await hydrate('runtime-1')
    resetWorkbenchCameraFor('map.main')

    expect($workbenchCamera.get()).toEqual({ x: 40, y: 20, zoom: 2 })
  })
})
