export interface RealtimeTranscript {
  id: string
  role: 'assistant' | 'user'
  text: string
}

export type RealtimeVoiceStatus = 'listening' | 'speaking'

export interface RealtimeServerEventDeps {
  beforeToolCall?: () => Promise<void>
  /** Flush assistant audio already buffered in the browser (barge-in). */
  clearAssistantAudio?: () => void
  onAssistantAudioEnded?: () => void
  onAssistantAudioStarted?: () => void
  onAssistantResponseDone?: () => void
  onAssistantTranscriptDelta?: (delta: string) => void
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
  pendingTranscription?: PendingTranscriptionTracker
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtimeSessionId: string
  send: (event: Record<string, unknown>) => void
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
  const markerAt = text.lastIndexOf(marker)
  const prefix = markerAt >= 0 ? text.slice(0, markerAt + marker.length) : ''
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
  expires_at?: number
  model: string
  voice: string
  /** Backend watcher ownership lets the client omit the duplicate visualize tool. */
  workbench_watcher?: {
    active: boolean
    pipeline: 'direct' | 'two_stage'
    owns_redraws: boolean
  }
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
  setMuted: (muted: boolean) => void
  /** Manual interrupt: cancel generation and flush buffered assistant audio. */
  stopTurn: () => void
  updateWorkbenchContext: (summary: string) => void
}

export interface StartRealtimeVoiceOptions {
  audioFactory?: () => HTMLAudioElement
  beforeToolCall?: () => Promise<void>
  fetchFn?: typeof fetch
  instructions?: string
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  onAssistantResponseDone?: () => void
  onAssistantTranscriptDelta?: (delta: string) => void
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
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
  // The audible seam. A function call ends the response, so anything said
  // BEFORE it becomes its own utterance and the user hears a gear change.
  // Observed in a real session, half of every reply was this throat-clearing:
  //   "Sure, let me pull together a simple visual and walk you through it."
  //   ...seam...
  //   "Yes. On the canvas, you've got a simple block diagram."
  // She cannot merge those turns, but she can skip the first one entirely.
  'Call your tools silently. Never narrate that you are about to do something — no "let me pull that up", no "give me a second", no "I\'ll sketch that out". Make the call without saying anything, then speak once with the actual answer. The announcement costs the user a whole extra turn and tells them nothing. ' +
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
  'Speak locations the way a person would — "the box on the far right" — and use focus to ring a node as you talk about it, so the user can see which one you mean. ' +
  // She narrated a five-step walkthrough without ever calling focus, so the
  // user heard a tour of a diagram with nothing lighting up. Focus is 9ms; it
  // is meant to be used mid-sentence, not announced.
  'Walking through several parts in turn is the main thing focus is for: ring each one as you reach it, so the canvas keeps pace with your voice. That is what makes a step-by-step explanation feel alive, and it costs nothing. ' +
  'During a walkthrough, say the node labels exactly as written in the workbench summary; the canvas follows those exact names while you keep speaking. ' +
  // Layout intent. Without this she has no way to answer a question about
  // arrangement and falls back to redrawing the same graph.
  'When the user asks about the SHAPE of the diagram rather than its content — "show me this linearly", "as a flow", "step by step", "top down" — say the desired arrangement clearly. That is a real canvas change, not a redraw of identical content.'

const VOICE_OWNED_REDRAW_INSTRUCTIONS =
  'You own full redraws in this session. Drawing is how you think here, so draw first: as soon as the conversation has a useful shape, call visualize silently and keep speaking. `status: drawing` means the update started, not that it finished; describe the idea while it appears and let the user confirm what they see.'

const WATCHER_OWNED_REDRAW_INSTRUCTIONS =
  'A background canvas worker owns every full redraw in this session. It listens to the conversation and updates the canvas independently while you keep speaking. The visualize tool is intentionally absent: do not call it, ask for it, or announce redraws. You still own the instant tools—focus, rename, connect, disconnect, remove, and go_back—and canvas changes arrive as appended semantic events in your context.'

/** Test seam: assert behavior contracts for the voice-owned fallback mode. */
export const REALTIME_INSTRUCTIONS_FOR_TESTS =
  `${DEFAULT_REALTIME_INSTRUCTIONS}\n\n${VOICE_OWNED_REDRAW_INSTRUCTIONS}`

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

const sessionUpdateEvent = (instructions: string, watcherOwnsRedraws = false) => ({
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
          'Draw or redraw the whole diagram via the mute diagrammer. Call it proactively — the user should never have to ask you to visualize. ' +
          'Use it for the FIRST drawing as soon as the conversation has a shape worth seeing, and afterwards whenever the structure genuinely changed: a new area of the problem, several new ideas at once, or a canvas that no longer matches what you are discussing. ' +
          'It takes a few seconds and regenerates everything, so for a single edit — one label, one link, dropping one box — use rename / connect / disconnect / remove instead, which are instant.',
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
          'Instantly add ONE link between two nodes that already exist. Use it for "those two are related", "the planner feeds the executor". If either end does not exist yet, describe the new structure plainly so the full-redraw owner can add it.',
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
    ].filter(tool => !(watcherOwnsRedraws && tool.name === 'visualize')),
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
  const watcherOwnsRedraws = token.workbench_watcher?.owns_redraws === true

  const configuredInstructions = options.instructions ?? DEFAULT_REALTIME_INSTRUCTIONS

  const ownershipInstructions = watcherOwnsRedraws
    ? WATCHER_OWNED_REDRAW_INSTRUCTIONS
    : VOICE_OWNED_REDRAW_INSTRUCTIONS

  const baseInstructions = `${configuredInstructions}\n\n${ownershipInstructions}`

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

  const send = (event: Record<string, unknown>) => channel.send(JSON.stringify(event))

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
      send(sessionUpdateEvent(instructions(), watcherOwnsRedraws))
    })
    channel.addEventListener('message', event => {
      try {
        const serverEvent = JSON.parse(event.data) as unknown

        void routeRealtimeServerEvent(serverEvent, {
          beforeToolCall: options.beforeToolCall,
          clearAssistantAudio,
          onAssistantAudioEnded: () => {
            assistantSpeaking = false
          },
          onAssistantAudioStarted: () => {
            assistantSpeaking = true
          },
          onAssistantResponseDone: options.onAssistantResponseDone,
          onAssistantTranscriptDelta: options.onAssistantTranscriptDelta,
          onStatus: options.onStatus,
          onTranscript: options.onTranscript,
          pendingTranscription,
          request: options.request,
          runtimeSessionId: options.runtimeSessionId,
          send
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
      send({ type: 'response.cancel' })
      clearAssistantAudio()
    },
    updateWorkbenchContext: summary => {
      workbenchContext = boundWorkbenchContext(summary)

      if (channelOpen && !closed) {
        send(sessionUpdateEvent(instructions(), watcherOwnsRedraws))
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
export const SURGICAL_TOOL_NAMES = ['focus', 'rename', 'connect', 'disconnect', 'remove'] as const

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
    deps.onStatus?.('speaking')

    return
  }

  if (type === 'response.done') {
    deps.onStatus?.('listening')
    // The response finished on its own, so nothing is left to flush.
    deps.onAssistantAudioEnded?.()
    deps.onAssistantResponseDone?.()

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
    deps.onStatus?.('listening')
    // Barge-in. `interrupt_response` stops the SERVER generating, but audio
    // already pushed over WebRTC is sitting in the browser's jitter/playback
    // buffer and would keep talking over the user. Only the WebRTC-specific
    // output_audio_buffer.clear flushes that tail — and only if the assistant
    // is actually speaking, since clearing an empty buffer is an API error.
    deps.clearAssistantAudio?.()

    return
  }

  if (type === 'output_audio_buffer.started') {
    deps.onAssistantAudioStarted?.()

    return
  }

  if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
    deps.onAssistantAudioEnded?.()

    return
  }

  if (type === 'input_audio_buffer.committed') {
    // Exactly one committed event per utterance, and it is the point where
    // transcription becomes in flight. `speech_stopped` is deliberately NOT
    // used too: both fire for the same utterance, so marking on each would
    // leave a permanently unbalanced counter.
    deps.pendingTranscription?.markPending()

    return
  }

  if (type === 'conversation.item.input_audio_transcription.failed') {
    deps.pendingTranscription?.settle()

    return
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const text = asTrimmedString(event.transcript)

    if (text) {
      deps.onTranscript?.({
        id: asTrimmedString(event.item_id),
        role: 'user',
        text
      })
    }

    deps.pendingTranscription?.settle()

    return
  }

  if (type === 'response.output_audio_transcript.done') {
    const text = asTrimmedString(event.transcript)

    if (text) {
      deps.onTranscript?.({
        id: asTrimmedString(event.item_id),
        role: 'assistant',
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

  let output: unknown

  try {
    if (name === 'session_snapshot') {
      // Reads stored state, so it must see the user's last sentence.
      await deps.beforeToolCall?.()
      output = await deps.request('artifact.list', { session_id: deps.runtimeSessionId })
    } else if (name === 'visualize') {
      let prompt = ''

      try {
        const parsed = JSON.parse(asTrimmedString(event.arguments) || '{}') as { prompt?: unknown }
        prompt = asTrimmedString(parsed.prompt).slice(0, 1_000)
      } catch {
        // Invalid optional arguments degrade to transcript-only visualization.
      }

      // FIRE AND FORGET. A full redraw measured ~9s on the running app, and
      // awaiting it froze the realtime turn for that entire time — the user
      // heard "let me walk through it visually", then ten seconds of silence.
      // The drawing reaches the canvas on its own via the `artifact.updated`
      // gateway event, so the model has no reason to wait for it before
      // carrying on talking.
      //
      // The transcription gate stays INSIDE the deferred work: the diagrammer
      // reads the durable transcript, and drawing before the user's last
      // sentence lands produces a diagram of the wrong conversation. Waiting
      // here costs nothing now that nobody is waiting on us.
      void (async () => {
        await deps.beforeToolCall?.()
        await deps.request('workbench.visualize', {
          session_id: deps.runtimeSessionId,
          prompt
        })
      })().catch(() => undefined)

      // Deliberately NOT a success claim: the redraw may still fail, and the
      // model must not announce a drawing that never arrived. `drawing` says
      // the request is under way and nothing more.
      output = { status: 'drawing' }
    } else {
      const surgical = surgicalToolRequest(name, asTrimmedString(event.arguments))

      if (surgical) {
        // Straight to persistence: no diagrammer, no multi-second redraw, and
        // deliberately NO transcription gate. These tools act on ids the model
        // already holds and never read the transcript, so gating them would
        // add a stall to the one path whose whole purpose is to feel instant.
        output = await deps.request(surgical.method, {
          session_id: deps.runtimeSessionId,
          ...surgical.params
        })
      } else if ((SURGICAL_TOOL_NAMES as readonly string[]).includes(name)) {
        output = { error: `${name} is missing required arguments` }
      } else {
        output = { error: `Unsupported voice tool: ${name || '<missing>'}` }
      }
    }
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) }
  }

  deps.send({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output)
    }
  })
  deps.send({ type: 'response.create' })
}
