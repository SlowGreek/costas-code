interface CameraCommandQueueDeps<T> {
  /** Return true once the current layout can resolve and apply the command. */
  apply: (command: T) => boolean
  /** Subscribe to authoritative layout publications. */
  listen: (callback: () => void) => () => void
  /** Semantic-turn cancellation (barge-in, close, or replacement turn). */
  signal?: AbortSignal
  /** Failure bound only; healthy commands resolve from layout events. */
  timeoutMs?: number
}

/**
 * Apply a camera command now, or on the first layout publication that makes its
 * target resolvable. This closes the add_node -> camera race without pacing the
 * healthy path with an arbitrary sleep.
 */
export function applyCameraCommandWhenReady<T>(
  deps: CameraCommandQueueDeps<T>,
  command: T
): Promise<boolean> {
  if (deps.signal?.aborted) {
    return Promise.resolve(false)
  }

  if (deps.apply(command)) {
    return Promise.resolve(true)
  }

  return new Promise(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    let onAbort: (() => void) | undefined

    const finish = (applied: boolean) => {
      if (done) {
        return
      }

      done = true

      if (timer !== undefined) {
        clearTimeout(timer)
      }

      stop?.()

      if (onAbort) {
        deps.signal?.removeEventListener('abort', onAbort)
      }

      resolve(applied)
    }

    stop = deps.listen(() => {
      if (deps.apply(command)) {
        finish(true)
      }
    })

    onAbort = () => finish(false)
    deps.signal?.addEventListener('abort', onAbort, { once: true })

    if (deps.signal?.aborted) {
      finish(false)

      return
    }

    // Some stores publish synchronously from listen(). In that case finish()
    // ran before the disposer was assigned, so dispose it now and stop.
    if (done) {
      stop()
      deps.signal?.removeEventListener('abort', onAbort)

      return
    }

    // Close the lookup -> subscribe race: the target may have arrived between
    // the first failed apply and the listener becoming active.
    if (deps.apply(command)) {
      finish(true)

      return
    }

    timer = setTimeout(() => finish(false), deps.timeoutMs ?? 1_500)
  })
}
