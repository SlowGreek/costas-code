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

interface RealtimeTokenResponse {
  client_secret: string
  expires_at?: number
  model: string
  voice: string
  /** Host that issued the secret; Azure secrets are not valid at OpenAI. */
  webrtc_url?: string
}

export interface RealtimeVoiceConnection {
  /** Settles when in-flight input transcriptions have landed. */
  awaitPendingTranscription: (timeoutMs?: number) => Promise<void>
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
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
  peerConnectionFactory?: () => RTCPeerConnection
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtimeSessionId: string
}

const DEFAULT_REALTIME_INSTRUCTIONS =
  'You are Hermes in realtime ideation mode. Collaborate naturally and concisely. ' +
  'You may be joining a conversation already in progress: earlier turns and the current workbench state are given to you as context. ' +
  'Continue from there — do not greet the user as if meeting them, and do not re-summarise what was already said unless asked. ' +
  'The canvas is the point of this mode: the user should not have to ask you to draw. ' +
  'If there is no diagram yet and the conversation has any shape worth seeing — a set of parts, a sequence, a comparison, a system — call visualize WITHOUT being asked. ' +
  'After that, keep it current: call visualize when the structure genuinely changes, and use the instant surgical tools (rename / connect / disconnect / remove / focus) for single edits. ' +
  'A stale or missing canvas is a failure; asking permission to draw is worse than drawing. ' +
  'Use session_snapshot before explaining or referring to the workbench canvas. ' +
  'Do not claim the canvas changed unless the visualize result or Hermes state confirms it. ' +
  // Deixis. This is the line that makes the shared referent real: without it
  // the model has the selection in context and still asks "which one?".
  'The workbench summary tells you where each node sits on screen in plain terms ' +
  '("upper left", "centre", "far right", and neighbours like "left of: Planner"), ' +
  'and `pointing_at` is the node the user has just clicked — the user is literally pointing at it. ' +
  'When the user says "this one", "that one", "it", "this box", or "that", they mean `pointing_at`; ' +
  'resolve it to that node id silently and act, do NOT ask which one they mean. ' +
  'If `pointing_at` is null they are not pointing at anything, so fall back to the spatial ' +
  'descriptions to work out what "the one on the left" refers to, and ask only if it is genuinely ambiguous. ' +
  'Speak these locations the way a person would ("the box on the far right"); never read out coordinates.'

/**
 * Server-side turn taking. Sent on every `session.update` so a later context
 * update can never silently drop barge-in if the API replaces (rather than
 * merges) the session object.
 */
const REALTIME_AUDIO_CONFIG = {
  input: {
    turn_detection: {
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: true,
      interrupt_response: true
    }
  }
}

const sessionUpdateEvent = (instructions: string) => ({
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
          'It takes a few seconds and regenerates everything, so for a single edit — one label, one link, dropping one box, pointing at something — use rename / connect / disconnect / remove / focus instead, which are instant.',
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
          'Instantly centre and highlight ONE existing node so the user can see which one you mean. Use it whenever you talk about a specific box ("the planner here"). Changes nothing about the ideas themselves. Never call visualize for this.',
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
          'Instantly add ONE link between two nodes that already exist. Use it for "those two are related", "the planner feeds the executor". If either end does not exist yet, that is new structure — use visualize instead.',
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
    ],
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

  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })

  const tracks = stream.getTracks()
  const channel = peer.createDataChannel('oai-events')
  const baseInstructions = options.instructions ?? DEFAULT_REALTIME_INSTRUCTIONS
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
      send(sessionUpdateEvent(instructions()))
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
      workbenchContext = summary.trim().slice(0, 4_000)

      if (channelOpen && !closed) {
        send(sessionUpdateEvent(instructions()))
      }
    }
  }
}

type RealtimeEvent = {
  arguments?: unknown
  call_id?: unknown
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
    await deps.beforeToolCall?.()

    if (name === 'session_snapshot') {
      output = await deps.request('artifact.list', { session_id: deps.runtimeSessionId })
    } else if (name === 'visualize') {
      let prompt = ''

      try {
        const parsed = JSON.parse(asTrimmedString(event.arguments) || '{}') as { prompt?: unknown }
        prompt = asTrimmedString(parsed.prompt).slice(0, 1_000)
      } catch {
        // Invalid optional arguments degrade to transcript-only visualization.
      }

      output = await deps.request('workbench.visualize', {
        session_id: deps.runtimeSessionId,
        prompt
      })
    } else {
      const surgical = surgicalToolRequest(name, asTrimmedString(event.arguments))

      if (surgical) {
        // Straight to persistence: no diagrammer, no multi-second redraw.
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
