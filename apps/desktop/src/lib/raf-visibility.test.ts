import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { documentIsVisible, onVisibilityChange, startPausableRaf } from './raf-visibility'

/** Minimal fake document with a controllable `hidden` flag. */
interface FakeDoc {
  hidden: boolean
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
  setHidden: (next: boolean) => void
  readonly listenerCount: number
}

function fakeDoc(): FakeDoc {
  const listeners = new Set<() => void>()

  return {
    hidden: false,
    addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
    /** Flip visibility and notify, the way the browser does. */
    setHidden(next: boolean) {
      this.hidden = next

      for (const fn of [...listeners]) {fn()}
    },
    get listenerCount() {
      return listeners.size
    }
  }
}

/** The helpers only read `hidden` and the listener pair. */
const asDoc = (d: FakeDoc) => d as unknown as Document

/** Manual frame scheduler so tests drive time instead of waiting on it. */
function fakeRaf() {
  const pending = new Map<number, FrameRequestCallback>()
  let next = 1

  return {
    raf: (cb: FrameRequestCallback) => {
      pending.set(next, cb)

      return next++
    },
    cancel: (handle: number) => void pending.delete(handle),
    /** Run every currently-pending callback once. */
    flush(now = 0) {
      const due = [...pending.entries()]
      pending.clear()

      for (const [, cb] of due) {cb(now)}
    },
    get pendingCount() {
      return pending.size
    }
  }
}

describe('documentIsVisible', () => {
  test('a hidden document is not visible', () => {
    assert.equal(documentIsVisible({ hidden: true }), false)
    assert.equal(documentIsVisible({ hidden: false }), true)
  })

  test('no document counts as visible', () => {
    // Under test/SSR there is nothing to throttle for; a loop should behave
    // normally rather than silently never run.
    assert.equal(documentIsVisible(undefined), true)
  })
})

describe('startPausableRaf', () => {
  test('runs while visible', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()
    let ticks = 0

    startPausableRaf({ tick: () => ticks++, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })

    sched.flush()
    sched.flush()
    assert.equal(ticks, 2)
  })

  test('stops re-arming once hidden', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()
    let ticks = 0

    startPausableRaf({ tick: () => ticks++, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    sched.flush()
    assert.equal(ticks, 1)

    doc.setHidden(true)
    // The pending frame is cancelled, so nothing is left to run.
    assert.equal(sched.pendingCount, 0)

    sched.flush()
    assert.equal(ticks, 1, 'no frames should run while hidden')
  })

  test('resumes when the document comes back', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()
    let ticks = 0

    startPausableRaf({ tick: () => ticks++, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    doc.setHidden(true)
    sched.flush()
    assert.equal(ticks, 0)

    doc.setHidden(false)
    sched.flush()
    assert.equal(ticks, 1)
  })

  test('does not start while already hidden', () => {
    const doc = fakeDoc()
    doc.hidden = true
    const sched = fakeRaf()

    startPausableRaf({ tick: () => undefined, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    assert.equal(sched.pendingCount, 0)
  })

  test('a repeated resume cannot double-arm the loop', () => {
    // Two concurrent loops would double the cost this exists to remove.
    const doc = fakeDoc()
    const sched = fakeRaf()
    let ticks = 0

    startPausableRaf({ tick: () => ticks++, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    doc.setHidden(false)
    doc.setHidden(false)

    assert.equal(sched.pendingCount, 1)
    sched.flush()
    assert.equal(ticks, 1)
  })

  test('stop() halts the loop and detaches the listener', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()
    let ticks = 0

    const loop = startPausableRaf({ tick: () => ticks++, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    loop.stop()

    sched.flush()
    assert.equal(ticks, 0)
    assert.equal(doc.listenerCount, 0, 'listener must not outlive the loop')
  })

  test('stop() is idempotent', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()

    const loop = startPausableRaf({ tick: () => undefined, raf: sched.raf, cancel: sched.cancel, doc: asDoc(doc) })
    loop.stop()
    loop.stop()
    assert.equal(doc.listenerCount, 0)
  })

  test('a tick that stops the loop does not schedule another frame', () => {
    const doc = fakeDoc()
    const sched = fakeRaf()
    let loop: { stop: () => void }

    loop = startPausableRaf({
      tick: () => loop.stop(),
      raf: sched.raf,
      cancel: sched.cancel,
      doc: asDoc(doc)
    })

    sched.flush()
    assert.equal(sched.pendingCount, 0)
  })
})

describe('onVisibilityChange', () => {
  test('reports the new visibility', () => {
    const doc = fakeDoc()
    const seen: boolean[] = []

    onVisibilityChange(v => seen.push(v), asDoc(doc))
    doc.setHidden(true)
    doc.setHidden(false)

    assert.deepEqual(seen, [false, true])
  })

  test('stop() removes the listener', () => {
    const doc = fakeDoc()
    const handle = onVisibilityChange(() => undefined, asDoc(doc))

    assert.equal(doc.listenerCount, 1)
    handle.stop()
    assert.equal(doc.listenerCount, 0)
  })

  test('no document is a no-op rather than a crash', () => {
    const handle = onVisibilityChange(() => undefined, undefined)
    handle.stop()
  })
})
