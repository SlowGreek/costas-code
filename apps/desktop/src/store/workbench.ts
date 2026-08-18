import { atom } from 'nanostores'

import { requestOneShot } from '@/lib/oneshot'
import type { RealtimeTranscript } from '@/lib/realtime-voice'

import { $gateway } from './gateway'

export interface WorkbenchNode {
  id: string
  label: string
  kind?: string
}

export interface WorkbenchEdge {
  from: string
  id: string
  label?: string
  to: string
}

export interface WorkbenchGraph {
  edges: WorkbenchEdge[]
  nodes: WorkbenchNode[]
}

export interface WorkbenchViewState {
  pinned?: string[]
  positions?: Record<string, { x: number; y: number }>
  zoom?: number
}

export interface WorkbenchArtifact {
  artifact_id: string
  kind: string
  payload: WorkbenchGraph
  semantic_rev: number
  view_rev: number
  view_state: WorkbenchViewState
}

export const $workbenchArtifact = atom<null | WorkbenchArtifact>(null)
export const $workbenchError = atom<null | string>(null)
export const $workbenchVoiceActive = atom(false)

const MAX_NODES = 12
const UPDATE_DEBOUNCE_MS = 3_000
const GEOMETRY_KEYS = new Set(['x', 'y', 'position', 'positions', 'width', 'height'])

const AMBIENT_INSTRUCTIONS = `You are the mute ambient diagrammer for a live voice ideation workbench.
Return ONLY JSON with this exact shape: {"nodes":[{"id":"stable-id","label":"short label","kind":"optional"}],"edges":[{"id":"stable-id","from":"node-id","to":"node-id","label":"optional"}]}.
Preserve existing ids for the same concept. Update the current graph rather than restating the transcript.
Never emit coordinates, prose, Markdown, or more than ${MAX_NODES} nodes. Collapse aggressively.`

let pendingSessionId = ''
let pendingTranscripts: RealtimeTranscript[] = []
let timer: null | ReturnType<typeof setTimeout> = null
let running = false

const requiredString = (value: unknown, field: string): string => {
  const text = typeof value === 'string' ? value.trim() : ''

  if (!text) {
    throw new Error(`Workbench graph ${field} is required`)
  }

  return text
}

export function parseWorkbenchGraph(text: string): WorkbenchGraph {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')

  if (start < 0 || end < start) {
    throw new Error('Workbench agent returned no JSON object')
  }

  const raw = JSON.parse(unfenced.slice(start, end + 1)) as { edges?: unknown; nodes?: unknown }

  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error('Workbench graph requires nodes and edges arrays')
  }

  if (raw.nodes.length > MAX_NODES) {
    throw new Error(`Workbench graph exceeds the ${MAX_NODES}-node budget`)
  }

  const ids = new Set<string>()

  const nodes = raw.nodes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Workbench graph nodes must be objects')
    }

    const node = value as Record<string, unknown>

    if (Object.keys(node).some(key => GEOMETRY_KEYS.has(key))) {
      throw new Error('Workbench graph semantics cannot contain renderer geometry')
    }

    const id = requiredString(node.id, 'node id')

    if (ids.has(id)) {
      throw new Error(`Workbench graph has duplicate node id: ${id}`)
    }

    ids.add(id)

    return {
      id,
      label: requiredString(node.label, 'node label'),
      ...(typeof node.kind === 'string' && node.kind.trim() ? { kind: node.kind.trim() } : {})
    }
  })

  const edgeIds = new Set<string>()

  const edges = raw.edges.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Workbench graph edges must be objects')
    }

    const edge = value as Record<string, unknown>
    const id = requiredString(edge.id, 'edge id')
    const from = requiredString(edge.from, 'edge from')
    const to = requiredString(edge.to, 'edge to')

    if (edgeIds.has(id)) {
      throw new Error(`Workbench graph has duplicate edge id: ${id}`)
    }

    if (!ids.has(from) || !ids.has(to)) {
      throw new Error(`Workbench graph edge ${id} references an unknown node`)
    }

    edgeIds.add(id)

    return {
      id,
      from,
      to,
      ...(typeof edge.label === 'string' && edge.label.trim() ? { label: edge.label.trim() } : {})
    }
  })

  return { nodes, edges }
}

async function runAmbientUpdate(): Promise<void> {
  if (running || !pendingSessionId || pendingTranscripts.length === 0) {
    return
  }

  const gateway = $gateway.get()

  if (!gateway) {
    return
  }

  running = true
  timer = null
  let failed = false
  const sessionId = pendingSessionId
  const transcript = pendingTranscripts.splice(0)

  try {
    const listed = await gateway.request<{ artifacts?: WorkbenchArtifact[] }>('artifact.list', {
      session_id: sessionId
    })

    const current = listed.artifacts?.find(artifact => artifact.artifact_id === 'map.main') ?? null

    const generated = await requestOneShot({
      input: JSON.stringify({
        current_graph: current?.payload ?? { nodes: [], edges: [] },
        transcript: transcript.map(entry => ({ role: entry.role, text: entry.text }))
      }),
      instructions: AMBIENT_INSTRUCTIONS,
      maxTokens: 1_200,
      sessionId,
      task: 'ideation_workbench',
      temperature: 0.2
    })

    const payload = parseWorkbenchGraph(generated)

    const response = current
      ? await gateway.request<{ artifact: WorkbenchArtifact }>('artifact.update_semantics', {
          session_id: sessionId,
          artifact_id: current.artifact_id,
          payload,
          expected_rev: current.semantic_rev,
          updated_by: 'ambient'
        })
      : await gateway.request<{ artifact: WorkbenchArtifact }>('artifact.create', {
          session_id: sessionId,
          artifact_id: 'map.main',
          kind: 'map',
          payload,
          view_state: { positions: {}, pinned: [] },
          updated_by: 'ambient'
        })

    $workbenchArtifact.set(response.artifact)
    $workbenchError.set(null)
  } catch (error) {
    failed = true
    // Put the unprocessed turn back at the front so a later transcript/retry
    // doesn't silently lose the thought that failed to draw.
    pendingTranscripts.unshift(...transcript)
    $workbenchError.set(error instanceof Error ? error.message : String(error))
  } finally {
    running = false

    if (!failed && pendingTranscripts.length > 0 && timer === null) {
      timer = setTimeout(() => void runAmbientUpdate(), UPDATE_DEBOUNCE_MS)
    }
  }
}

export function recordWorkbenchTranscript(sessionId: string, entry: RealtimeTranscript): void {
  if (!sessionId || !entry.text.trim()) {
    return
  }

  if (pendingSessionId && pendingSessionId !== sessionId) {
    pendingTranscripts = []
    $workbenchArtifact.set(null)
  }

  pendingSessionId = sessionId
  pendingTranscripts.push(entry)

  if (timer !== null) {
    clearTimeout(timer)
  }

  timer = setTimeout(() => void runAmbientUpdate(), UPDATE_DEBOUNCE_MS)
}

export function setWorkbenchVoiceActive(active: boolean): void {
  $workbenchVoiceActive.set(active)
}

export function setWorkbenchArtifact(artifact: null | WorkbenchArtifact): void {
  $workbenchArtifact.set(artifact)
}

export function resetWorkbenchForTests(): void {
  if (timer !== null) {
    clearTimeout(timer)
  }

  timer = null
  running = false
  pendingSessionId = ''
  pendingTranscripts = []
  $workbenchArtifact.set(null)
  $workbenchError.set(null)
  $workbenchVoiceActive.set(false)
}
