import {
  $workbenchArtifact,
  $workbenchDrawing,
  $workbenchLayout,
  $workbenchSelection,
  type WorkbenchArtifact
} from '@/store/workbench'

import { describeWorkbenchChange } from './workbench-change-event'
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
  /**
   * Append a one-line semantic event to the model's context WITHOUT making it
   * speak. Carries the transition ("added Memory") that the state snapshot
   * cannot express.
   */
  appendEvent?: (event: string) => void
  /** Pin/hide state, read lazily so Track B can own the atoms. */
  overlay?: () => WorkbenchContextOverlay
  /** Refresh the local snapshot used by response-scoped continuations. */
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
    /**
     * Whether a full redraw is in flight RIGHT NOW.
     *
     * Without this the voice model guesses: in a real session it told the user
     * "it's probably still drawing in the background" with nothing to base that
     * on, then declined to act. It can now see the state and reach for the
     * instant tools instead of queueing another ~9s redraw.
     */
    drawing?: boolean
    layout?: null | { height: number; positions: Record<string, { x: number; y: number }>; width: number }
    overlay?: WorkbenchContextOverlay
    selection?: null | string
  } = {}
): string {
  const payload = artifact.payload as {
    axes?: unknown
    // `id` is load-bearing: it is the only handle `disconnect(edge_id)` has.
    // Declaring edges without it invites a "tidy up" projection that silently
    // re-orphans the tool.
    edges?: { from: string; id?: string; label?: string; to: string }[]
    items?: { id: string; label?: string }[]
    nodes?: { id: string; kind?: string; label?: string }[]
  }

  // `redrawing` rides on EVERY kind: the model must know a slow redraw is in
  // flight whatever is currently on screen.
  const head = {
    kind: artifact.kind,
    revision: artifact.semantic_rev,
    ...(context.drawing ? { redrawing: true } : {})
  }

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
    drawing: context.drawing,
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
 * Keep the voice model current: one snapshot, then events.
 *
 * The previous design rewrote the model's whole system prompt on every canvas
 * change. That has two costs — it invalidates the cached prompt prefix on a
 * long-lived session, and it only ever carries STATE, so the model could see
 * twelve nodes but never learn that "Memory just appeared", which is the part
 * worth speaking about.
 *
 * Exactly one startup snapshot goes into instructions (what "which box is on
 * the left" is answered from). Every later transition is appended as a short
 * semantic event plus the latest authoritative snapshot. Appends do not
 * trigger generation, so clicks and canvas changes can keep the model current
 * without interrupting the conversation or invalidating the prompt prefix.
 *
 * Selection still flushes immediately — pointing must feel instant. Layout
 * churn stays debounced so a drag cannot spam the channel.
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
  let lastArtifact: null | WorkbenchArtifact = null
  let lastSelection: null | string = null
  let lastDrawing = false
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

    const selection = $workbenchSelection.get()
    const drawing = $workbenchDrawing.get()

    const summary = summarizeWorkbench(artifact, {
      drawing,
      layout: $workbenchLayout.get(),
      overlay: options.overlay?.(),
      selection
    })

    const previousArtifact = lastArtifact
    const event = describeWorkbenchChange(previousArtifact, artifact)
    const firstSnapshot = lastSent === null
    const selectionChanged = !firstSnapshot && selection !== lastSelection
    const drawingChanged = !firstSnapshot && drawing !== lastDrawing

    lastArtifact = artifact
    lastSelection = selection
    lastDrawing = drawing

    // Identical payloads are pure noise on the data channel.
    if (summary === lastSent) {
      if (event) {
        options.appendEvent?.(event)
      }

      return
    }

    lastSent = summary
    // Keep response-scoped continuation instructions aligned with the latest
    // world state without rewriting the session prompt. The short semantic
    // event below still tells the model what changed.
    options.push(summary)

    let fact: string

    if (firstSnapshot) {
      // The connection setup sends its snapshot explicitly. If the first
      // drawing appears after connect, this append supplies the baseline
      // without rewriting the system instructions.
      fact = [event, `Current canvas state (authoritative): ${summary}`].filter(Boolean).join(' ')
    } else if (event) {
      const wholesale = previousArtifact?.kind !== artifact.kind || /^You redrew/i.test(event)
      fact = wholesale ? `${event} Current canvas state (authoritative): ${summary}` : event
    } else if (selectionChanged) {
      const state = JSON.parse(summary) as {
        pointing_at?: null | string
        pointing_at_label?: null | string
        pointing_at_location?: null | string
      }

      fact = state.pointing_at
        ? `The user is now pointing at ${state.pointing_at_label ?? state.pointing_at} (id ${state.pointing_at})${state.pointing_at_location ? `, ${state.pointing_at_location}` : ''}.`
        : 'The user stopped pointing at a canvas item.'
    } else if (drawingChanged) {
      fact = drawing ? 'The canvas started updating.' : 'The canvas finished updating.'
    } else {
      // Debounced layout/pin/hide changes need a fresh spatial snapshot so
      // phrases like "the box on the left" remain grounded.
      fact = `The canvas view changed. Current canvas state (authoritative): ${summary}`
    }

    options.appendEvent?.(fact)
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
    // Immediate: the model must learn a slow redraw started BEFORE it decides
    // whether to queue another one.
    $workbenchDrawing.subscribe(() => {
      flush()
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
