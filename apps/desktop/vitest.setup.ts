import { configure } from '@testing-library/react'

function memoryStorage(): Storage {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(String(key)),
    setItem: (key, value) => values.set(String(key), String(value))
  }
}

// Node exposes an experimental global localStorage getter that resolves to
// undefined unless --localstorage-file is supplied. That can shadow jsdom's
// origin-scoped Storage in Vitest workers. Keep UI tests hermetic and browser-
// shaped without writing a shared storage file across parallel workers.
if (!globalThis.localStorage) {
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}

// React 19 + Testing Library 16: opt into the act environment so render(),
// fireEvent(), and findBy* queries automatically flush state updates without
// spurious "not wrapped in act(...)" warnings.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// findBy*/waitFor default to a 1000ms deadline — too tight for async-heavy
// panels (radix menus, refetch chains) when the full suite runs under xdist
// CPU contention in CI. Success still resolves the instant the node appears;
// the wider deadline only absorbs a starved runner, killing timing flakes.
configure({ asyncUtilTimeout: 5000 })

// jsdom ships no 2D context, so any Document carrying a canvas item (waveform,
// sparkline) aborts the engine's paint mid-region. `dyn_into` is an `instanceof`
// check, so the shim needs the constructor jsdom omits — not just a stub object.
const CANVAS_2D_STATE: Record<string, unknown> = {
  canvas: null,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  globalAlpha: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true
}

// Any method the painter reaches for answers; only the few with a return value
// worth having are named, so a new drawing call never fails the suite.
const CANVAS_2D_RESULTS: Record<string, () => unknown> = {
  measureText: () => ({ width: 0 }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null,
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  isPointInPath: () => false,
  isPointInStroke: () => false
}

class StubCanvasRenderingContext2D {
  constructor(canvas: HTMLCanvasElement) {
    Object.assign(this, CANVAS_2D_STATE, { canvas })

    return new Proxy(this, {
      get: (target, key: string) =>
        key in target
          ? Reflect.get(target, key)
          : (CANVAS_2D_RESULTS[key] ?? (() => undefined)),
      set: (target, key, value) => Reflect.set(target, key, value)
    })
  }
}

Object.defineProperty(globalThis, 'CanvasRenderingContext2D', {
  configurable: true,
  value: StubCanvasRenderingContext2D
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value(this: HTMLCanvasElement, kind: string) {
    return kind === '2d' ? new StubCanvasRenderingContext2D(this) : null
  }
})
