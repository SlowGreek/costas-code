#!/usr/bin/env node

import { executeLifecycle } from './desktop-lifecycle.mjs'

const op = process.argv[2]
const rawTimeout = process.env.HERMES_DESKTOP_LIFECYCLE_TIMEOUT_MS
const timeoutMs = rawTimeout ? Number(rawTimeout) : 30_000

try {
  const result = await executeLifecycle(op, { timeoutMs })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema: 'catalyst-desktop-lifecycle-error/1',
    op: typeof op === 'string' ? op : null,
    code: error instanceof Error ? error.message.slice(0, 512) : 'desktop-lifecycle-error'
  })}\n`)
  process.exitCode = 1
}
