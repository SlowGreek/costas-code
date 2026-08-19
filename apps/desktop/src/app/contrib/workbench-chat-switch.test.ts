import { describe, expect, it, vi } from 'vitest'

import {
  $workbenchArtifact,
  resetWorkbenchForTests,
  type WorkbenchArtifact
} from '@/store/workbench'

import { createWorkbenchHydrator } from './workbench-hydrate'

/**
 * Switching chats: what the canvas must do, in the order it really happens.
 *
 * Reported twice — "the workbench sticks when switching chats" — and my first
 * fix made it worse. Picking a chat in the sidebar resumes it, and resume is
 * ASYNCHRONOUS:
 *
 *   1. stored id changes        (the click)
 *   2. ...resume in flight...
 *   3. runtime id changes       (resume resolved)
 *
 * The fix that failed hydrated at step 1, using the runtime id of the chat the
 * user just LEFT — so it re-fetched and re-displayed the previous drawing,
 * making the stickiness more reliable rather than less.
 *
 * The rule these tests pin: step 1 clears, step 3 loads.
 */
const artifactFor = (rev: number) =>
  ({
    artifact_id: 'map.main',
    kind: 'map',
    payload: { edges: [], nodes: [{ id: 'a', label: 'A' }] },
    semantic_rev: rev,
    view_rev: 1,
    view_state: {}
  }) as unknown as WorkbenchArtifact

describe('switching chats', () => {
  it('does not repaint the old chat while its resume is still in flight', async () => {
    // The exact failure. At the moment of the click the runtime id STILL
    // points at the previous chat, so any fetch keyed on it returns the
    // drawing the user is trying to leave.
    resetWorkbenchForTests()

    let runtimeSessionId: null | string = 'runtime-old'
    const request = vi.fn(async () => ({ artifacts: [artifactFor(7)] }))

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => runtimeSessionId
    })

    // Step 3 for the OLD chat: it is on screen legitimately.
    await hydrate(runtimeSessionId)
    expect($workbenchArtifact.get()?.semantic_rev).toBe(7)

    // Step 1: the user clicks a different chat. Resume has not resolved, so
    // the runtime id is unchanged.
    const clearedOnSwitch = request.mock.calls.length

    resetWorkbenchForTests()

    expect($workbenchArtifact.get()).toBeNull()
    // Nothing may be fetched at this point — there is no session to fetch FOR.
    expect(request.mock.calls.length).toBe(clearedOnSwitch)

    // Step 3: resume lands with a new runtime id, and the new chat's drawing
    // arrives.
    runtimeSessionId = 'runtime-new'
    request.mockResolvedValueOnce({ artifacts: [artifactFor(2)] })
    await hydrate(runtimeSessionId)

    expect($workbenchArtifact.get()?.semantic_rev).toBe(2)
  })

  it('blanks the canvas when the newly selected chat has no drawing', async () => {
    // Otherwise the previous chat's diagram stays up under a different title,
    // which is the report exactly.
    resetWorkbenchForTests()

    let current = 'runtime-old'

    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.session_id === 'runtime-old' ? { artifacts: [artifactFor(7)] } : { artifacts: [] }
    )

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => current
    })

    await hydrate('runtime-old')
    expect($workbenchArtifact.get()?.semantic_rev).toBe(7)

    current = 'runtime-new'
    await hydrate('runtime-new')

    expect($workbenchArtifact.get()).toBeNull()
  })

  it('ignores a slow reply for a chat the user has already left', async () => {
    // Two switches in quick succession: the first fetch must not win.
    resetWorkbenchForTests()

    let current = 'runtime-b'

    const request = vi.fn(
      async (_method: string, params: Record<string, unknown>) =>
        params.session_id === 'runtime-a'
          ? new Promise(resolve => setTimeout(() => resolve({ artifacts: [artifactFor(7)] }), 30))
          : { artifacts: [artifactFor(2)] }
    )

    const hydrate = createWorkbenchHydrator({
      getGateway: () => ({ request }) as never,
      getSessionId: () => current
    })

    const slow = hydrate('runtime-a')
    const fast = hydrate('runtime-b')

    await Promise.all([slow, fast])

    expect($workbenchArtifact.get()?.semantic_rev).toBe(2)
  })
})
