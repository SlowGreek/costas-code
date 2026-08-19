import type { WorkbenchArtifact } from '@/store/workbench'

interface GraphNode {
  id: string
  label?: string
}

interface GraphEdge {
  from: string
  id?: string
  to: string
}

/** Beyond this the change is a rethink, not an edit, and listing it is noise. */
const WHOLESALE_CHANGE = 4

const nodesOf = (artifact: null | WorkbenchArtifact): GraphNode[] => {
  const nodes = (artifact?.payload as undefined | { nodes?: unknown })?.nodes

  return Array.isArray(nodes) ? (nodes as GraphNode[]) : []
}

const edgesOf = (artifact: null | WorkbenchArtifact): GraphEdge[] => {
  const edges = (artifact?.payload as undefined | { edges?: unknown })?.edges

  return Array.isArray(edges) ? (edges as GraphEdge[]) : []
}

const labelOf = (node: GraphNode): string => node.label ?? node.id

const list = (labels: string[]): string =>
  labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, 2).join(', ')} and more`

/**
 * One short sentence describing what changed on the canvas, or null.
 *
 * This is the payload of a context APPEND, not a prompt rewrite. The model
 * absorbs it without speaking, so the next time it talks it already knows —
 * which is the difference between narrating a drawing and having drawn it.
 *
 * Deliberately lossy. A wholesale redraw is summarised rather than itemised,
 * because twenty adds and eighteen removes is not something anyone says out
 * loud, and a channel full of noise is one the model learns to ignore.
 */
export function describeWorkbenchChange(
  before: null | WorkbenchArtifact,
  after: WorkbenchArtifact
): null | string {
  if (!before) {
    const count = nodesOf(after).length

    return count > 0
      ? `You drew the first diagram: ${count} ideas on the canvas.`
      : 'You drew the first thing on the canvas.'
  }

  if (before.kind !== after.kind) {
    return `You changed the canvas to a ${after.kind}.`
  }

  if (after.kind === 'sketch') {
    // Sketch payloads are raw HTML: diffing them says nothing useful.
    return 'You redrew the sketch.'
  }

  const beforeNodes = new Map(nodesOf(before).map(node => [node.id, node]))
  const afterNodes = new Map(nodesOf(after).map(node => [node.id, node]))

  const added = [...afterNodes.values()].filter(node => !beforeNodes.has(node.id))
  const removed = [...beforeNodes.values()].filter(node => !afterNodes.has(node.id))

  const renamed = [...afterNodes.values()].filter(node => {
    const previous = beforeNodes.get(node.id)

    return previous !== undefined && labelOf(previous) !== labelOf(node)
  })

  if (added.length + removed.length >= WHOLESALE_CHANGE) {
    return `You redrew the canvas: ${afterNodes.size} ideas now.`
  }

  const beforeEdges = new Set(edgesOf(before).map(edge => `${edge.from}\u0001${edge.to}`))

  const newEdges = edgesOf(after).filter(
    edge => !beforeEdges.has(`${edge.from}\u0001${edge.to}`)
  )

  const parts: string[] = []

  if (added.length > 0) {
    parts.push(`added ${list(added.map(labelOf))}`)
  }

  if (removed.length > 0) {
    parts.push(`removed ${list(removed.map(labelOf))}`)
  }

  if (renamed.length > 0) {
    parts.push(`renamed to ${list(renamed.map(labelOf))}`)
  }

  if (newEdges.length > 0 && parts.length < 2) {
    const first = newEdges[0]
    const from = afterNodes.get(first.from)
    const to = afterNodes.get(first.to)

    if (from && to) {
      parts.push(
        newEdges.length === 1
          ? `connected ${labelOf(from)} to ${labelOf(to)}`
          : `connected ${labelOf(from)} to ${labelOf(to)} and more`
      )
    }
  }

  if (parts.length === 0) {
    // Positions, pins and revisions move constantly and mean nothing to the
    // conversation. Silence keeps the channel worth listening to.
    return null
  }

  return `You ${parts.join(', ')}.`
}
