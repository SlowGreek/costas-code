import { beforeEach, expect, it } from 'vitest'

import { forgetSteeringAttempt, readSteeringAttempt, rememberSteeringAttempt } from './steering-input'

beforeEach(() => localStorage.removeItem('hermes.steering.attempts.v1'))

it('restores the original uncertain turn and message IDs from browser storage', () => {
  const attempt = { session_id: 's', message_id: 'm', turn_id: 't', text: 'Correction', images: ['x.png'] }
  rememberSteeringAttempt('key', attempt)
  const restored = readSteeringAttempt('key')
  expect(restored).toEqual(attempt)
  expect(restored).not.toBe(attempt)
  forgetSteeringAttempt('key')
  expect(readSteeringAttempt('key')).toBeUndefined()
})

it('ignores malformed stored attempts rather than routing them', () => {
  localStorage.setItem('hermes.steering.attempts.v1', JSON.stringify({ key: { message_id: 'm' } }))
  expect(readSteeringAttempt('key')).toBeUndefined()
})
