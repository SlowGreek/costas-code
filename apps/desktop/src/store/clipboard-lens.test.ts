import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $clipboardLensError,
  $clipboardLensOpen,
  $clipboardLensSnapshot,
  closeClipboardLens,
  openClipboardLens
} from './clipboard-lens'

const ready = {
  schema: 'hermes-clipboard-lens/1' as const,
  authority: 'none' as const,
  history: 'off' as const,
  invocation: 'explicit-user-action' as const,
  retention: 'ephemeral' as const,
  revocable: true as const,
  state: 'ready' as const,
  media: 'text' as const,
  byte_length: 5,
  content_hash: `sha256:${'a'.repeat(64)}`,
  sensitivity: 'admitted' as const,
  text_preview: 'hello'
}

const install = (inspect: () => Promise<unknown>) => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { clipboardLens: { inspect } }
  })
}

describe('clipboard lens explicit lifecycle', () => {
  it('does not inspect merely because the store is imported', () => {
    const inspect = vi.fn(async () => ready)
    install(inspect)

    expect(inspect).not.toHaveBeenCalled()
    expect($clipboardLensOpen.get()).toBe(false)
  })

  it('performs one explicit inspection and revokes state on close', async () => {
    const inspect = vi.fn(async () => ready)
    install(inspect)

    await openClipboardLens()
    expect(inspect).toHaveBeenCalledOnce()
    expect($clipboardLensSnapshot.get()).toEqual(ready)

    closeClipboardLens()
    expect($clipboardLensOpen.get()).toBe(false)
    expect($clipboardLensSnapshot.get()).toBeNull()
    expect($clipboardLensError.get()).toBeNull()
  })

  it('does not let a stale inspection repopulate a closed lens', async () => {
    let settle: (value: unknown) => void = () => undefined
    const inspect = vi.fn(() => new Promise(resolve => (settle = resolve)))
    install(inspect)

    const pending = openClipboardLens()
    closeClipboardLens()
    settle(ready)
    await pending

    expect($clipboardLensOpen.get()).toBe(false)
    expect($clipboardLensSnapshot.get()).toBeNull()
  })
})

afterEach(() => {
  closeClipboardLens()
  vi.restoreAllMocks()
})
