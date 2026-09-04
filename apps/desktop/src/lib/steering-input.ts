export interface SteeringReceipt {
  message_id?: string
  turn_id?: string | null
  status:
    | 'active'
    | 'idle'
    | 'pending'
    | 'committed'
    | 'accepted'
    | 'cancelled'
    | 'recoverable'
    | 'stale'
    | 'unsupported'
    | 'conflict'
    | 'invalid'
    | 'full'
    | 'unknown'
}

export function parseSteeringReceipt(value: unknown): SteeringReceipt | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const receipt = value as SteeringReceipt

  if (
    typeof receipt.message_id !== 'string' ||
    typeof receipt.turn_id !== 'string' ||
    !['pending', 'committed', 'accepted', 'cancelled', 'recoverable', 'unknown'].includes(receipt.status)
  ) {
    return undefined
  }

  return receipt
}

/** A late acceptance reply cannot undo a committed/cancelled event. */
export function mergeSteeringReceipt(previous: SteeringReceipt | undefined, next: SteeringReceipt): SteeringReceipt {
  if (
    previous &&
    ['committed', 'cancelled', 'recoverable'].includes(previous.status) &&
    ['unknown', 'pending', 'accepted'].includes(next.status)
  ) {
    return previous
  }

  return next
}

export interface SteeringAttempt {
  session_id: string
  message_id: string
  text: string
  turn_id?: string
  images?: string[]
}

const ATTEMPTS_KEY = 'hermes.steering.attempts.v1'

function storedAttempts(): Record<string, SteeringAttempt> {
  const raw = localStorage.getItem(ATTEMPTS_KEY)
  if (!raw) {
    return {}
  }
  if (raw.length > 1_000_000) {
    throw new Error('Pending steering storage exceeds its limit')
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pending steering storage')
  }
  return parsed as Record<string, SteeringAttempt>
}

export function readSteeringAttempt(key: string): SteeringAttempt | undefined {
  const value = storedAttempts()[key]
  if (
    !value ||
    typeof value.session_id !== 'string' ||
    typeof value.message_id !== 'string' ||
    typeof value.text !== 'string' ||
    (value.turn_id !== undefined && typeof value.turn_id !== 'string') ||
    (value.images !== undefined && (!Array.isArray(value.images) || value.images.some(p => typeof p !== 'string')))
  ) {
    return undefined
  }
  return value
}

export function rememberSteeringAttempt(key: string, attempt: SteeringAttempt): void {
  const values = storedAttempts()
  if (!Object.hasOwn(values, key) && Object.keys(values).length >= 64) {
    throw new Error('Too many unresolved steering messages')
  }
  const serialized = JSON.stringify({ ...values, [key]: attempt })
  if (serialized.length > 1_000_000) {
    throw new Error('Pending steering storage exceeds its limit')
  }
  localStorage.setItem(ATTEMPTS_KEY, serialized)
}

export function forgetSteeringAttempt(key: string): void {
  const values = storedAttempts()
  delete values[key]
  localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(values))
}

type Request = <T>(method: string, params: Record<string, unknown>) => Promise<T>

/** Capture target before asynchronous staging. A lost write reply is NOT a rejection. */
export async function sendSteeringInput(
  request: Request,
  payload: SteeringAttempt,
  stageImages: () => Promise<string[]> = async () => [],
  persistAttempt: (attempt: SteeringAttempt) => void = () => {}
): Promise<SteeringReceipt> {
  let target: SteeringReceipt

  try {
    target = payload.turn_id
      ? { status: 'active', turn_id: payload.turn_id }
      : await request<SteeringReceipt>('session.input.status', { session_id: payload.session_id })
  } catch (error) {
    // An old backend cannot safely emulate steer with an aborting redirect.
    if ((error as { code?: number })?.code === -32601) {
      return { status: 'unsupported' }
    }
    throw error
  }

  if (!target.turn_id || target.status !== 'active') {
    return { status: target.status === 'unsupported' ? 'unsupported' : 'stale' }
  }

  payload.turn_id = target.turn_id
  const images = payload.images ?? (await stageImages())
  payload.images = images
  persistAttempt(payload)

  const params = {
    session_id: payload.session_id,
    message_id: payload.message_id,
    text: payload.text,
    turn_id: payload.turn_id,
    ...(images.length ? { images } : {})
  }

  const valid = (receipt: SteeringReceipt | undefined) =>
    Boolean(
      receipt &&
      receipt.message_id === payload.message_id &&
      receipt.turn_id === target.turn_id &&
      [
        'pending',
        'committed',
        'accepted',
        'cancelled',
        'recoverable',
        'stale',
        'unsupported',
        'conflict',
        'invalid',
        'full'
      ].includes(receipt.status)
    )

  try {
    const receipt = await request<SteeringReceipt>('session.input', params)

    if (!valid(receipt)) {
      throw new Error('Steering delivery is unknown')
    }

    return receipt
  } catch (error) {
    const receipt = await request<SteeringReceipt>('session.input.status', {
      session_id: payload.session_id,
      message_id: payload.message_id
    })

    if (valid(receipt)) {
      return receipt
    }
    // Caller restores the draft and marks delivery unknown. No next-turn
    // enqueue, no resend under a fresh ID, no retarget to a recovered session.
    throw error
  }
}
