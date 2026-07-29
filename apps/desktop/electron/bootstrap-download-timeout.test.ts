import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'vitest'

import { httpGetBuffer } from './bootstrap-runner'

/**
 * Regression: the anonymous install-script download had no timeout of any kind.
 *
 * `https.get()` with no timeout never errors when a corporate proxy or firewall
 * accepts the connection and then silently drops the traffic — a very common
 * shape on managed enterprise networks. The promise simply never settles, so
 * bootstrap sits at "fetching manifest" forever: no rejection means no `gh`
 * fallback, no failed event, no boot error, and no Retry/Repair surface for the
 * user to escape with.
 *
 * These tests inject a fake `get` so the hang is reproduced deterministically
 * without needing a real black-holed socket.
 */

/** A request that connects and then does absolutely nothing, forever. */
function silentlyDroppingGet() {
  const calls: any[] = []

  const get = (_url: string, _cb: (res: any) => void) => {
    const req: any = new EventEmitter()
    req.destroyed = false
    req.destroy = () => {
      req.destroyed = true
    }
    // Emulate Node's semantics: setTimeout actually schedules the callback
    // against an idle socket. The fake never delivers a response, so the
    // timer is what must rescue the promise.
    req.setTimeout = (ms: number, cb: () => void) => {
      req.timer = setTimeout(cb, ms)

      return req
    }
    calls.push(req)

    // Never invokes the response callback, never emits 'error'.
    return req
  }

  return { get, calls }
}

test('a silently-dropped connection rejects instead of hanging forever', async () => {
  const { get } = silentlyDroppingGet()

  await assert.rejects(
    () => httpGetBuffer('https://example.invalid/x', 1, { timeoutMs: 50, get: get as any }),
    /timed out/i,
    'a connection that never responds must reject so the caller can fall back to gh or surface an error'
  )
})

test('the timed-out request is destroyed so the socket is not leaked', async () => {
  const { get, calls } = silentlyDroppingGet()

  await assert.rejects(() =>
    httpGetBuffer('https://example.invalid/x', 1, { timeoutMs: 50, get: get as any })
  )

  assert.equal(calls.length, 1, 'expected exactly one request attempt')
  assert.equal(calls[0].destroyed, true, 'the request must be destroyed on timeout')
})

test('a normal successful response still resolves with the body', async () => {
  const get = (_url: string, cb: (res: any) => void) => {
    const req: any = new EventEmitter()
    req.destroy = () => {}
    req.setTimeout = () => req

    const res: any = new EventEmitter()
    res.statusCode = 200
    res.resume = () => {}

    setImmediate(() => {
      cb(res)
      res.emit('data', Buffer.from('hello '))
      res.emit('data', Buffer.from('world'))
      res.emit('end')
    })

    return req
  }

  const body = await httpGetBuffer('https://example.invalid/x', 1, {
    timeoutMs: 5_000,
    get: get as any
  })

  assert.equal(body.toString(), 'hello world')
})

test('a non-200 response still rejects with a status-bearing error', async () => {
  const get = (_url: string, cb: (res: any) => void) => {
    const req: any = new EventEmitter()
    req.destroy = () => {}
    req.setTimeout = () => req

    const res: any = new EventEmitter()
    res.statusCode = 404
    res.resume = () => {}

    setImmediate(() => cb(res))

    return req
  }

  await assert.rejects(
    () => httpGetBuffer('https://example.invalid/x', 1, { timeoutMs: 5_000, get: get as any }),
    (err: any) => {
      assert.equal(err.status, 404, 'status must survive so the gh fallback can trigger on 404/403')

      return true
    }
  )
})
