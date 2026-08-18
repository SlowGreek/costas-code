import {
  $workbenchArtifact,
  $workbenchLayout,
  $workbenchSelection,
  type WorkbenchArtifact
} from '@/store/workbench'

import { buildWorkbenchContext } from './workbench-spatial'

/**
 * THE single owner of workbench-context freshness (contract invariant §8).
 *
 * Anything the voice model knows about the canvas is a snapshot. Now that the
 * snapshot carries spatial and selection detail the model will confidently act
 * on, a stale snapshot is strictly worse than no snapshot — so every source of
 * truth that can change the picture re-pushes through here and nowhere else.
 *
 * Sources: artifact (structure), layout (where things ended up), selection
 * (what the user is pointing at), and the pin/hide overlay owned by Track B.
 */

/** Coalescing window for layout churn (a drag emits a position per frame). */
export const WORKBENCH_CONTEXT_DEBOUNCE_MS = 220

export interface WorkbenchContextOverlay {
  hidden?: string[]
  pinned?: string[]
}

export interface WorkbenchContextSyncOptions {
  /** Pin/hide state, read lazily so Track B can own the atoms. */
  overlay?: () => WorkbenchContextOverlay
  push: (summary: string) => void
  /** Injected for tests. */
  scheduler?: {
    clearTimeout: (handle: number) => void
    setTimeout: (fn: () => void, ms: number) => number
  }
}

const NON_MAP_KINDS = new Set(['quadrant', 'sketch', 'timeline'])

/**
 * Non-map kinds have no node graph, so they keep the old shape. Reading
 * `payload.nodes` on a timeline would throw inside connection setup and cost
 * the model ALL knowledge of the canvas.
 */
export function summarizeWorkbench(
  artifact: WorkbenchArtifact,
  context: {
    layout?: null | { height: number; positions: Record<string, { x: number; y: number }>; width: number }
    overlay?: WorkbenchContextOverlay
    selection?: null | string
  } = {}
): string {
  const payload = artifact.payload as {
    axes?: unknown
    edges?: { from: string; label?: string; to: string }[]
    items?: { id: string; label?: string }[]
    nodes?: { id: string; kind?: string; label?: string }[]
  }

  const head = { kind: artifact.kind, revision: artifact.semantic_rev }

  if (NON_MAP_KINDS.has(artifact.kind)) {
    switch (artifact.kind) {
      case 'quadrant':
        return JSON.stringify({ ...head, axes: payload.axes, items: payload.items ?? [] })

      case 'sketch':
        // Never ship the raw HTML: large, and the model does not need markup
        // to talk about what it drew.
        return JSON.stringify({ ...head, note: 'a rendered visual sketch is on screen' })

      default:
        return JSON.stringify({ ...head, items: payload.items ?? [] })
    }
  }

  return buildWorkbenchContext({
    edges: payload.edges,
    hidden: context.overlay?.hidden,
    kind: artifact.kind,
    layout: context.layout ?? null,
    nodes: payload.nodes,
    pinned: context.overlay?.pinned,
    revision: artifact.semantic_rev,
    selection: context.selection ?? null
  })
}

/**
 * Subscribe to every freshness source and push a coalesced summary.
 *
 * Selection is pushed IMMEDIATELY (pointing must feel instant); structural and
 * layout churn is debounced so a drag cannot spam the realtime data channel.
 * Returns an unsubscribe function.
 */
export function startWorkbenchContextSync(options: WorkbenchContextSyncOptions): () => void {
  const schedule = options.scheduler ?? {
    clearTimeout: (handle: number) => {
      window.clearTimeout(handle)
    },
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms)
  }

  let timer: null | number = null
  let lastSent: null | string = null
  let stopped = false

  const flush = () => {
    if (timer !== null) {
      schedule.clearTimeout(timer)
      timer = null
    }

    if (stopped) {
      return
    }

    const artifact = $workbenchArtifact.get()

    if (!artifact) {
      return
    }

    const summary = summarizeWorkbench(artifact, {
      layout: $workbenchLayout.get(),
      overlay: options.overlay?.(),
      selection: $workbenchSelection.get()
    })

    // Identical payloads are pure noise on the data channel.
    if (summary === lastSent) {
      return
    }

    lastSent = summary
    options.push(summary)
  }

  const flushSoon = () => {
    if (stopped || timer !== null) {
      return
    }

    timer = schedule.setTimeout(flush, WORKBENCH_CONTEXT_DEBOUNCE_MS)
  }

  const unsubscribes = [
    $workbenchArtifact.subscribe(() => {
      flushSoon()
    }),
    $workbenchLayout.subscribe(() => {
      flushSoon()
    }),
    // Immediate: "this one" must resolve to what the user just clicked.
    $workbenchSelection.subscribe(() => {
      flush()
    })
  ]

  return () => {
    stopped = true

    if (timer !== null) {
      schedule.clearTimeout(timer)
      timer = null
    }

    unsubscribes.forEach(off => {
      off()
    })
  }
}
