import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { usePromptActions } from '@/app/session/hooks/use-prompt-actions'
import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $paneStates, ensurePaneRegistered, getPaneStateSnapshot, setPaneOpen, setPaneWidthOverride } from '@/store/panes'
import {
  $activeSessionId,
  $busy,
  $selectedStoredSessionId,
  $unreadFinishedSessionIds
} from '@/store/session'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'

const CAPTURE_PATH = resolve(__dirname, '../../../../../tests/fixtures/catalyst_oracle/captured/ui.json')

interface MechanicalCapture {
  cases: Record<string, unknown>
  generation: {
    clock: string
    mechanism: string
    screenshots: boolean
  }
  schema: string
}

function expectedCapture(): MechanicalCapture {
  return JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')) as MechanicalCapture
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}

function paneSnapshot(id: string) {
  const state = getPaneStateSnapshot(id)

  return state ? { open: state.open, widthOverride: state.widthOverride } : null
}

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  clearAllSessionStates()
  $paneStates.set({})
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $unreadFinishedSessionIds.set([])
  $busy.set(false)
})

afterEach(() => {
  cleanup()
  clearAllSessionStates()
  $paneStates.set({})
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $unreadFinishedSessionIds.set([])
  $busy.set(false)
  document.body.replaceChildren()
})

describe('Costas F0c MC4 mechanical UI capture', () => {
  it('captures a background terminal transition as passive badge-only state', () => {
    const fixture = expectedCapture()
    const foregroundInput = document.createElement('input')
    foregroundInput.id = 'foreground-composer'
    document.body.appendChild(foregroundInput)

    $activeSessionId.set('runtime-foreground')
    $selectedStoredSessionId.set('session-foreground')
    ensurePaneRegistered('task-pane', { open: true })
    setPaneWidthOverride('task-pane', 420)
    foregroundInput.focus()

    const before = {
      activeElement: document.activeElement?.id ?? null,
      activeRuntimeSessionId: $activeSessionId.get(),
      pane: paneSnapshot('task-pane'),
      selectedStoredSessionId: $selectedStoredSessionId.get(),
      unreadFinishedSessionIds: $unreadFinishedSessionIds.get()
    }

    const working = { ...createClientSessionState('session-background'), busy: true }
    publishSessionState('runtime-background', working)
    publishSessionState('runtime-background', { ...working, busy: false })

    const after = {
      activeElement: document.activeElement?.id ?? null,
      activeRuntimeSessionId: $activeSessionId.get(),
      pane: paneSnapshot('task-pane'),
      selectedStoredSessionId: $selectedStoredSessionId.get(),
      unreadFinishedSessionIds: $unreadFinishedSessionIds.get()
    }

    const observed = {
      availability: 'wired',
      finalState: 'background-passive',
      logicalSequence: [
        { command: 'select-foreground-and-focus-composer', seq: 0 },
        { command: 'publish-background-working', seq: 1 },
        { command: 'publish-background-idle', seq: 2 }
      ],
      observations: {
        after,
        badgeUpdated: before.unreadFinishedSessionIds.length === 0 && after.unreadFinishedSessionIds.length === 1,
        before,
        foregroundFocusUnchanged: before.activeElement === after.activeElement,
        foregroundRouteUnchanged:
          before.activeRuntimeSessionId === after.activeRuntimeSessionId &&
          before.selectedStoredSessionId === after.selectedStoredSessionId,
        paneContextUnchanged: JSON.stringify(before.pane) === JSON.stringify(after.pane)
      },
      sourceAnchors: ['apps/desktop/src/store/session-states.ts:129-192', 'apps/desktop/src/store/panes.ts:110-145'],
      unavailable: []
    }

    expect(observed).toEqual(fixture.cases['ui-background-invariants'])
  })

  it('captures cancel presentation before interrupt resolution and preserves pane context', async () => {
    const fixture = expectedCapture()
    const interrupt = deferred<void>()
    let interruptSettled = false
    const commands: Array<{ method: string; seq: number }> = []
    let seq = 0

    const stateRef: { current: ClientSessionState } = {
      current: {
        ...createClientSessionState('session-cancel'),
        awaitingResponse: true,
        busy: true,
        interrupted: false,
        needsInput: true,
        pendingBranchGroup: 'branch-cancel',
        streamId: 'assistant-stream',
        turnStartedAt: 1
      } satisfies ClientSessionState
    }

    const activeSessionIdRef = { current: 'runtime-cancel' as string | null }
    const selectedStoredSessionIdRef = { current: 'session-cancel' as string | null }
    const busyRef = { current: true }

    ensurePaneRegistered('task-pane', { open: true })
    setPaneWidthOverride('task-pane', 420)
    $activeSessionId.set('runtime-cancel')
    $selectedStoredSessionId.set('session-cancel')
    $busy.set(true)

    const requestGateway = <T>(method: string): Promise<T> => {
      commands.push({ method, seq: (seq += 1) })

      return interrupt.promise.then(() => {
        interruptSettled = true

        return {} as T
      })
    }

    const { result } = renderHook(() =>
      usePromptActions({
        activeSessionId: 'runtime-cancel',
        activeSessionIdRef,
        branchCurrentSession: async () => true,
        busyRef,
        createBackendSessionForSend: async () => 'runtime-cancel',
        getRoutedStoredSessionId: () => 'session-cancel',
        getRuntimeIdForStoredSession: () => 'runtime-cancel',
        getRouteToken: () => 'route-token',
        handleSkinCommand: () => '',
        openMemoryGraph: () => undefined,
        prepareSessionForPrompt: async () => true,
        refreshSessions: async () => undefined,
        requestGateway,
        resumeStoredSession: () => undefined,
        selectedStoredSessionIdRef,
        startFreshSessionDraft: () => undefined,
        sttEnabled: false,
        updateSessionState: (_sessionId, updater) => {
          stateRef.current = updater(stateRef.current)

          return stateRef.current
        }
      })
    )

    const beforePane = paneSnapshot('task-pane')
    let cancelPromise!: Promise<void>

    act(() => {
      cancelPromise = result.current.cancelRun()
    })

    const presentationSeq = (seq += 1)

    const immediate = {
      awaitingResponse: stateRef.current.awaitingResponse,
      busy: stateRef.current.busy,
      interrupted: stateRef.current.interrupted,
      interruptRequestPending: !interruptSettled,
      needsInput: stateRef.current.needsInput,
      pane: paneSnapshot('task-pane'),
      pendingBranchGroup: stateRef.current.pendingBranchGroup,
      streamId: stateRef.current.streamId,
      turnStartedAt: stateRef.current.turnStartedAt
    }

    await act(async () => {
      interrupt.resolve()
      await cancelPromise
    })

    const interruptResolutionSeq = (seq += 1)

    setPaneOpen('task-pane', false)
    const hiddenPane = paneSnapshot('task-pane')
    setPaneOpen('task-pane', true)
    const restoredPane = paneSnapshot('task-pane')

    const observed = {
      availability: 'wired',
      finalState: 'cancel-visible',
      logicalSequence: [
        { command: 'invoke-cancel', seq: 0 },
        { command: 'dispatch-session-interrupt', seq: commands[0]?.seq ?? null },
        { command: 'observe-cancel-presentation', seq: presentationSeq },
        { command: 'resolve-session-interrupt-request', seq: interruptResolutionSeq },
        { command: 'hide-and-restore-task-pane', seq: interruptResolutionSeq + 1 }
      ],
      observations: {
        beforePane,
        hiddenPane,
        immediate,
        interruptMethod: commands[0]?.method ?? null,
        presentationPrecededInterruptResolution: presentationSeq < interruptResolutionSeq,
        restoredPane
      },
      sourceAnchors: [
        'apps/desktop/src/app/session/hooks/use-prompt-actions/index.ts:552-639',
        'apps/desktop/src/store/panes.ts:120-145'
      ],
      unavailable: [
        {
          reason: 'session.interrupt request resolution is not backend cleanup terminal proof',
          semantic: 'asynchronous-cleanup-terminal'
        }
      ]
    }

    expect(observed).toEqual(fixture.cases['ui-cancel-pane-invariants'])
  })

  it('records the deterministic, non-visual capture mechanism', () => {
    expect(expectedCapture()).toMatchObject({
      generation: {
        clock: 'logical-sequence-only',
        mechanism: 'existing-desktop-stores-and-command-reducers',
        screenshots: false
      },
      schema: 'costas-catalyst-ui-mechanical-capture/1'
    })
  })
})
