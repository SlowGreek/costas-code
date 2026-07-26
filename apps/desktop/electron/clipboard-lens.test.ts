import { describe, expect, it } from 'vitest'

import {
  buildClipboardLensSnapshot,
  type ClipboardLensCapture,
  consumeClipboardLensText,
  MAX_CLIPBOARD_LENS_BYTES,
  MAX_CLIPBOARD_TEXT_PREVIEW_BYTES
} from './clipboard-lens'

const capture = (text = 'hello clipboard'): ClipboardLensCapture => ({ text })

describe('explicit text-only clipboard lens snapshot', () => {
  it('compiles admitted text into a bounded ephemeral identity', () => {
    expect(buildClipboardLensSnapshot(capture())).toEqual({
      schema: 'hermes-clipboard-lens/1',
      authority: 'none',
      history: 'off',
      invocation: 'explicit-user-action',
      retention: 'ephemeral',
      revocable: true,
      state: 'ready',
      media: 'text',
      byte_length: 15,
      content_hash: 'sha256:65b2b576750477c2424fc19794e6c3c5ac6821e29e8464294aed6aa8485304c2',
      sensitivity: 'admitted',
      text_preview: 'hello clipboard'
    })
  })

  it.each([
    '4111 1111 1111 1111',
    'sk-abcdefghijklmnopqrstuvwxyz1234567890',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    'password = correct-horse-battery-staple'
  ])('withholds sensitive text before renderer projection: %s', secret => {
    const result = buildClipboardLensSnapshot(capture(secret))

    expect(result).toMatchObject({
      state: 'refused',
      media: 'text',
      sensitivity: 'withheld',
      reason_code: 'sensitive-content'
    })
    expect(result).not.toHaveProperty('text_preview')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('returns a closed empty snapshot without inventing identity', () => {
    expect(buildClipboardLensSnapshot(capture(''))).toEqual({
      schema: 'hermes-clipboard-lens/1',
      authority: 'none',
      history: 'off',
      invocation: 'explicit-user-action',
      retention: 'ephemeral',
      revocable: true,
      state: 'empty',
      media: 'unknown',
      sensitivity: 'admitted'
    })
  })

  it('admits exactly 262,144 UTF-8 bytes and refuses 262,145 without truncation', () => {
    const atBound = buildClipboardLensSnapshot(capture('x'.repeat(MAX_CLIPBOARD_LENS_BYTES)))
    const overBound = buildClipboardLensSnapshot(capture('x'.repeat(MAX_CLIPBOARD_LENS_BYTES + 1)))

    expect(atBound).toMatchObject({ state: 'ready', byte_length: MAX_CLIPBOARD_LENS_BYTES })
    expect(overBound).toMatchObject({
      state: 'refused',
      byte_length: MAX_CLIPBOARD_LENS_BYTES + 1,
      reason_code: 'payload-overflow'
    })
    expect(overBound).not.toHaveProperty('text_preview')
  })

  it('bounds preview by UTF-8 bytes without splitting a code point or changing identity length', () => {
    const text = `prefix-${'🦊'.repeat(MAX_CLIPBOARD_TEXT_PREVIEW_BYTES)}`
    const result = buildClipboardLensSnapshot(capture(text))

    expect(result.state).toBe('ready')

    if (result.state !== 'ready') {
      throw new Error('expected ready preview snapshot')
    }

    expect(Buffer.byteLength(result.text_preview, 'utf8')).toBeLessThanOrEqual(MAX_CLIPBOARD_TEXT_PREVIEW_BYTES)
    expect(result.text_preview).toMatch(/…$/)
    expect(result.byte_length).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('consumes text only when the current clipboard is admitted and hash-bound', () => {
    const snapshot = buildClipboardLensSnapshot(capture())

    expect(snapshot.state).toBe('ready')

    if (snapshot.state !== 'ready') {
      throw new Error('expected ready text snapshot')
    }

    expect(consumeClipboardLensText(capture(), snapshot.content_hash)).toEqual({ ok: true, text: 'hello clipboard' })
    expect(consumeClipboardLensText(capture('changed'), snapshot.content_hash)).toEqual({
      ok: false,
      code: 'clipboard-changed'
    })
    expect(consumeClipboardLensText(capture('password = secret-value'), snapshot.content_hash)).toEqual({
      ok: false,
      code: 'clipboard-refused'
    })
  })
})
