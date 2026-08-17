import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { test } from 'vitest'

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('desktop backend startup leaves LUCID role selection explicit', () => {
  assert.doesNotMatch(mainSource, /HERMES_LUCID_ROLE\s*:/)
})
