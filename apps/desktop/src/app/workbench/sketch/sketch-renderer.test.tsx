import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkbenchArtifact } from '@/store/workbench'

import SketchRenderer from './sketch-renderer'

function sketch(html: string, overrides: Partial<WorkbenchArtifact> = {}): WorkbenchArtifact {
  return {
    artifact_id: 'sketch.main',
    kind: 'sketch',
    semantic_rev: 1,
    view_rev: 0,
    view_state: {},
    payload: { html } as never,
    ...overrides
  }
}

describe('SketchRenderer', () => {
  afterEach(cleanup)

  it('renders the sketch in an iframe with srcdoc, never in the app DOM', () => {
    render(<SketchRenderer artifact={sketch('<p id="pwned">hello</p>')} />)

    const frame = screen.getByTestId('workbench-sketch-frame') as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('srcdoc')).toContain('<p id="pwned">hello</p>')
    // The markup must NOT have been parsed into the host document.
    expect(document.getElementById('pwned')).toBeNull()
  })

  it('sandboxes with allow-scripts and NOT allow-same-origin', () => {
    render(<SketchRenderer artifact={sketch('<p>x</p>')} />)
    const frame = screen.getByTestId('workbench-sketch-frame')
    const sandbox = frame.getAttribute('sandbox') ?? ''

    expect(sandbox).toBe('allow-scripts')

    for (const forbidden of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-popups',
      'allow-modals',
      'allow-forms'
    ]) {
      expect(sandbox).not.toContain(forbidden)
    }
  })

  it('embeds the restrictive CSP in the srcdoc', () => {
    render(<SketchRenderer artifact={sketch('<p>x</p>')} />)
    const srcdoc = screen.getByTestId('workbench-sketch-frame').getAttribute('srcdoc') ?? ''

    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"')
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toContain("connect-src 'none'")
  })

  it('neutralises remote-loading markup before it reaches the frame', () => {
    render(
      <SketchRenderer
        artifact={sketch('<base href="https://evil.test/"><img src="https://evil.test/p.gif">')}
      />
    )
    const srcdoc = screen.getByTestId('workbench-sketch-frame').getAttribute('srcdoc') ?? ''

    expect(srcdoc).not.toMatch(/<base\b/i)
    // The <img> survives as markup but the CSP img-src forbids remote schemes.
    expect(srcdoc).toContain('img-src data:')
  })

  it('never sets src or allows navigation attributes', () => {
    render(<SketchRenderer artifact={sketch('<p>x</p>')} />)
    const frame = screen.getByTestId('workbench-sketch-frame')

    expect(frame.getAttribute('src')).toBeNull()
    expect(frame.getAttribute('allow')).toBeNull()
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('stops a runaway sketch by tearing down the document', () => {
    render(<SketchRenderer artifact={sketch('<script>while(true){}</script>')} />)
    expect(screen.getByTestId('workbench-sketch-frame').getAttribute('srcdoc')).toContain('while')

    fireEvent.click(screen.getByTestId('workbench-sketch-stop'))

    expect(screen.getByTestId('workbench-sketch-frame').getAttribute('srcdoc')).toBe('')
  })

  it('renders an empty state instead of a frame for a blank sketch', () => {
    render(<SketchRenderer artifact={sketch('   ')} />)

    expect(screen.getByTestId('workbench-sketch-empty')).toBeTruthy()
    expect(screen.queryByTestId('workbench-sketch-frame')).toBeNull()
  })

  it('surfaces truncation of an oversized sketch', () => {
    render(<SketchRenderer artifact={sketch('a'.repeat(128 * 1024 + 10))} />)

    expect(screen.getByTestId('workbench-sketch-truncated')).toBeTruthy()
  })

  it('tolerates a payload that is not a sketch payload', () => {
    const artifact = sketch('') 
    artifact.payload = { nodes: [], edges: [] } as never
    render(<SketchRenderer artifact={artifact} />)

    expect(screen.getByTestId('workbench-sketch-empty')).toBeTruthy()
  })
})
