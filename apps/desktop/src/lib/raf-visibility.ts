/**
 * raf-visibility.ts
 *
 * Park a requestAnimationFrame loop while the document is hidden.
 *
 * Chromium throttles rAF in a *backgrounded* window, but the Catalyst window is
 * usually still visible-but-unfocused, or occluded behind another app — cases
 * where the loop keeps running at full 60Hz. Several pet/starmap animations
 * re-arm unconditionally, so the GPU process stayed busy (~34%) with nothing on
 * screen changing. That is the same bug class as the CoreAudio wake lock: an
 * animation loop that never learns when to stop.
 *
 * Callers keep owning their own frame scheduling; this only answers "should the
 * loop be running right now" and notifies on change, so an unmount path and a
 * visibility pause cannot disagree about who cancelled what.
 */

/** True when the page is currently being displayed. */
export function documentIsVisible(doc: Pick<Document, 'hidden'> | undefined = globalThis.document): boolean {
  // No document (tests, SSR) means nothing to throttle for — treat as visible
  // so a loop under test behaves normally rather than silently never running.
  return !doc || !doc.hidden
}

export interface VisibilityLoopHandle {
  /** Detach the listener. Safe to call more than once. */
  stop: () => void
}

/**
 * Run `onChange(visible)` whenever document visibility flips.
 *
 * Returns a handle rather than a bare cleanup function so the call site reads
 * as a lifecycle object next to the rAF it controls.
 */
export function onVisibilityChange(
  onChange: (visible: boolean) => void,
  doc: Document | undefined = globalThis.document
): VisibilityLoopHandle {
  if (!doc) {
    return { stop: () => undefined }
  }

  const handler = () => onChange(!doc.hidden)
  doc.addEventListener('visibilitychange', handler)

  return {
    stop: () => doc.removeEventListener('visibilitychange', handler)
  }
}

export interface PausableRafOptions {
  /** The frame callback. Receives the timestamp rAF supplies. */
  tick: (now: number) => void
  /** Injected for tests; defaults to the real scheduler. */
  raf?: (cb: FrameRequestCallback) => number
  cancel?: (handle: number) => void
  doc?: Document | undefined
}

/**
 * A self-parking rAF loop: runs while the document is visible, stops while it
 * is hidden, resumes on return.
 *
 * The single `frame` identity guards against double-arming — a resume that
 * fired while a frame was already pending would otherwise leave two loops
 * running at once, doubling the very cost this exists to remove.
 */
export function startPausableRaf({
  tick,
  raf = globalThis.requestAnimationFrame?.bind(globalThis),
  cancel = globalThis.cancelAnimationFrame?.bind(globalThis),
  doc = globalThis.document
}: PausableRafOptions): VisibilityLoopHandle {
  if (!raf || !cancel) {
    return { stop: () => undefined }
  }

  let handle = 0
  let stopped = false

  const frame = (now: number) => {
    handle = 0

    if (stopped) {
      return
    }

    tick(now)

    if (!stopped) {
      handle = raf(frame)
    }
  }

  const arm = () => {
    if (stopped || handle !== 0) {
      return
    }

    handle = raf(frame)
  }

  const disarm = () => {
    if (handle !== 0) {
      cancel(handle)
      handle = 0
    }
  }

  const visibility = onVisibilityChange(visible => (visible ? arm() : disarm()), doc)

  if (documentIsVisible(doc)) {
    arm()
  }

  return {
    stop: () => {
      stopped = true
      disarm()
      visibility.stop()
    }
  }
}
