import { readFileSync } from 'node:fs'

import { catalyst_shell_viewport_document, initSync } from '../public/wasm/catalyst_wasm.js'

// The web target resolves its own bytes with fetch, which Node has no file
// scheme for, so the main process loads them itself.
const CANDIDATES = [
  '../public/wasm/catalyst_wasm_bg.wasm',
  './public/wasm/catalyst_wasm_bg.wasm',
  '../../public/wasm/catalyst_wasm_bg.wasm'
]

let started = false

function engineBytes(): Buffer {
  const attempted: string[] = []

  for (const candidate of CANDIDATES) {
    const location = new URL(candidate, import.meta.url)

    try {
      return readFileSync(location)
    } catch {
      attempted.push(location.pathname)
    }
  }

  throw new Error(`catalyst-engine-unavailable:${attempted.join(',')}`)
}

function start(): void {
  if (started) {return}

  initSync({ module: engineBytes() })
  started = true
}

function admit(encoded: string): Record<string, unknown> {
  const value = JSON.parse(encoded) as Record<string, unknown>

  if (typeof value.error === 'string') {
    throw new Error(`${value.error}:${String(value.detail ?? '')}`)
  }

  return value
}

/** Compose the SHELL Document from host-observed facts; the engine owns shape. */
export function composeShellViewportDocument(model: unknown): Record<string, unknown> {
  start()

  return admit(catalyst_shell_viewport_document(JSON.stringify(model)))
}

export function resetCatalystEngineForTests(): void {
  started = false
}
