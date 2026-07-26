import { describe, expect, it, vi } from 'vitest'

import { KEYBIND_ACTION_EVENT, requestKeybindAction } from './actions'

describe('modality-neutral keybind action seam', () => {
  it('dispatches registered ids without carrying a callback or arbitrary command', () => {
    const listener = vi.fn()
    window.addEventListener(KEYBIND_ACTION_EVENT, listener)

    expect(requestKeybindAction('view.showTerminal')).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent<string>).detail).toBe('view.showTerminal')
    window.removeEventListener(KEYBIND_ACTION_EVENT, listener)
  })

  it('refuses unknown action ids', () => {
    const listener = vi.fn()
    window.addEventListener(KEYBIND_ACTION_EVENT, listener)

    expect(requestKeybindAction('terminal.exec')).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(KEYBIND_ACTION_EVENT, listener)
  })
})
