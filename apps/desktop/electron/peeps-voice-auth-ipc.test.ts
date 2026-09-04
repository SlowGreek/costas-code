import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test, vi } from 'vitest'

import {
  authPage,
  createPeepsVoiceAuthHandlers,
  type PeepsVoiceAuthFlow,
  resolvePeepsVoiceAuthTlsPaths
} from './peeps-voice-auth-ipc'

class FakeResponse {
  body = ''
  headers: Record<string, string> = {}
  status: null | number = null

  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status
    this.headers = headers
    return this
  }

  end(body = '') {
    this.body = body
    return this
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false
  headers: Record<string, string>
  method: string
  url: string

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
  }

  destroy() {
    this.destroyed = true
    this.emit('aborted')
  }
}

interface FakeServer {
  close: ReturnType<typeof vi.fn>
  listen: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  onRequest: (req: FakeRequest, res: FakeResponse) => void
}

function createHarness(options: {
  openExternal?: (url: string) => Promise<void>
  readFile?: (path: string, encoding?: BufferEncoding) => string | Buffer
  tlsPaths?: () => { certificatePath?: string; keyPath?: string }
} = {}) {
  const servers: FakeServer[] = []
  const created: Array<{ cert: Buffer | string; key: Buffer | string }> = []
  const openExternal = options.openExternal ?? vi.fn(async () => {})
  const readFile =
    options.readFile ??
    vi.fn((filePath: string) =>
      filePath.endsWith('.js') ? 'console.log("local-only-script")' : 'pem-data'
    )
  const tlsPaths =
    options.tlsPaths ??
    (() => ({ certificatePath: '/tls/localhost-cert.pem', keyPath: '/tls/localhost-key.pem' }))

  const handlers = createPeepsVoiceAuthHandlers({
    appPath: () => '/app',
    createServer: ((options, onRequest) => {
      created.push({ cert: options.cert, key: options.key })
      let errorHandler: ((error: Error) => void) | undefined
      const server: FakeServer = {
        close: vi.fn(),
        listen: vi.fn((_port: number, host: string, resolve: () => void) => {
          assert.equal(host, '127.0.0.1')
          resolve()
          return server
        }),
        once: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === 'error') {
            errorHandler = handler
          }
          return server
        }),
        onRequest
      }
      ;(server as FakeServer & { emitError: (error: Error) => void }).emitError = error => {
        errorHandler?.(error)
      }
      servers.push(server)
      return server as never
    }) as never,
    existsSync: () => true,
    openExternal,
    readFile,
    tlsPaths
  })

  return { created, handlers, openExternal, readFile, servers }
}

const flow: PeepsVoiceAuthFlow = {
  authority: 'https://login.microsoftonline.com/organizations',
  clientId: 'client-id',
  redirectUri: 'https://localhost:8080/',
  scope: 'https://peeps.asgprototype.com/api/access-as-user',
  state: 'state-123'
}

test('auth page uses local-only scripts and a restrictive CSP', () => {
  const html = authPage()

  assert.match(html, /Content-Security-Policy/i)
  assert.match(html, /script-src 'self'/)
  assert.match(html, /connect-src https:\/\/localhost:8080 https:\/\/login\.microsoftonline\.com/)
  assert.doesNotMatch(html, /script-src 'unsafe-inline'/)
  assert.match(html, /<script src="\/peeps-voice-auth-page\.js"><\/script>/)
})

test('start serves only the exact auth page paths and relays a valid callback once', async () => {
  const harness = createHarness()

  await handlersStart(harness, 'auth-1')
  const wait = harness.handlers.wait('auth-1', 5_000)

  const htmlRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('GET', '/'), htmlRes)
  assert.equal(htmlRes.status, 200)
  assert.match(htmlRes.body, /Signing in/)
  assert.match(htmlRes.body, /"state":"state-123"/)

  const jsRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('GET', '/peeps-voice-auth-page.js'), jsRes)
  assert.equal(jsRes.status, 200)
  assert.match(jsRes.body, /local-only-script/)

  const callbackRes = new FakeResponse()
  const callbackReq = new FakeRequest('POST', '/', { origin: 'https://localhost:8080' })
  harness.servers[0].onRequest(callbackReq, callbackRes)
  callbackReq.emit('data', JSON.stringify({ state: 'state-123', token: 'peeps-bearer' }))
  callbackReq.emit('end')

  assert.equal(callbackRes.status, 204)
  assert.equal(await wait, 'peeps-bearer')

  const replayRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('GET', '/unexpected'), replayRes)
  assert.equal(replayRes.status, 404)
})

test('invalid origin state method and oversized body fail closed without echoing tokens', async () => {
  const harness = createHarness()

  await handlersStart(harness, 'auth-2')
  const waitWrongOrigin = harness.handlers.wait('auth-2', 5_000)
  const wrongOriginRes = new FakeResponse()
  harness.servers[0].onRequest(
    new FakeRequest('POST', '/', { origin: 'https://example.com' }),
    wrongOriginRes
  )
  assert.equal(wrongOriginRes.status, 400)
  assert.equal(await waitWrongOrigin, null)

  await handlersStart(harness, 'auth-3')
  const waitWrongState = harness.handlers.wait('auth-3', 5_000)
  const wrongStateRes = new FakeResponse()
  const wrongStateReq = new FakeRequest('POST', '/', { origin: 'https://localhost:8080' })
  harness.servers[1].onRequest(wrongStateReq, wrongStateRes)
  wrongStateReq.emit('data', JSON.stringify({ state: 'other', token: 'secret-token' }))
  wrongStateReq.emit('end')
  assert.equal(wrongStateRes.status, 400)
  assert.equal(await waitWrongState, null)

  await handlersStart(harness, 'auth-4')
  const waitOversized = harness.handlers.wait('auth-4', 5_000)
  const oversizedRes = new FakeResponse()
  const oversizedReq = new FakeRequest('POST', '/', { origin: 'https://localhost:8080' })
  harness.servers[2].onRequest(oversizedReq, oversizedRes)
  oversizedReq.emit('data', 'x'.repeat(16_385))
  assert.equal(oversizedRes.status, 413)
  assert.equal(await waitOversized, null)

  await handlersStart(harness, 'auth-5')
  const waitWrongMethod = harness.handlers.wait('auth-5', 5_000)
  const wrongMethodRes = new FakeResponse()
  harness.servers[3].onRequest(new FakeRequest('PUT', '/'), wrongMethodRes)
  assert.equal(wrongMethodRes.status, 404)
  assert.equal(await waitWrongMethod, null)
})

test('start cleanup is fail-closed for openExternal failure and a newer start cancels the prior listener', async () => {
  const openExternal = vi
    .fn<(_: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('browser failed'))
    .mockResolvedValue(undefined)
  const harness = createHarness({ openExternal })

  await assert.rejects(() => handlersStart(harness, 'first'), /browser failed/)
  assert.equal(harness.servers[0].close.mock.calls.length, 1)

  await handlersStart(harness, 'second')
  const firstWait = harness.handlers.wait('second', 5_000)
  await handlersStart(harness, 'third')
  assert.equal(await firstWait, null)
  assert.equal(harness.servers[1].close.mock.calls.length, 1)
})

test('wait timeout and cancel both close the one-shot listener', async () => {
  vi.useFakeTimers()
  try {
    const harness = createHarness()
    await handlersStart(harness, 'timeout')
    const wait = harness.handlers.wait('timeout', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    assert.equal(await wait, null)
    assert.equal(harness.servers[0].close.mock.calls.length, 1)

    await handlersStart(harness, 'cancel')
    assert.equal(harness.handlers.cancel('cancel'), true)
    assert.equal(harness.servers[1].close.mock.calls.length, 1)
  } finally {
    vi.useRealTimers()
  }
})

test('resolvePeepsVoiceAuthTlsPaths keeps certs machine-local under Electron userData', () => {
  assert.deepEqual(resolvePeepsVoiceAuthTlsPaths('/Users/test/Library/Application Support/Catalyst'), {
    certificatePath:
      '/Users/test/Library/Application Support/Catalyst/peeps-voice-auth/localhost-cert.pem',
    keyPath:
      '/Users/test/Library/Application Support/Catalyst/peeps-voice-auth/localhost-key.pem'
  })
})

async function handlersStart(
  harness: ReturnType<typeof createHarness>,
  id: string,
  nextFlow: PeepsVoiceAuthFlow = flow
) {
  return harness.handlers.start(id, nextFlow)
}
