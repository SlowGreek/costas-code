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
 */
export function focusedNodeId(viewState: undefined | WorkbenchViewState): null | string {
  const focus = viewState?.focus

  if (typeof focus !== 'string') {
    return null
  }

  const trimmed = focus.trim()

  return trimmed.length > 0 ? trimmed : null
}
