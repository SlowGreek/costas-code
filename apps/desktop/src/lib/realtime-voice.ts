import type {
  RealtimeMission,
  RealtimeMissionResumeAction
} from './realtime-mission-controller'
import {
  createRealtimeTurnController,
  type RealtimeStopInput,
  type RealtimeStopOutcome,
  type RealtimeToolLane,
  type RealtimeTurnController,
  type RealtimeTurnToolCall
} from './realtime-turn-controller'

export const fxStyleStopCheckpoint = (input: RealtimeStopInput): RealtimeStopOutcome => {
  const completedTools = input.turn.executions.filter(execution => execution.status === 'success')

  if (!input.canContinue || input.candidateText.trim() || completedTools.length < 2) {
    return { kind: 'allow' }
  }

  return {
    context:
      'Summarize your current progress for the user. Explain what the completed tools established before deciding whether another action is needed.',
    kind: 'continue_once'
  }
}

export interface RealtimeTranscript {
  connectionId?: string
  id: string
  role: 'assistant' | 'user'
  semanticTurnId?: string
  text: string
}

export type RealtimeVoiceStatus = 'listening' | 'speaking'

export interface RealtimeServerEventDeps {
  beforeToolCall?: () => Promise<void>
  createMissionId?: () => string
  /** Flush assistant audio already buffered in the browser (barge-in). */
  clearAssistantAudio?: () => void
  onAssistantAudioEnded?: () => void
  onAssistantAudioStarted?: () => void
  onAssistantResponseDone?: () => void
  onAssistantTranscriptDelta?: (delta: string) => void
  onProviderResponseEnded?: (status: string, continued: boolean) => void
  onProviderResponseStarted?: () => void
  onResearchDispatched?: (mission: RealtimeMission) => void
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
  onUserSpeechEnded?: () => void
  onUserSpeechStarted?: () => void
  pendingTranscription?: PendingTranscriptionTracker
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtimeSessionId: string
  send: (event: Record<string, unknown>) => void
  turnController?: RealtimeTurnController
}

export interface PendingTranscriptionTracker {
  /**
   * Resolve once every utterance that has stopped has produced (or failed to
   * produce) its transcription. The timeout is a *bound*, not the mechanism:
   * a normal turn settles on the real event with no added latency.
   */
  awaitSettled: (timeoutMs?: number) => Promise<void>
  markPending: () => void
  settle: () => void
}

/** Fallback bound for a transcription event that never arrives. */
export const PENDING_TRANSCRIPTION_TIMEOUT_MS = 4_000

export function createPendingTranscriptionTracker(): PendingTranscriptionTracker {
  let pending = 0
  let waiters: Array<() => void> = []

  const release = () => {
    const settled = waiters
    waiters = []
    settled.forEach(resolve => resolve())
  }

  return {
    awaitSettled: (timeoutMs = PENDING_TRANSCRIPTION_TIMEOUT_MS) => {
      if (pending <= 0) {
        return Promise.resolve()
      }

      return new Promise<void>(resolve => {
        let done = false

        const finish = () => {
          if (done) {
            return
          }

          done = true
          window.clearTimeout(timer)
          resolve()
        }

        // The timer only bounds a lost/slow transcription event; it never
        // paces a healthy turn.
        const timer = window.setTimeout(finish, timeoutMs)
        waiters.push(finish)
      })
    },
    markPending: () => {
      pending += 1
    },
    settle: () => {
      pending = Math.max(0, pending - 1)

      if (pending === 0) {
        release()
      }
    }
  }
}

/** Bound for one authoritative canvas snapshot appended to Realtime context. */
export const MAX_WORKBENCH_CONTEXT_CHARS = 16_000

const truncateContextString = (value: unknown, limit: number): unknown =>
  typeof value === 'string' && value.length > limit ? `${value.slice(0, limit - 1)}…` : value

/**
 * Keep an authoritative canvas fact valid and bounded — never slice JSON.
 *
 * Backend limits allow a graph whose desktop summary exceeds 64K. The voice
 * model needs every node referent far more than every edge label, so compaction
 * trims verbose strings and edge detail first, then records exact totals.
 */
export function boundWorkbenchContext(
  input: string,
  maxChars = MAX_WORKBENCH_CONTEXT_CHARS
): string {
  const text = input.trim()

  if (text.length <= maxChars) {
    return text
  }

  const marker = 'Current canvas state (authoritative): '
  const markerAt = text.indexOf(marker)
  const rawEventPrefix = markerAt >= 0 ? text.slice(0, markerAt) : ''
  // Semantic event prefixes are normally one short sentence. Bound them
  // independently so a pathological caller cannot consume the entire JSON
  // budget before compaction starts, while always preserving the marker.
  const prefixLimit = Math.min(1_000, Math.floor(maxChars / 4))

  const eventPrefix =
    rawEventPrefix.length > prefixLimit
      ? `${rawEventPrefix.slice(0, prefixLimit - 2)}… `
      : rawEventPrefix

  const prefix = markerAt >= 0 ? `${eventPrefix}${marker}` : ''
  const jsonText = markerAt >= 0 ? text.slice(markerAt + marker.length) : text

  let parsed: Record<string, unknown>

  try {
    const value = JSON.parse(jsonText) as unknown

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object')
    }

    parsed = value as Record<string, unknown>
  } catch {
    // Worst-case JSON escaping doubles backslashes/quotes; half-budget keeps
    // this fallback structurally complete without another blind slice.
    return JSON.stringify({
      context_truncated: true,
      summary: text.slice(0, Math.max(0, Math.floor(maxChars / 2) - 80))
    })
  }

  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : []
  const pointingAt = typeof parsed.pointing_at === 'string' ? parsed.pointing_at : null

  const nodes = rawNodes.map(item => {
    const node = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}

    return {
      ...node,
      id: truncateContextString(node.id, 128),
      kind: truncateContextString(node.kind, 32),
      label: truncateContextString(node.label, 96),
      location: truncateContextString(node.location, 80)
    }
  })

  if (pointingAt) {
    nodes.sort(
      (left, right) => Number(right.id === pointingAt) - Number(left.id === pointingAt)
    )
  }

  const edges = rawEdges.map(item => {
    const edge = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}

    return {
      ...edge,
      from: truncateContextString(edge.from, 128),
      id: truncateContextString(edge.id, 128),
      label: truncateContextString(edge.label, 80),
      to: truncateContextString(edge.to, 128)
    }
  })

  let nodeCount = nodes.length
  let edgeCount = edges.length

  const render = () =>
    `${prefix}${JSON.stringify({
      ...parsed,
      context_truncated: {
        edges_shown: edgeCount,
        edges_total: rawEdges.length,
        nodes_shown: nodeCount,
        nodes_total: rawNodes.length
      },
      edges: edges.slice(0, edgeCount),
      nodes: nodes.slice(0, nodeCount)
    })}`

  let result = render()

  while (result.length > maxChars && edgeCount > 0) {
    edgeCount = Math.max(0, edgeCount - Math.max(1, Math.ceil(edgeCount / 4)))
    result = render()
  }

  while (result.length > maxChars && nodeCount > 1) {
    nodeCount -= 1
    result = render()
  }

  if (result.length <= maxChars) {
    return result
  }

  // Pathological metadata still gets a complete object, never malformed JSON.
  return `${prefix}${JSON.stringify({
    context_truncated: {
      edges_shown: 0,
      edges_total: rawEdges.length,
      nodes_shown: 0,
      nodes_total: rawNodes.length
    },
    kind: parsed.kind,
    pointing_at: parsed.pointing_at,
    revision: parsed.revision
  })}`
}

interface RealtimeTokenResponse {
  client_secret: string
  connection_id?: string
  expires_at?: number
  model: string
  voice: string
  voice_capabilities?: { web_search?: boolean }
  /** Host that issued the secret; Azure secrets are not valid at OpenAI. */
  webrtc_url?: string
}

export interface RealtimeVoiceConnection {
  /** Settles when in-flight input transcriptions have landed. */
  awaitPendingTranscription: (timeoutMs?: number) => Promise<void>
  /**
   * Add a fact to the model's context WITHOUT making it speak.
   *
   * The append/generate split is a property of the Realtime event protocol,
   * not of any particular transport: `conversation.item.create` mutates
   * context, `response.create` runs the model, and they are independent. So a
   * background worker can keep the model current continuously while the
   * expensive part only happens when there is an actual conversational turn.
   *
   * Preferred over rewriting the instructions for anything that CHANGED:
   * a rewrite carries state and invalidates the cached prompt prefix, an
   * append carries the transition and costs one short message.
   */
  appendContext: (fact: string) => void
  close: () => void
  /** Seed prior conversation turns so voice continues rather than restarts. */
  seedHistory: (turns: RealtimeTranscript[]) => void
  /** Continue a ready mission without injecting a synthetic user message. */
  resumeMission: (event: RealtimeMissionResumeAction['event']) => boolean
  setMuted: (muted: boolean) => void
  /** Manual interrupt: cancel generation and flush buffered assistant audio. */
  stopTurn: () => void
  updateWorkbenchContext: (summary: string) => void
}

export interface StartRealtimeVoiceOptions {
  audioFactory?: () => HTMLAudioElement
  beforeToolCall?: () => Promise<void>
  createMissionId?: () => string
  fetchFn?: typeof fetch
  instructions?: string
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  onAssistantAudioEnded?: () => void
  onAssistantAudioStarted?: () => void
  onAssistantResponseDone?: () => void
  onAssistantTranscriptDelta?: (delta: string) => void
  onConnectionClosed?: () => void
  onProviderResponseEnded?: (status: string, continued: boolean) => void
  onProviderResponseStarted?: () => void
  onResearchDispatched?: (mission: RealtimeMission) => void
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
  onUserSpeechEnded?: () => void
  onUserSpeechStarted?: () => void
  peerConnectionFactory?: () => RTCPeerConnection
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtimeSessionId: string
}

/**
 * How the realtime voice agent behaves in ideation mode.
 *
 * Written as a description of the mode, not a list of prohibitions. An earlier
 * revision accumulated one "never" per bug fixed — 11 of 20 sentences carried a
 * prohibition — and a model walking on eggshells sounds like it: careful,
 * hedged, and stilted. The behaviours below are the same; the framing is what
 * the mode IS rather than what it must avoid.
 */
const DEFAULT_REALTIME_INSTRUCTIONS =
  'You are Hermes, thinking out loud with someone at a shared canvas. Talk like a person: warm, brief, curious. ' +
  'You are often joining a conversation already under way — earlier turns and the current canvas are in your context, so continue the thought rather than introducing yourself or recapping. ' +
  // Speech arrives in fragments. Observed: "Well, I guess" / "Let's dive into
  // the loop, actually" arrived as separate turns and she answered the first
  // one; "Okay." got a "Hi there."; a stray Mandarin phrase from the room got
  // treated as an instruction. Each reply to a fragment costs a turn and
  // derails the thread.
  'People think out loud, so half-sentences will reach you — "Well, I guess", "Okay", "So can we", a stray phrase from the room. Wait for the actual request instead of answering the fragment. If someone trails off, let the silence sit; they are still forming the thought. Only ask when you genuinely cannot tell what they want. ' +
  // The canvas is a shared visual workspace, independent of who owns redraws.
  'The canvas is the shared visual workspace for this conversation. Talk about the ideas and what they mean rather than narrating interface state. ' +
  // Skip pre-action throat-clearing without turning the whole tool loop into a
  // silent batch. The prior "then speak once" wording made the model perform
  // four focus rounds before explaining any of them.
  'Use tools without filler announcements — no "let me pull that up", no "give me a second", no "I\'ll sketch that out". Silence means skip the filler before an action; it does not mean defer all speech until every action is done. In multi-step work, follow the natural agent cycle: act, observe, explain the current progress when useful, then choose the next action. ' +
  '`redrawing: true` in the workbench summary means the canvas is already updating; keep talking and reach for the instant tools if the user wants one existing thing changed. ' +
  // The plumbing leak. Observed verbatim: "It's probably still drawing in the
  // background right now. These full redraws can take a moment, and I
  // shouldn't start another one while it's in progress." That is the
  // implementation in her mouth, and it reads as apologising for the software.
  'Keep the machinery to yourself. Redraws, render timing, what is in flight, what you are or are not allowed to call — none of that belongs in the conversation. If the user says they cannot see something yet, say so plainly in one short line and carry on with the idea. ' +
  // Latency is the reason to prefer the fast tools, so give the reason.
  'The instant tools land in milliseconds, so use focus, rename, connect, disconnect and remove for single changes, and go_back when the user wants an earlier version. ' +
  'session_snapshot tells you what is actually on the canvas; check it before describing what the user is looking at. ' +
  // Deixis. This is the line that makes the shared referent real: without it
  // the model has the selection in context and still asks "which one?".
  'The workbench summary places every node in plain language ("upper left", "centre", "far right", and neighbours like "left of: Planner"), and `pointing_at` is the node the user just clicked — they are literally pointing at it. ' +
  '"This one", "that", "it", "this box" all mean `pointing_at`: resolve it silently and act. ' +
  'With nothing selected, use the spatial descriptions to work out what "the one on the left" means, and ask only when it is genuinely ambiguous. ' +
  'Speak locations the way a person would — "the box on the far right" — and use focus for a single node when the referent would otherwise be ambiguous. ' +
  // A walkthrough is intentionally one bounded semantic micro-round per node.
  // Transcript deltas run ahead of audible WebRTC playback, so trying to infer
  // focus from generated words highlights the whole route before it is heard.
  'During a walkthrough, handle exactly one node per tool round. Focus exactly one node, then in the continuation explain only that node. After that explanation, call focus for the next node and repeat. Never schedule multiple focus calls together, and do not name future nodes during the current node’s explanation. ' +
  // Layout intent. Without this she has no way to answer a question about
  // arrangement and falls back to redrawing the same graph.
  'When the user asks about the SHAPE of the diagram rather than its content — "show me this linearly", "as a flow", "step by step", "top down" — call visualize with the requested arrangement as its direction. That is a real canvas change, not something to claim in speech without changing the artifact.'

const VOICE_OWNED_REDRAW_INSTRUCTIONS =
  'You decide when the drawing should change and how to change it. For deliberate live construction, use add_node, connect, rename, focus, and remove directly so each accepted action becomes the next state you can explain. Add and explain one presentation step before moving to the next. When the user asks “what would that look like?”, always perform a real canvas action. Use speed_draw—or the backward-compatible visualize alias—when the user asks for a fast whole-canvas draft, broad layout, or wholesale rethink without narration for every node. The mute diagrammer edits in place with validated operations whenever possible. Explicit visual requests always require a real canvas action; spoken description alone does not satisfy them. `status: drawing` means a speed draw started, not that it finished; continue with the actual answer while it appears and let the user confirm what they see.'

const VOICE_ACTION_LOOP_INSTRUCTIONS =
  'You operate inside a real agent loop. One human turn may span several model responses and tool rounds; each response is one inference step, not necessarily the whole user turn. When you call a tool, the harness executes it, returns the tool result, and creates another inference in this same semantic turn. A tool-free response ends the loop. Therefore, while work remains, call the next tool before that response ends; spoken output may explain the current step without implying the whole request is complete. Return a tool-free response only when the original user request is satisfied or you genuinely need their input. When one action depends on another, call the first tool, inspect its result, and continue from there. Do not schedule dependent actions together: search, inspect, then visualize; snapshot, edit, then inspect again when confirmation matters. Keep the same conversational thought across every inference without greeting, restarting, or recapping.'

const VOICE_RESEARCH_INSTRUCTIONS =
  'Use delegate_research reluctantly, only for substantial multi-source or deep research that cannot be answered with a quick web_search. Prefer web_search for current facts and small lookups. A research worker produces evidence only; you remain the sole conversational authority and decide what it means, what to draw, and what to say. After dispatch, keep the returned artifact_id. Do not busy-poll: if research_status says running, explain that the evidence is being gathered and end normally. On a later user turn, call research_status; when ready, use research_search to locate relevant evidence and research_read to inspect only the needed sections before drawing or answering.'

const WEB_SEARCH_INSTRUCTIONS =
  'You can search the live web for current information and unfamiliar facts. Use web_search silently instead of guessing, then ground the spoken answer in the returned sources.'

/** Test seam: assert behavior contracts for the voice-owned mode. */
export const REALTIME_INSTRUCTIONS_FOR_TESTS =
  `${DEFAULT_REALTIME_INSTRUCTIONS}\n\n${VOICE_OWNED_REDRAW_INSTRUCTIONS}\n\n${VOICE_ACTION_LOOP_INSTRUCTIONS}\n\n${VOICE_RESEARCH_INSTRUCTIONS}`

/**
 * Server-side turn taking. Sent on every `session.update` so a later context
 * update can never silently drop barge-in if the API replaces (rather than
 * merges) the session object.
 */
const REALTIME_AUDIO_CONFIG = {
  input: {
    turn_detection: {
      type: 'semantic_vad',
      // `low` waits longer before deciding the user has finished. Observed on
      // `auto`: "Well, I guess" and "Let's dive into the loop, actually"
      // arrived as separate turns and she answered the first one; a bare
      // "Okay." drew a "Hi there.". Ideation is full of half-formed sentences,
      // and interrupting one costs more than a slightly later reply.
      eagerness: 'low',
      create_response: true,
      interrupt_response: true
    }
  }
}

const sessionUpdateEvent = (instructions: string, webSearchAvailable = false) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    instructions,
    audio: REALTIME_AUDIO_CONFIG,
    tools: [
      {
        type: 'function',
        name: 'session_snapshot',
        description: 'Read the current Hermes workbench artifacts and their revisions.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'visualize',
        description:
          'Backward-compatible whole-diagram drawing through the mute diagrammer. Prefer direct add_node/connect/rename/remove for deliberate live drawing. Use this or speed_draw for a fast whole-canvas draft. ' +
          'After the first drawing, use it when the requested structure genuinely changed: a new area of the problem, several new ideas at once, or a canvas that no longer matches what you are discussing. ' +
          'It takes a few seconds, but the diagrammer edits in place with validated ops whenever possible; grouped removals/additions and layout-only changes do not require replacing the artifact. For one label, one link, or one box, use rename / connect / disconnect / remove instead, which are instant.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Optional direction for what the diagrammer should emphasize or correct.'
            }
          },
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'speed_draw',
        description:
          'Generate or restructure the whole canvas quickly through the mute diagrammer without narrating every node. Use for fast drafts, broad layouts, or wholesale redraws. For live narrated construction, use add_node and connect incrementally instead.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Direction for the fast whole-canvas draft.'
            }
          },
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'delegate_research',
        description:
          'Reluctantly dispatch a silent Hermes research worker for substantial multi-source or deep investigation. Prefer web_search for quick facts. Returns an artifact_id immediately; the worker cannot speak to the user or control the canvas.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The complete research question and evidence needed.' }
          },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'research_status',
        description:
          'Check a previously dispatched research artifact once on a later turn. Do not busy-poll. Returns running, ready, or failed.',
        parameters: {
          type: 'object',
          properties: {
            artifact_id: { type: 'string', description: 'Optional artifact_id. Omit after reconnect to recover the latest research for this session.' }
          },
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'research_search',
        description:
          'Search a READY research artifact for relevant evidence before reading it. Returns bounded matching lines.',
        parameters: {
          type: 'object',
          properties: {
            artifact_id: { type: 'string', description: 'Opaque ready research artifact id.' },
            query: { type: 'string', description: 'Literal evidence phrase or concept to locate.' }
          },
          required: ['artifact_id', 'query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'research_read',
        description:
          'Read a bounded line range from a READY cited research artifact after locating relevant sections.',
        parameters: {
          type: 'object',
          properties: {
            artifact_id: { type: 'string', description: 'Opaque ready research artifact id.' },
            start_line: { type: 'integer', minimum: 1 },
            line_count: { type: 'integer', minimum: 1, maximum: 100 }
          },
          required: ['artifact_id'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'web_search',
        description:
          'Search the live web for current events, recent changes, unfamiliar entities, versions, prices, policies, or any fact you are not confident is current. Use the returned titles, descriptions, and URLs as sources instead of guessing.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Focused search query.' },
            limit: { type: 'integer', minimum: 1, maximum: 5 }
          },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'add_node',
        description:
          'Add ONE new node directly to the current map. Use this to build ideas incrementally while talking. Add and explain one node before adding the next in a stepwise walkthrough. Use visualize/speed_draw only when the user wants a fast whole-canvas draft.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable unique node id.' },
            label: { type: 'string', description: 'Visible node label.' },
            kind: { type: 'string', description: 'Optional semantic kind such as agent, system, idea, or surface.' }
          },
          required: ['id', 'label'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'focus',
        description:
          'Instantly ring ONE existing node on the canvas so the user can see which box you mean. Use it whenever you talk about a specific part ("the planner here", "this one on the left") — the user sees the highlight while you speak. Changes nothing about the ideas themselves and needs no full redraw.',
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'Existing node id from session_snapshot.' }
          },
          required: ['node_id'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'go_back',
        description:
          'Instantly restore the PREVIOUS version of the drawing. This is the tool for "go back", "undo that", "show me what it looked like before", "actually the old one was better". It is immediate and never calls the diagrammer, so never redraw to get back to something you already had.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'rename',
        description:
          'Instantly change ONE existing node\'s label, keeping its id and every connection. This is the right tool for "call that Planner instead", "that should say latency budget". Never redraw the diagram for a wording change.',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The new label text.' },
            node_id: { type: 'string', description: 'Existing node id from session_snapshot.' }
          },
          required: ['node_id', 'label'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'connect',
        description:
          'Instantly add ONE link between two nodes that already exist. Use it for "those two are related", "the planner feeds the executor". If either end does not exist yet, call visualize with the new structure so the mute diagrammer can add it.',
        parameters: {
          type: 'object',
          properties: {
            from_id: { type: 'string', description: 'Existing source node id.' },
            label: { type: 'string', description: 'Optional short label for the link.' },
            to_id: { type: 'string', description: 'Existing target node id.' }
          },
          required: ['from_id', 'to_id'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'disconnect',
        description:
          'Instantly remove ONE link by its edge id. Use it for "those are not actually connected". Leaves both nodes in place.',
        parameters: {
          type: 'object',
          properties: {
            edge_id: { type: 'string', description: 'Existing edge id from session_snapshot.' }
          },
          required: ['edge_id'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'remove',
        description:
          'Instantly delete ONE node and any links touching it. This is the tool for "lose the exhaust", "drop that box", "we do not need caching". Deleting one thing is never a reason to redraw the whole diagram.',
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'Existing node id from session_snapshot.' }
          },
          required: ['node_id'],
          additionalProperties: false
        }
      }
    ].filter(tool => tool.name !== 'web_search' || webSearchAvailable),
    tool_choice: 'auto'
  }
})

export async function startRealtimeVoiceConnection(
  options: StartRealtimeVoiceOptions
): Promise<RealtimeVoiceConnection> {
  const token = (await options.request('voice.realtime.token', {
    session_id: options.runtimeSessionId
  })) as RealtimeTokenResponse

  if (!token?.client_secret) {
    throw new Error('Hermes returned no GPT Realtime credential')
  }

  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices
  const createPeer = options.peerConnectionFactory ?? (() => new RTCPeerConnection())
  const createAudio = options.audioFactory ?? (() => document.createElement('audio'))
  const fetchFn = options.fetchFn ?? fetch
  const peer = createPeer()
  const audio = createAudio()

  const semanticConnectionId =
    token.connection_id ||
    globalThis.crypto?.randomUUID?.() ||
    `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  const webSearchAvailable = token.voice_capabilities?.web_search === true
  const configuredInstructions = options.instructions ?? DEFAULT_REALTIME_INSTRUCTIONS
  const baseInstructions = `${configuredInstructions}\n\n${VOICE_OWNED_REDRAW_INSTRUCTIONS}\n\n${VOICE_ACTION_LOOP_INSTRUCTIONS}\n\n${VOICE_RESEARCH_INSTRUCTIONS}${webSearchAvailable ? `\n\n${WEB_SEARCH_INSTRUCTIONS}` : ''}`

  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })

  const tracks = stream.getTracks()
  const channel = peer.createDataChannel('oai-events')
  const pendingTranscription = createPendingTranscriptionTracker()
  let channelOpen = false
  let closed = false
  let workbenchContext = ''
  // Tracks whether OpenAI currently has audio in the browser's output buffer.
  // output_audio_buffer.clear errors if the buffer is empty, so barge-in must
  // only fire while the assistant is actually speaking.
  let assistantSpeaking = false

  const instructions = () =>
    workbenchContext
      ? `${baseInstructions}\n\nCurrent workbench state (authoritative summary):\n${workbenchContext}`
      : baseInstructions

  const markRemoteClosed = () => {
    if (!channelOpen) {
      return
    }

    channelOpen = false
    options.onConnectionClosed?.()
  }

  const send = (event: Record<string, unknown>): boolean => {
    if (!channelOpen || closed) {
      return false
    }

    try {
      channel.send(JSON.stringify(event))

      return true
    } catch {
      markRemoteClosed()

      return false
    }
  }

  const voiceToolDeps = {
    beforeToolCall: options.beforeToolCall,
    createMissionId: options.createMissionId,
    onResearchDispatched: options.onResearchDispatched,
    request: options.request,
    runtimeSessionId: options.runtimeSessionId
  }

  const turnController = createRealtimeTurnController({
    baseInstructions: instructions,
    execute: call => executeRealtimeVoiceTool(call, voiceToolDeps),
    laneFor: voiceToolLane,
    // Enough for one snapshot plus a seven-node guided walkthrough while still
    // bounding runaway voice loops. Spoken walkthroughs routinely exceed 30s.
    maxActions: 8,
    maxToolRounds: 8,
    maxTurnMs: 120_000,
    send,
    stop: fxStyleStopCheckpoint,
    turnIdPrefix: `voice-${semanticConnectionId}-turn`
  })

  /**
   * Flush assistant audio already buffered in the browser. `interrupt_response`
   * only stops server-side generation; without this the tail keeps playing over
   * the user. Guarded on assistantSpeaking because clearing an empty buffer is
   * an API error.
   */
  const clearAssistantAudio = () => {
    if (!channelOpen || closed || !assistantSpeaking) {
      return
    }

    assistantSpeaking = false
    send({ type: 'output_audio_buffer.clear' })
  }

  const close = () => {
    if (closed) {
      return
    }

    closed = true
    channelOpen = false
    turnController.close()

    if (token.connection_id) {
      void options
        .request('voice.realtime.close', {
          connection_id: token.connection_id,
          session_id: options.runtimeSessionId
        })
        .catch(() => undefined)
    }

    tracks.forEach(track => track.stop())
    channel.close()
    peer.close()
    audio.pause()
    audio.srcObject = null
    audio.remove()
  }

  try {
    audio.autoplay = true

    peer.ontrack = event => {
      audio.srcObject = event.streams[0] ?? null
    }

    tracks.forEach(track => peer.addTrack(track, stream))

    channel.addEventListener('open', () => {
      channelOpen = true
      send(sessionUpdateEvent(instructions(), webSearchAvailable))
    })
    channel.addEventListener('close', markRemoteClosed)
    channel.addEventListener('message', event => {
      try {
        const serverEvent = JSON.parse(event.data) as unknown

        void routeRealtimeServerEvent(serverEvent, {
          beforeToolCall: options.beforeToolCall,
          clearAssistantAudio,
          onAssistantAudioEnded: () => {
            assistantSpeaking = false
            options.onAssistantAudioEnded?.()
          },
          onAssistantAudioStarted: () => {
            assistantSpeaking = true
            options.onAssistantAudioStarted?.()
          },
          onAssistantResponseDone: options.onAssistantResponseDone,
          onAssistantTranscriptDelta: options.onAssistantTranscriptDelta,
          onProviderResponseEnded: options.onProviderResponseEnded,
          onProviderResponseStarted: options.onProviderResponseStarted,
          onStatus: options.onStatus,
          onTranscript: entry =>
            options.onTranscript?.({ ...entry, connectionId: token.connection_id }),
          onUserSpeechEnded: options.onUserSpeechEnded,
          onUserSpeechStarted: options.onUserSpeechStarted,
          pendingTranscription,
          request: options.request,
          runtimeSessionId: options.runtimeSessionId,
          send,
          turnController
        })
      } catch {
        // A malformed data-channel frame must not tear down live audio.
      }
    })

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)

    if (!offer.sdp) {
      throw new Error('Browser created an empty WebRTC offer')
    }

    const response = await fetchFn(
      token.webrtc_url || 'https://api.openai.com/v1/realtime/calls',
      {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: ['Bearer', token.client_secret].join(' '),
          'Content-Type': 'application/sdp'
        }
      }
    )

    if (!response.ok) {
      throw new Error(`OpenAI Realtime WebRTC negotiation failed (HTTP ${response.status})`)
    }

    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
  } catch (error) {
    close()
    throw error
  }

  return {
    awaitPendingTranscription: timeoutMs => pendingTranscription.awaitSettled(timeoutMs),
    appendContext: fact => {
      // Match the authoritative snapshot budget used by
      // updateWorkbenchContext. Five hundred characters truncated a normal
      // 10–20-node JSON snapshot mid-object and made the event-source channel
      // confidently stale. The shared compactor preserves complete valid JSON
      // under a 16K (~4K token) budget, retaining node referents before edge
      // detail and recording exact shown/total counts.
      const text = boundWorkbenchContext(fact)

      if (!channelOpen || closed || !text) {
        return
      }

      // A system-authored fact, appended as context. Crucially NO
      // `response.create`: the model absorbs it silently and uses it the next
      // time it speaks, so the canvas can keep changing without interrupting
      // the conversation or costing a turn.
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }]
        }
      })
    },
    close,
    seedHistory: turns => {
      if (!channelOpen || closed) {
        return
      }

      // Insert prior turns as conversation items so the model continues the
      // discussion instead of greeting the user cold. No `response.create`:
      // seeding context must not make it start talking on its own.
      for (const turn of turns) {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: turn.role,
            content: [
              {
                type: turn.role === 'assistant' ? 'output_text' : 'input_text',
                text: turn.text
              }
            ]
          }
        })
      }
    },
    resumeMission: event => {
      if (!channelOpen || closed) {
        return false
      }

      return send(event)
    },
    setMuted: muted => {
      tracks.forEach(track => {
        track.enabled = !muted
      })
    },
    stopTurn: () => {
      if (!channelOpen || closed) {
        return
      }

      // Cancel generation first, then flush what already reached the browser.
      turnController.interrupt()
      send({ type: 'response.cancel' })
      clearAssistantAudio()
    },
    updateWorkbenchContext: summary => {
      workbenchContext = boundWorkbenchContext(summary)

      if (channelOpen && !closed) {
        send(sessionUpdateEvent(instructions(), webSearchAvailable))
      }
    }
  }
}

type RealtimeEvent = {
  arguments?: unknown
  call_id?: unknown
  delta?: unknown
  item_id?: unknown
  name?: unknown
  response?: unknown
  response_id?: unknown
  transcript?: unknown
  type?: unknown
}

const asTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * Turn a surgical tool call into a gateway request.
 *
 * Pure and exported so the routing (which tool maps to which RPC, and what
 * counts as valid arguments) is unit-testable without a live data channel.
 * Returns null for a name this facade does not handle.
 */
export function surgicalToolRequest(
  name: string,
  rawArguments: string
): null | { method: string; params: Record<string, unknown> } {
  let parsed: Record<string, unknown> = {}

  try {
    const value = JSON.parse(rawArguments || '{}') as unknown

    if (value && typeof value === 'object') {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Malformed arguments fall through to the per-tool required checks below.
  }

  const text = (key: string): string => asTrimmedString(parsed[key]).slice(0, 200)

  if (name === 'go_back') {
    // No arguments: "go back" always means one step, from wherever we are.
    return { method: 'workbench.back', params: {} }
  }

  if (name === 'focus') {
    const nodeId = text('node_id')

    return nodeId ? { method: 'workbench.focus', params: { node_id: nodeId } } : null
  }

  if (name === 'add_node') {
    const id = text('id')
    const label = text('label')
    const kind = text('kind')

    return id && label
      ? {
          method: 'workbench.edit',
          params: {
            edit: { id, label, op: 'add_node', ...(kind ? { kind } : {}) }
          }
        }
      : null
  }

  if (name === 'rename') {
    const nodeId = text('node_id')
    const label = text('label')

    return nodeId && label
      ? { method: 'workbench.edit', params: { edit: { label, node_id: nodeId, op: 'rename' } } }
      : null
  }

  if (name === 'connect') {
    const fromId = text('from_id')
    const toId = text('to_id')
    const label = text('label')

    return fromId && toId
      ? {
          method: 'workbench.edit',
          params: {
            edit: { from_id: fromId, op: 'connect', to_id: toId, ...(label ? { label } : {}) }
          }
        }
      : null
  }

  if (name === 'disconnect') {
    const edgeId = text('edge_id')

    return edgeId
      ? { method: 'workbench.edit', params: { edit: { edge_id: edgeId, op: 'disconnect' } } }
      : null
  }

  if (name === 'remove') {
    const nodeId = text('node_id')

    return nodeId
      ? { method: 'workbench.edit', params: { edit: { node_id: nodeId, op: 'remove' } } }
      : null
  }

  return null
}

/** Tool names handled by the surgical (no-model, instant) write path. */
export const SURGICAL_TOOL_NAMES = [
  'focus',
  'add_node',
  'rename',
  'connect',
  'disconnect',
  'remove'
] as const

export function voiceToolLane(call: Pick<RealtimeTurnToolCall, 'name'>): RealtimeToolLane {
  if (
    call.name === 'session_snapshot' ||
    call.name === 'web_search' ||
    call.name === 'research_status' ||
    call.name === 'research_search' ||
    call.name === 'research_read'
  ) {
    return 'read'
  }

  if (call.name === 'focus') {
    return 'gesture'
  }

  if (call.name === 'add_node') {
    return 'presentation'
  }

  if (
    call.name === 'visualize' ||
    call.name === 'speed_draw' ||
    call.name === 'delegate_research'
  ) {
    return 'slow'
  }

  if (call.name === 'go_back' || (SURGICAL_TOOL_NAMES as readonly string[]).includes(call.name)) {
    return 'edit'
  }

  return 'serial'
}

const realtimeResponseId = (event: RealtimeEvent): string => {
  const response =
    event.response && typeof event.response === 'object'
      ? (event.response as Record<string, unknown>)
      : null

  return asTrimmedString(event.response_id) || asTrimmedString(response?.id)
}

const realtimeResponseStatus = (event: RealtimeEvent): string => {
  const response =
    event.response && typeof event.response === 'object'
      ? (event.response as Record<string, unknown>)
      : null

  return asTrimmedString(response?.status) || 'completed'
}

/** Execute one voice-facade call without deciding when the provider continues. */
export async function executeRealtimeVoiceTool(
  call: RealtimeTurnToolCall,
  deps: Pick<
    RealtimeServerEventDeps,
    | 'beforeToolCall'
    | 'createMissionId'
    | 'onResearchDispatched'
    | 'request'
    | 'runtimeSessionId'
  >
): Promise<unknown> {
  const { name } = call

  if (name === 'session_snapshot') {
    // Reads stored state, so it must see the user's last sentence.
    await deps.beforeToolCall?.()

    return deps.request('artifact.list', { session_id: deps.runtimeSessionId })
  }

  if (name === 'delegate_research') {
    let query = ''

    try {
      const parsed = JSON.parse(call.arguments || '{}') as { query?: unknown }
      query = asTrimmedString(parsed.query).slice(0, 1_000)
    } catch {
      // Invalid arguments become a structured tool error below.
    }

    if (!query) {
      return { error: 'delegate_research is missing a query' }
    }

    await deps.beforeToolCall?.()

    const missionId = deps.createMissionId?.() ?? `mission_${crypto.randomUUID().replaceAll('-', '')}`

    const result = await deps.request('voice.realtime.delegate_research', {
      session_id: deps.runtimeSessionId,
      mission_id: missionId,
      query
    })

    const dispatched = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    const artifactId = asTrimmedString(dispatched?.artifact_id)
    const delegationId = asTrimmedString(dispatched?.delegation_id)
    const returnedMissionId = asTrimmedString(dispatched?.mission_id)

    if (
      dispatched?.status === 'dispatched' &&
      artifactId &&
      delegationId &&
      (!returnedMissionId || returnedMissionId === missionId)
    ) {
      deps.onResearchDispatched?.({
        artifactId,
        delegationId,
        label: query.length > 60 ? `${query.slice(0, 59)}…` : query,
        missionId,
        runtimeSessionId: deps.runtimeSessionId
      })
    }

    return result
  }

  if (name === 'research_status' || name === 'research_search' || name === 'research_read') {
    let artifactId = ''
    let query = ''
    let startLine = 1
    let lineCount = 40

    try {
      const parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      artifactId = asTrimmedString(parsed.artifact_id).slice(0, 100)
      query = asTrimmedString(parsed.query).slice(0, 500)

      if (typeof parsed.start_line === 'number' && Number.isFinite(parsed.start_line)) {
        startLine = Math.max(1, Math.trunc(parsed.start_line))
      }

      if (typeof parsed.line_count === 'number' && Number.isFinite(parsed.line_count)) {
        lineCount = Math.min(Math.max(1, Math.trunc(parsed.line_count)), 100)
      }
    } catch {
      // Invalid arguments become a structured tool error below.
    }

    if (!artifactId && name !== 'research_status') {
      return { error: `${name} is missing an artifact_id` }
    }

    if (name === 'research_status') {
      return deps.request('voice.realtime.research_status', {
        session_id: deps.runtimeSessionId,
        ...(artifactId ? { artifact_id: artifactId } : {})
      })
    }

    if (name === 'research_search') {
      return query
        ? deps.request('voice.realtime.research_search', {
            session_id: deps.runtimeSessionId,
            artifact_id: artifactId,
            query
          })
        : { error: 'research_search is missing a query' }
    }

    return deps.request('voice.realtime.research_read', {
      session_id: deps.runtimeSessionId,
      artifact_id: artifactId,
      start_line: startLine,
      line_count: lineCount
    })
  }

  if (name === 'visualize' || name === 'speed_draw') {
    let prompt = ''

    try {
      const parsed = JSON.parse(call.arguments || '{}') as { prompt?: unknown }
      prompt = asTrimmedString(parsed.prompt).slice(0, 1_000)
    } catch {
      // Invalid optional arguments degrade to transcript-only visualization.
    }

    // FIRE AND FORGET. The diagram reaches the canvas via artifact.updated;
    // conversation continuity must not wait for the auxiliary model.
    void (async () => {
      await deps.beforeToolCall?.()
      await deps.request('workbench.visualize', {
        session_id: deps.runtimeSessionId,
        prompt
      })
    })().catch(() => undefined)

    return { status: 'drawing' }
  }

  if (name === 'web_search') {
    let query = ''
    let limit = 5

    try {
      const parsed = JSON.parse(call.arguments || '{}') as {
        limit?: unknown
        query?: unknown
      }

      query = asTrimmedString(parsed.query).slice(0, 500)

      if (typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)) {
        limit = Math.min(Math.max(Math.trunc(parsed.limit), 1), 5)
      }
    } catch {
      // Invalid search arguments become a structured tool error below.
    }

    return query
      ? deps.request('voice.realtime.web_search', {
          session_id: deps.runtimeSessionId,
          query,
          limit
        })
      : { error: 'web_search is missing a query' }
  }

  const surgical = surgicalToolRequest(name, call.arguments)

  if (surgical) {
    // Straight to persistence: these tools act on ids the model already holds
    // and do not read transcript state, so they deliberately skip the gate.
    return deps.request(surgical.method, {
      session_id: deps.runtimeSessionId,
      ...surgical.params
    })
  }

  if ((SURGICAL_TOOL_NAMES as readonly string[]).includes(name)) {
    return { error: `${name} is missing required arguments` }
  }

  return { error: `Unsupported voice tool: ${name || '<missing>'}` }
}

/**
 * Route server events that cross the Hermes/Realtime boundary.
 *
 * Audio stays on the peer connection. This function owns only durable
 * transcript notifications and the deliberately tiny voice tool facade.
 */
export async function routeRealtimeServerEvent(
  rawEvent: unknown,
  deps: RealtimeServerEventDeps
): Promise<void> {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return
  }

  const event = rawEvent as RealtimeEvent
  const type = asTrimmedString(event.type)

  if (type === 'response.created') {
    deps.turnController?.responseCreated(realtimeResponseId(event))
    deps.onProviderResponseStarted?.()
    deps.onStatus?.('speaking')

    return
  }

  if (type === 'response.done') {
    deps.onStatus?.('listening')
    const responseStatus = realtimeResponseStatus(event)

    const outcome = deps.turnController
      ? await deps.turnController.responseDone(
          realtimeResponseId(event),
          responseStatus
        )
      : { continued: false, settled: true }

    if (outcome.settled) {
      deps.onAssistantResponseDone?.()
    }

    deps.onProviderResponseEnded?.(responseStatus, outcome.continued)

    return
  }

  if (type === 'response.output_audio_transcript.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : ''

    if (delta) {
      deps.onAssistantTranscriptDelta?.(delta)
    }

    return
  }

  if (type === 'input_audio_buffer.speech_started') {
    deps.onUserSpeechStarted?.()
    deps.send({ type: 'response.cancel' })
    deps.turnController?.interrupt()
    deps.onStatus?.('listening')
    // Barge-in. `interrupt_response` stops the SERVER generating, but audio
    // already pushed over WebRTC is sitting in the browser's jitter/playback
    // buffer and would keep talking over the user. Only the WebRTC-specific
    // output_audio_buffer.clear flushes that tail — and only if the assistant
    // is actually speaking, since clearing an empty buffer is an API error.
    deps.clearAssistantAudio?.()

    return
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    deps.onUserSpeechEnded?.()

    return
  }

  if (type === 'output_audio_buffer.started') {
    deps.turnController?.assistantAudioStarted()
    deps.onAssistantAudioStarted?.()

    return
  }

  if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
    deps.turnController?.assistantAudioEnded()
    deps.onAssistantAudioEnded?.()

    return
  }

  if (type === 'input_audio_buffer.committed') {
    // Exactly one committed event per utterance, and it is the point where
    // transcription becomes in flight. `speech_stopped` is deliberately NOT
    // used too: both fire for the same utterance, so marking on each would
    // leave a permanently unbalanced counter.
    deps.pendingTranscription?.markPending()
    deps.turnController?.beginTurn()

    return
  }

  if (type === 'conversation.item.input_audio_transcription.failed') {
    deps.pendingTranscription?.settle()

    return
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const text = asTrimmedString(event.transcript)

    if (text) {
      deps.turnController?.updateGoal(text)
      const semanticTurnId = deps.turnController?.activeTurn()?.id

      deps.onTranscript?.({
        id: asTrimmedString(event.item_id),
        role: 'user',
        ...(semanticTurnId ? { semanticTurnId } : {}),
        text
      })
    }

    deps.pendingTranscription?.settle()

    return
  }

  if (type === 'response.output_audio_transcript.done') {
    const text = asTrimmedString(event.transcript)

    if (text) {
      const responseId = realtimeResponseId(event)

      deps.turnController?.assistantTranscriptDone(responseId, text)
      const semanticTurnId = deps.turnController?.turnIdForResponse(responseId)

      deps.onTranscript?.({
        id: asTrimmedString(event.item_id),
        role: 'assistant',
        ...(semanticTurnId ? { semanticTurnId } : {}),
        text
      })
    }

    return
  }

  if (type !== 'response.function_call_arguments.done') {
    return
  }

  const callId = asTrimmedString(event.call_id)
  const name = asTrimmedString(event.name)

  if (!callId) {
    return
  }

  const toolCall: RealtimeTurnToolCall = {
    arguments: asTrimmedString(event.arguments),
    callId,
    name,
    responseId: realtimeResponseId(event)
  }

  if (!deps.turnController) {
    return
  }

  deps.turnController.functionCallDone(toolCall)
}
