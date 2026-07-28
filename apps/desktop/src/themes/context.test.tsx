import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetBackendSkinSync, ingestBackendSkin } from './backend-sync'
import { ThemeProvider } from './context'

// The live-authoring loop: Hermes writes/edits one skin file and every surface
// repaints. An in-place edit keeps the NAME — only the palette moves.
const bloomberg = (foreground: string) => ({
  name: 'bloomberg',
  colors: { background: '#000000', ui_text: foreground, ui_accent: '#ff8000' }
})

const cssVar = (name: string) => window.document.documentElement.style.getPropertyValue(name)

describe('ThemeProvider ← backend skin sync', () => {
  beforeEach(() => {
    window.localStorage.clear()
    __resetBackendSkinSync()
  })

  afterEach(cleanup)

  it('applies an activated backend skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
    expect(cssVar('--theme-background-seed')).toBe('#000000')
  })

  it('repaints an in-place edit of the ACTIVE skin (same name, new palette)', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')

    // Recolor the same skin file. The same-name apply guard correctly no-ops
    // (protects manual desktop picks), so the repaint must come from the
    // registry update reaching the active theme derivation.
    act(() => ingestBackendSkin(bloomberg('#ff2d95'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff2d95')
  })

  it('does not repaint an edit to an INACTIVE skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    // A different skin registered without apply (e.g. seeded on reconnect)
    // must not touch the painted theme.
    act(() =>
      ingestBackendSkin({ name: 'forest', colors: { background: '#001100', ui_text: '#66ff66' } }, { apply: false })
    )
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
  })

  // Regression: the desktop remembers a backend skin by NAME, but backend skins
  // only reach `$backendThemes` once the gateway connects — long after boot. The
  // provider used to validate the stored name at mount, when nothing could
  // resolve it yet, fall back to the default, and (via setTheme) persist that
  // default over the user's pick. Net effect: any `$HERMES_HOME/skins/*.yaml`
  // skin reverted to the default on every quit/relaunch.
  it('keeps a backend skin selected across a relaunch, painting it once it registers', () => {
    // Session 1: skin registered and picked, so the name lands in storage.
    const first = render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
    first.unmount()

    // Session 2: fresh process. localStorage persists; the backend registry
    // does not, and the gateway has not connected yet.
    __resetBackendSkinSync()

    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    // gateway.ready seeds the skin without applying. The stored pick must still
    // be remembered, so this seed alone repaints it.
    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: false }))

    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
    expect(cssVar('--theme-background-seed')).toBe('#000000')
  })
})
