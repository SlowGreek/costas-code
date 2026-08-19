import type { WorkbenchViewState } from '@/store/workbench'

/**
 * The node the ASSISTANT is currently talking about.
 *
 * `workbench.focus` writes `view_state.focus` when the voice model calls
 * `focus(node_id)`. Nothing read it until this function existed: the tool
 * succeeded, bumped `view_rev`, emitted `artifact.updated` — and the canvas
 * showed no sign of it. The model could say "the planner here" while the user
 * had no way to tell which box it meant, which is precisely the shared
 * referent the workbench is for.
 *
 * Deliberately separate from the user's click selection. Two different
 * referents: `focus` is where the assistant is pointing, selection is where
 * the user is pointing. Merging them would let the model appear to move the
 * user's own cursor.
 *
 * `liveNodeIds` guards against a STALE focus. `update_artifact_semantics`
 * deliberately does not touch `view_state`, so a full redraw that renames or
 * deletes the focused node leaves the old id behind — verified against the
 * real SessionDB. Without this check the ring would either vanish silently or,
 * worse, pulse around whatever node later reused the id.
 */
export function focusedNodeId(
  viewState: undefined | WorkbenchViewState,
  liveNodeIds?: Iterable<string>
): null | string {
  const focus = viewState?.focus

  if (typeof focus !== 'string') {
    return null
  }

  const trimmed = focus.trim()

  if (trimmed.length === 0) {
    return null
  }

  if (liveNodeIds === undefined) {
    return trimmed
  }

  for (const id of liveNodeIds) {
    if (id === trimmed) {
      return trimmed
    }
  }

  return null
}
