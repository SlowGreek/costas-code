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
