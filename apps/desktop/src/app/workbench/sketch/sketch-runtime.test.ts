import { describe, expect, it } from 'vitest'

import { buildSketchDocument, MAX_SKETCH_HTML_BYTES } from './sketch-document'
import {
  SKETCH_RUNTIME_BYTES,
  SKETCH_RUNTIME_JS,
  SKETCH_RUNTIME_SCRIPT,
  SKETCH_RUNTIME_VERSION
} from './sketch-runtime'

/**
 * Runs the runtime source against a fake window/document and returns the API
 * it installed. This is the real source string that ships inside srcdoc — not
 * a re-implementation — so these assertions are about shipped behaviour.
 */
function installRuntime(): Record<string, unknown> {
  const listeners: string[] = []

  const fakeWindow: Record<string, unknown> = {
    devicePixelRatio: 2,
    innerWidth: 800,
    innerHeight: 600,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    addEventListener: (type: string) => {
      listeners.push(type)
    }
  }

  const fakeDocument = {
    body: { appendChild: () => undefined },
    getElementById: () => null,
    createElement: () => ({ style: {}, getContext: () => null, addEventListener: () => undefined })
  }

   
  const run = new Function('window', 'document', `${SKETCH_RUNTIME_JS}\nreturn window.Sketch`)

  return run(fakeWindow, fakeDocument) as Record<string, unknown>
}

describe('sketch runtime (offline 3D/animation capability)', () => {
  it('installs window.Sketch with the documented surface', () => {
    const api = installRuntime()

    for (const name of [
      'canvas',
      'canvas2d',
      'loop',
      'gl',
      'program',
      'shader',
      'buffer',
      'scene3d',
      'box',
      'sphere',
      'plane',
      'hasWebGL',
      'lerp',
      'clamp'
    ]) {
      expect(typeof api[name], `Sketch.${name}`).toBe('function')
    }

    expect(typeof api.mat4).toBe('object')
    expect(typeof api.vec3).toBe('object')
    expect(api.version).toBe(SKETCH_RUNTIME_VERSION)
    expect(api.offline).toBe(true)
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('produces real geometry with consistent buffers', () => {
    const api = installRuntime()
    const box = (api.box as () => { positions: Float32Array; normals: Float32Array; indices: ArrayLike<number> })()

    expect(box.positions.length).toBe(24 * 3)
    expect(box.normals.length).toBe(box.positions.length)
    expect(box.indices.length).toBe(36)

    const sphere = (api.sphere as (r: number, s: number) => { positions: Float32Array; indices: ArrayLike<number> })(1, 8)
    expect(sphere.positions.length).toBeGreaterThan(0)
    expect(sphere.indices.length % 3).toBe(0)

    // Every generated vertex is on the unit sphere.
    for (let i = 0; i < sphere.positions.length; i += 3) {
      const r = Math.hypot(sphere.positions[i], sphere.positions[i + 1], sphere.positions[i + 2])
      expect(r).toBeCloseTo(1, 5)
    }
  })

  it('does real 4x4 matrix maths', () => {
    const api = installRuntime()

    const mat4 = api.mat4 as {
      identity: () => Float32Array
      multiply: (a: Float32Array, b: Float32Array) => Float32Array
      perspective: (f: number, a: number, n: number, ff: number) => Float32Array
      rotationY: (a: number) => Float32Array
    }

    const id = mat4.identity()
    const rot = mat4.rotationY(0.7)
    // M * I === M
    expect(Array.from(mat4.multiply(rot, id))).toEqual(Array.from(rot))
    // perspective has the WebGL -1 in the w row
    expect(mat4.perspective(1, 1.5, 0.1, 100)[11]).toBe(-1)
  })

  it('performs no network access of any kind', () => {
    // The whole point: the runtime must not need — or be able to gain — any of
    // the primitives connect-src 'none' exists to block.
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'importScripts',
      'navigator.sendBeacon',
      'new Worker',
      'import(',
      'RTCPeerConnection'
    ]) {
      expect(SKETCH_RUNTIME_JS, forbidden).not.toContain(forbidden)
    }

    // No remote URLs to fetch from, and no eval of remote text.
    expect(SKETCH_RUNTIME_JS).not.toMatch(/https?:\/\//)
    expect(SKETCH_RUNTIME_JS).not.toMatch(/\beval\s*\(/)
  })

  it('never reaches for the parent app realm', () => {
    for (const forbidden of ['parent.', 'opener', 'postMessage', 'localStorage', 'document.cookie']) {
      expect(SKETCH_RUNTIME_JS, forbidden).not.toContain(forbidden)
    }
  })
})

describe('runtime injection into the srcdoc', () => {
  it('inlines the runtime in head, after the CSP and before the model markup', () => {
    const { html } = buildSketchDocument('<div id="model">x</div>')

    expect(html).toContain(SKETCH_RUNTIME_SCRIPT)
    const marker = 'W.Sketch = api'
    expect(html).toContain(marker)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf(marker))
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf('<body>'))
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf('id="model"'))
  })

  it('does not charge the runtime against the model byte budget', () => {
    // A model payload right at the cap is NOT truncated even though the final
    // document is much larger: the runtime is the builder's cost, not the
    // model's.
    const atCap = `<p>${'a'.repeat(MAX_SKETCH_HTML_BYTES - 7)}</p>`
    expect(atCap.length).toBe(MAX_SKETCH_HTML_BYTES)

    const result = buildSketchDocument(atCap)
    expect(result.truncated).toBe(false)
    expect(result.html.length).toBeGreaterThan(MAX_SKETCH_HTML_BYTES + SKETCH_RUNTIME_BYTES - 1)
  })

  it('stays small enough to inline on every revision', () => {
    // Guard against someone "just vendoring three.js" into this string.
    expect(SKETCH_RUNTIME_BYTES).toBeLessThan(32 * 1024)
  })

  it('adds no host, scheme, or sandbox capability', () => {
    const { html } = buildSketchDocument('<p>x</p>')
    const head = html.slice(0, html.indexOf('<body>'))

    expect(head).not.toMatch(/<script[^>]+src=/i)
    expect(head).not.toMatch(/<link\b/i)
    expect(head).not.toMatch(/https?:\/\//)
  })
})

describe('meta refresh navigation', () => {
  it('strips meta refresh (navigates the frame without allow-top-navigation)', () => {
    const { html } = buildSketchDocument(
      '<meta http-equiv="refresh" content="0;url=https://evil.test/"><p>x</p>'
    )

    expect(html).not.toMatch(/http-equiv\s*=\s*"?refresh/i)
    expect(html).not.toContain('evil.test')
    expect(html).toContain('<p>x</p>')
  })

  it('strips it regardless of quoting and attribute order', () => {
    for (const raw of [
      "<meta content='0;url=https://evil.test' http-equiv='refresh'>",
      '<meta HTTP-EQUIV=REFRESH CONTENT="1;URL=https://evil.test">'
    ]) {
      expect(buildSketchDocument(raw).html).not.toContain('evil.test')
    }
  })
})
