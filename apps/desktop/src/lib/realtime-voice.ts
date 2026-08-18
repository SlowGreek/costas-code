export interface RealtimeTranscript {
  id: string
  role: 'assistant' | 'user'
  text: string
}

export type RealtimeVoiceStatus = 'listening' | 'speaking'

export interface RealtimeServerEventDeps {
  onStatus?: (status: RealtimeVoiceStatus) => void
  onTranscript?: (entry: RealtimeTranscript) => void
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtimeSessionId: string
  send: (event: Record<string, unknown>) => void
}

interface RealtimeTokenResponse {
  client_secret: string
  expires_at?: number
  model: string
  voice: string
}

export interface RealtimeVoiceConnection {
  close: () => void
  setMuted: (muted: boolean) => void
}

export interface StartRealtimeVoiceOptions {
  audioFactory?: () => HTMLAudioElement
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
  'Use session_snapshot before explaining or referring to the workbench canvas. ' +
  'Do not claim the canvas changed unless Hermes state confirms it.'

const sessionUpdateEvent = (instructions: string) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    instructions,
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
  let closed = false

  const send = (event: Record<string, unknown>) => channel.send(JSON.stringify(event))

  const close = () => {
    if (closed) {
      return
    }

    closed = true
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
      send(sessionUpdateEvent(options.instructions ?? DEFAULT_REALTIME_INSTRUCTIONS))
    })
    channel.addEventListener('message', event => {
      try {
        const serverEvent = JSON.parse(event.data) as unknown

        void routeRealtimeServerEvent(serverEvent, {
          onStatus: options.onStatus,
          onTranscript: options.onTranscript,
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

    const response = await fetchFn('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: ['Bearer', token.client_secret].join(' '),
        'Content-Type': 'application/sdp'
      }
    })

    if (!response.ok) {
      throw new Error(`OpenAI Realtime WebRTC negotiation failed (HTTP ${response.status})`)
    }

    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
  } catch (error) {
    close()
    throw error
  }

  return {
    close,
    setMuted: muted => {
      tracks.forEach(track => {
        track.enabled = !muted
      })
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

  if (type === 'response.done' || type === 'input_audio_buffer.speech_started') {
    deps.onStatus?.('listening')

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

  if (name === 'session_snapshot') {
    output = await deps.request('artifact.list', { session_id: deps.runtimeSessionId })
  } else {
    output = { error: `Unsupported voice tool: ${name || '<missing>'}` }
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
