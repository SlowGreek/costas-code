import { createHash } from 'node:crypto'

export const CLIPBOARD_LENS_SCHEMA = 'hermes-clipboard-lens/1' as const
export const MAX_CLIPBOARD_LENS_BYTES = 262_144
export const MAX_CLIPBOARD_TEXT_PREVIEW_BYTES = 8_192

export interface ClipboardLensCapture {
  text: string
}

interface ClipboardLensBase {
  schema: typeof CLIPBOARD_LENS_SCHEMA
  authority: 'none'
  history: 'off'
  invocation: 'explicit-user-action'
  retention: 'ephemeral'
  revocable: true
  media: 'text' | 'unknown'
  sensitivity: 'admitted' | 'withheld'
}

export type ClipboardLensSnapshot =
  | (ClipboardLensBase & { state: 'empty' })
  | (ClipboardLensBase & {
      state: 'refused'
      byte_length: number
      content_hash: `sha256:${string}`
      reason_code: 'payload-overflow' | 'sensitive-content'
    })
  | (ClipboardLensBase & {
      state: 'ready'
      byte_length: number
      content_hash: `sha256:${string}`
      text_preview: string
    })

export type ClipboardLensConsumeError = {
  ok: false
  code: 'clipboard-changed' | 'clipboard-refused'
}

const BASE = {
  schema: CLIPBOARD_LENS_SCHEMA,
  authority: 'none',
  history: 'off',
  invocation: 'explicit-user-action',
  retention: 'ephemeral',
  revocable: true
} as const

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
const TOKEN_RE = /\b(?:sk|pk|gh[opusr]|glpat|xox[baprs])-?[A-Za-z0-9_-]{24,}\b/
const ASSIGNED_SECRET_RE = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\b\s*[:=]\s*\S{8,}/i
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g

const sha256 = (bytes: Buffer): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function passesLuhn(digits: string): boolean {
  let sum = 0
  let doubleDigit = false

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])

    if (doubleDigit) {
      digit *= 2

      if (digit > 9) {
        digit -= 9
      }
    }

    sum += digit
    doubleDigit = !doubleDigit
  }

  return sum % 10 === 0
}

function knownCardPrefix(digits: string): boolean {
  const two = Number(digits.slice(0, 2))
  const three = Number(digits.slice(0, 3))
  const four = Number(digits.slice(0, 4))

  return (
    digits.startsWith('4') ||
    two === 34 ||
    two === 37 ||
    (two >= 51 && two <= 55) ||
    (four >= 2221 && four <= 2720) ||
    four === 6011 ||
    (three >= 644 && three <= 649) ||
    two === 65
  )
}

function containsPaymentCard(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    const digits = match[0].replace(/\D/g, '')

    if (digits.length >= 13 && digits.length <= 19 && knownCardPrefix(digits) && passesLuhn(digits)) {
      return true
    }
  }

  return false
}

export function containsSensitiveClipboardText(text: string): boolean {
  return (
    PRIVATE_KEY_RE.test(text) ||
    TOKEN_RE.test(text) ||
    ASSIGNED_SECRET_RE.test(text) ||
    containsPaymentCard(text)
  )
}

function utf8Preview(text: string): string {
  const bytes = Buffer.from(text, 'utf8')

  if (bytes.length <= MAX_CLIPBOARD_TEXT_PREVIEW_BYTES) {
    return text
  }

  const ellipsis = Buffer.from('…', 'utf8')
  let end = MAX_CLIPBOARD_TEXT_PREVIEW_BYTES - ellipsis.length

  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1
  }

  return Buffer.concat([bytes.subarray(0, end), ellipsis]).toString('utf8')
}

export function buildClipboardLensSnapshot(capture: ClipboardLensCapture): ClipboardLensSnapshot {
  const text = String(capture.text || '')
  const bytes = Buffer.from(text, 'utf8')

  if (bytes.length === 0) {
    return { ...BASE, state: 'empty', media: 'unknown', sensitivity: 'admitted' }
  }

  const identity = { byte_length: bytes.length, content_hash: sha256(bytes) }

  if (bytes.length > MAX_CLIPBOARD_LENS_BYTES) {
    return {
      ...BASE,
      ...identity,
      state: 'refused',
      media: 'text',
      sensitivity: 'withheld',
      reason_code: 'payload-overflow'
    }
  }

  if (containsSensitiveClipboardText(text)) {
    return {
      ...BASE,
      ...identity,
      state: 'refused',
      media: 'text',
      sensitivity: 'withheld',
      reason_code: 'sensitive-content'
    }
  }

  return {
    ...BASE,
    ...identity,
    state: 'ready',
    media: 'text',
    sensitivity: 'admitted',
    text_preview: utf8Preview(text)
  }
}

export function consumeClipboardLensText(
  capture: ClipboardLensCapture,
  expectedHash: string
): ClipboardLensConsumeError | { ok: true; text: string } {
  const snapshot = buildClipboardLensSnapshot(capture)

  if (snapshot.state !== 'ready') {
    return { ok: false, code: 'clipboard-refused' }
  }

  if (snapshot.content_hash !== expectedHash) {
    return { ok: false, code: 'clipboard-changed' }
  }

  return { ok: true, text: capture.text }
}
