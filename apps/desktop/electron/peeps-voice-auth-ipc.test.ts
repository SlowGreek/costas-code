import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import { test, vi } from 'vitest'

import {
  authPage,
  createPeepsVoiceAuthHandlers,
  loadValidatedPeepsVoiceAuthTlsMaterial,
  type PeepsVoiceAuthFlow,
  resolvePeepsVoiceAuthTlsPaths
} from './peeps-voice-auth-ipc'

const VALID_LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUQ2XfgKQw6kdxURujHC6A/zHs1VIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwNDAxMDgyMFoXDTM2MDkw
MTAxMDgyMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAulc9SleIYC+sYCKbrEXawgXTotgZPBQZndh3OPmcHPEW
EUqh6A1sLOtEh6//brdu8Qk5Ptu38Vd127pQ8NrF+B/kMbf24HYiWAGBSEoysexY
nI7LqHUuddT7XOBuzba3aqyD5CJ7mDCQzciLcJN6BZXdKIVMwjJtFdHNW24MFCku
P2V85AAPtmbbP+F3jJh/00nwUQvuG/PMcv3fGtYKe/8QJiLkHNG7Tiqu6X+vkEfm
Six1rj+aPec+rLEmviMb3ehnl8VzZDc7XMzMH82Gucs7r1GlHe1t6gcwjtltDWeM
htQdcgkp1PIcu+PMsz2n+SyBuRfotTIxP4F2muLbIwIDAQABo2QwYjAUBgNVHREE
DTALgglsb2NhbGhvc3QwCQYDVR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAww
CgYIKwYBBQUHAwEwHQYDVR0OBBYEFMhG/8rALuUBUCv9FKypehdStevpMA0GCSqG
SIb3DQEBCwUAA4IBAQAj48GqiTmqHPA/cLY3wxIUYWtOqVlKxalW450H3zGQWDBl
XYdL/OasB2AAYC9YdAKajrC5TxG2BHbyap6vz5ebFl6cqcEpXKX49kKsKiqYkWFU
zUQBh2iL4sEwIdWlq7u1tL6mT48dLc8Bmss1e+rOgw4ZcfLmM9omjU6T+zRYC0ns
z/wYjgtxqYnHDnQ4SwKyLpfHsc5Yy8VVLKRzm469tNqGQtBTZBpDffBGZe1ND006
pze8FgINj/36OSbmkAXpRYI27ohEBy49GZTYxCEIztn+VjwP9sYnDuOTNXRKpaSd
LvPhSfwrTQ76gFYlYnZcEdRL8wulkYvMsIUETq53
-----END CERTIFICATE-----`

const WRONG_SAN_CERT = `-----BEGIN CERTIFICATE-----
MIIDIDCCAgigAwIBAgIUNrXufb4q22kbsrFzjUdccAKD0sEwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjYwOTA0MDEwODIyWhcNMzYw
OTAxMDEwODIyWjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAJXwijJdKXeYb4HJOoTbvXJ0ZSm3Mf5u1GpD0+bH
bXA1ZG9w7NAsGzFvuC/hdlemrkufgzzYjQRGaQCrpnJel4R8+NgjvsXLclSKOl/u
TZ099teLtrJmTMeUvwQOF5nah39P8n7nn5B0et6vDNxzOj6CuD3e3s4n4nYBWWua
r4wqEwIrd0tDwbedzuM7MXYVz8kh91wQ0xN1pgFVAVytHTa+96cQEdeUYTBGu+yy
rnpQGrlvi1WH90kpQtZUrIVY2AGkkQPunRy0kiCf7uN54zqSIVEM3LB58Wg4rRWA
CAa3ShmmoPDxaujRH4mwPeMfNftmdcxf9oCEjqoPwA8k9ysCAwEAAaNmMGQwFgYD
VR0RBA8wDYILZXhhbXBsZS5jb20wCQYDVR0TBAIwADALBgNVHQ8EBAMCBaAwEwYD
VR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFPOnAWKeVuhGZyUO4QjJ3IFQ2gi2
MA0GCSqGSIb3DQEBCwUAA4IBAQAGLKGo0qJ9uqieHrBQ0CKNcf3wQCA+9/ZRp6w3
2tHlyZuqoHfNoqMK+XCt1rHSnv+a1xCVExF9swcWIA9M8QpvC1b/I7/CzqGBojQB
/vYGyrPLWHit1h2Ugj1B52ndy5nw3f1+qwg7sR1fwvBBTzTHwldwCBS0tjNJTHMF
ZTXAOjEIwHxnRONqiJrefAJo/aqVG4+8L0WeZcHqtzbAmoBAUCrbdMFdDuKfu4fH
3idc0h30DxNwFxztgVAtzYj6chyOfVUi51xcTnURHBFOlCM5rCfy9n5gPR66Z7Gb
z256elHH9my3hU0ex5e4Fub9TA42fLqDDavp+/sYRIEM5rVr
-----END CERTIFICATE-----`

const VALID_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6Vz1KV4hgL6xg
IpusRdrCBdOi2Bk8FBmd2Hc4+Zwc8RYRSqHoDWws60SHr/9ut27xCTk+27fxV3Xb
ulDw2sX4H+Qxt/bgdiJYAYFISjKx7FicjsuodS511Ptc4G7NtrdqrIPkInuYMJDN
yItwk3oFld0ohUzCMm0V0c1bbgwUKS4/ZXzkAA+2Zts/4XeMmH/TSfBRC+4b88xy
/d8a1gp7/xAmIuQc0btOKq7pf6+QR+ZKLHWuP5o95z6ssSa+Ixvd6GeXxXNkNztc
zMwfzYa5yzuvUaUd7W3qBzCO2W0NZ4yG1B1yCSnU8hy748yzPaf5LIG5F+i1MjE/
gXaa4tsjAgMBAAECggEANi3NXUMsHMNfvCfz2VgKLeWhzjREygoSFKnuqDszH9sd
DnQDtUPJ0xmouEb83sUo1Z5X7aXWyq4iT3vRsuX5L5aeM7KIbmUKwUnWvB0OtlrA
vOxr3JQNqSb+2tdKgDeDBtoYEwnPo8VjJOINYPMQRHV5cyGm2sPsoa55pf7ONkHv
NGVQ7oo+hzWn/kS7ZXwJFBA8OSeAXYhLuMIwr2W2E1P32QCO9aVu+Cs1oxcr9Ckv
oG99t2NFfcTNza5KecUuljqYB1CvUsBdzp2xnNuxgc23m16YzksN03nxxGL8O5/0
HwNYpuGuy3wBcbl5fzzeX5VPadD3CCpMLMHyPxnBWQKBgQDzh8ILjwMffZkZNBfw
9gczwSmRajhDaCOt6sem3kTHgAtnorJ79hx3KX0pVwCT5GMxhptrgI6MwhGfzSdK
0JxrwFpUx/XCCDYLDCEqDJAXPlnK6OBjr8POT+33p0lBJdnbIfm+KhWsNqPnK2yw
bp++6WEK4onivl2c9MpCIG+kbwKBgQDD4dSD/q45FguizDerLn7wCogVXiiKdVvx
99e6EAMnzhknBA7wG8syaikA6b6gkGCGJnjQlcxJYCDA82TUqKaJfCIs2YBrQDLj
1MEt7/gzecmiamJr1P6QNkSE9FfN4S7R4TZukRleI279uDFr0b6TWuZHtQemiPur
gaYdqlhWjQKBgHanL4EoNdJTBJQGEKAjjxDFTXZ/NViKVc/38zy3UPWOyn+9Ao9p
MydP/J52uF5WSYoo1nLDWTD1oValwz4tc/j/6EMkhfX6wDITv9jX9CCPDXrSifmn
+pP716rxQ7zNL18YJ7FimdqlaKhKPROdYpHG7bQ6+gmSzNObZSxg12RbAoGBAIvR
Fzr8P+mZdcbHU/kJICxAqC/wXKmv6WhGiyJRKZ9w+f0iZXM3s4uRwSDYt2uugmde
8J+aPQ4m4lo3oUI1+2FpTI+M1KA5W9nJ0/XxMs2zYZxfqU7k4quXQMNSEZZv5FaF
FbBIO745NpE9t3EJbqmJmZOXgRV684DQ8vx7ycBFAoGADAj2NpfobN6/N0MhtSPt
mTsoanz+By7lqmuZVhe74HzGMdyN4dTugqQTyIRnHBRmZ8jo2dmDkDutpwLQvhnG
GcZf6bq+PAPqPJK+QiCYnfnuU7ZW2b78DL6/AG7oisEC5FKmqji4Q1WzY37q3Blv
z9vhaNGFK3e4CPYGJNZBMgQ=
-----END PRIVATE KEY-----`

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

function createHarness(
  options: {
    currentUid?: () => null | number
    lstatSync?: (path: string) => {
      isDirectory: () => boolean
      isFile: () => boolean
      isSymbolicLink: () => boolean
      mode: number
      uid: number
    }
    now?: () => Date
    listenError?: Error
    openExternal?: (url: string) => Promise<void>
    platform?: NodeJS.Platform
    readFile?: (path: string, encoding?: BufferEncoding) => string | Buffer
    connectGateway?: (route: { connectionId: null | string; profile: string }) => Promise<{
      close: () => void
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>
    }>
    spawnSync?: () => { error?: Error; status: number }
    tlsPaths?: () => { certificatePath?: string; keyPath?: string }
    userDataPath?: string
  } = {}
) {
  const harnessOptions = options
  const servers: FakeServer[] = []
  const created: Array<{ cert: Buffer | string; key: Buffer | string }> = []
  const openExternal = options.openExternal ?? vi.fn(async () => {})
  const userDataPath = options.userDataPath ?? '/user/data'
  const defaultTlsPaths = resolvePeepsVoiceAuthTlsPaths(userDataPath)

  const readFile =
    options.readFile ??
    vi.fn((filePath: string) =>
      filePath.endsWith('.js')
        ? 'console.log("local-only-script")'
        : filePath.endsWith('-cert.pem')
          ? VALID_LOCALHOST_CERT
          : VALID_KEY
    )

  const lstatSync =
    options.lstatSync ??
    vi.fn((filePath: string) =>
      filePath.endsWith('.pem')
        ? {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
            mode: 0o600,
            uid: 501
          }
        : {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
            mode: 0o700,
            uid: 501
          }
    )

  const tlsPaths = options.tlsPaths ?? (() => defaultTlsPaths)

  const handlers = createPeepsVoiceAuthHandlers({
    appPath: () => '/app',
    currentUid: options.currentUid ?? (() => 501),
    createServer: ((options, onRequest) => {
      created.push({ cert: options.cert, key: options.key })

      let errorHandler: ((error: Error) => void) | undefined

      const server: FakeServer = {
        close: vi.fn(),
        listen: vi.fn((_port: number, host: string, resolve: () => void) => {
          assert.equal(host, '127.0.0.1')

          if (harnessOptions.listenError) {
            errorHandler?.(harnessOptions.listenError)

            return server
          }

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
    lstatSync: lstatSync as never,
    now: options.now,
    openExternal,
    platform: options.platform ?? 'darwin',
    readFile,
    connectGateway: options.connectGateway,
    spawnSync: (options.spawnSync ?? (() => ({ status: 0 }))) as never,
    tlsPaths,
    userDataPath: () => userDataPath
  })

  return { created, defaultTlsPaths, handlers, lstatSync, openExternal, readFile, servers }
}

const flow: PeepsVoiceAuthFlow = {
  authSessionId: 'auth-1',
  authority: 'https://login.microsoftonline.com/organizations',
  clientId: 'client-id',
  publicKey: '0adOsHQZ3AJ0ch8kMk6oZHcIQiae4ESCXdMIOLeRqi4',
  redirectUri: 'https://localhost:8080/',
  scope: 'https://peeps.asgprototype.com/api/access-as-user',
  state: 'state-123'
}

test('preload exposes only complete and cancel, never start wait or an envelope result', () => {
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const bridge = preload.slice(preload.indexOf('peepsVoiceAuth:'), preload.indexOf('openPreviewInBrowser:'))

  assert.match(bridge, /complete:/)
  assert.match(bridge, /cancel:/)
  assert.doesNotMatch(bridge, /start:|wait:|ephemeral_public_key|ciphertext|envelope/)
})

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
  const envelope = await wait
  assert.equal(envelope?.version, 1)
  assert.equal(typeof envelope?.ciphertext, 'string')
  assert.doesNotMatch(JSON.stringify(envelope), /peeps-bearer/)

  const replayRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('GET', '/unexpected'), replayRes)
  assert.equal(replayRes.status, 404)
})

test('complete resolves the trusted backend flow and never accepts renderer OAuth values or returns an envelope', async () => {
  const requestGateway = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === 'voice.realtime.peeps.claim') {
      return {
        auth_session_id: 'auth-trusted',
        authority: 'https://attacker.invalid/common',
        client_id: 'attacker-client',
        public_key: flow.publicKey,
        redirect_uri: 'https://attacker.invalid/callback',
        scope: 'attacker-scope',
        state: 'trusted-state',
        timeout_seconds: 5
      }
    }

    return { ok: true }
  })
  const closeGateway = vi.fn()
  const connectGateway = vi.fn(async () => ({ close: closeGateway, request: requestGateway }))
  const harness = createHarness({ connectGateway })
  const completion = harness.handlers.complete({
    authSessionId: 'auth-trusted',
    authority: 'https://renderer-attacker.invalid/common',
    clientId: 'renderer-attacker',
    connectionId: 'remote-1',
    profile: 'work',
    publicKey: 'renderer-key',
    runtimeSessionId: 'runtime-1',
    scope: 'renderer-scope'
  } as never)

  await vi.waitFor(() => assert.equal(harness.servers.length, 1))

  const htmlRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('GET', '/'), htmlRes)
  assert.match(htmlRes.body, /b6ca153a-37a1-4f59-ad95-c4e30313c64b/)
  assert.match(htmlRes.body, /https:\/\/login\.microsoftonline\.com\/organizations/)
  assert.match(htmlRes.body, /https:\/\/peeps\.asgprototype\.com\/api\/access-as-user/)
  assert.doesNotMatch(htmlRes.body, /renderer-attacker|attacker\.invalid|attacker-scope/)

  const callbackRes = new FakeResponse()
  const callbackReq = new FakeRequest('POST', '/', { origin: 'https://localhost:8080' })
  harness.servers[0].onRequest(callbackReq, callbackRes)
  callbackReq.emit('data', JSON.stringify({ state: 'trusted-state', token: 'peeps-bearer' }))
  callbackReq.emit('end')

  assert.equal(await completion, true)
  assert.equal(vi.mocked(harness.openExternal).mock.calls[0]?.[0], 'https://localhost:8080/')
  assert.deepEqual(connectGateway.mock.calls[0], [{ connectionId: 'remote-1', profile: 'work' }])
  assert.deepEqual(requestGateway.mock.calls[0], [
    'voice.realtime.peeps.claim',
    { auth_session_id: 'auth-trusted', session_id: 'runtime-1' }
  ])
  assert.equal(requestGateway.mock.calls[1]?.[0], 'voice.realtime.peeps.complete')
  assert.equal(typeof (requestGateway.mock.calls[1]?.[1] as any).envelope.ciphertext, 'string')
  assert.equal(closeGateway.mock.calls.length, 1)
})

test('start rejects non-localhost loopback aliases when the page is authorized only for localhost', async () => {
  const harness = createHarness()

  await assert.rejects(
    () =>
      handlersStart(harness, 'auth-alias', {
        ...flow,
        redirectUri: 'https://127.0.0.1:8080/'
      }),
    /flow is invalid/
  )
  await assert.rejects(
    () =>
      handlersStart(harness, 'auth-ipv6', {
        ...flow,
        redirectUri: 'https://[::1]:8080/'
      }),
    /flow is invalid/
  )
})

test('invalid origin state method and oversized body fail closed without echoing tokens', async () => {
  const harness = createHarness()

  await handlersStart(harness, 'auth-2')
  const waitWrongOrigin = harness.handlers.wait('auth-2', 5_000)
  const wrongOriginRes = new FakeResponse()
  harness.servers[0].onRequest(new FakeRequest('POST', '/', { origin: 'https://example.com' }), wrongOriginRes)
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

test('preflight rejects unsupported platforms untrusted certs mismatched keys and port collisions', async () => {
  await assert.rejects(() => handlersStart(createHarness({ platform: 'linux' }), 'linux'), /only on macOS/)
  await assert.rejects(
    () => handlersStart(createHarness({ spawnSync: () => ({ status: 1 }) }), 'untrusted'),
    /TLS preflight failed/
  )

  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8'
  })

  await assert.rejects(
    () =>
      handlersStart(
        createHarness({
          readFile: filePath =>
            filePath.endsWith('.js') ? 'local' : filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : wrongKey
        }),
        'mismatch'
      ),
    /TLS preflight failed/
  )
  await assert.rejects(
    () =>
      handlersStart(
        createHarness({ listenError: Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) }),
        'collision'
      ),
    /in use/
  )
})

test('resolvePeepsVoiceAuthTlsPaths keeps certs machine-local under Electron userData', () => {
  assert.deepEqual(resolvePeepsVoiceAuthTlsPaths('/Users/test/Library/Application Support/Catalyst'), {
    certificatePath: '/Users/test/Library/Application Support/Catalyst/peeps-voice-auth/localhost-cert.pem',
    keyPath: '/Users/test/Library/Application Support/Catalyst/peeps-voice-auth/localhost-key.pem'
  })
})

test('tls material loader accepts only the Electron-owned localhost certificate and key', () => {
  const harness = createHarness({
    now: () => new Date('2026-09-05T00:00:00.000Z')
  })

  const material = loadValidatedPeepsVoiceAuthTlsMaterial({
    currentUid: () => 501,
    lstatSync: harness.lstatSync as never,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    openExternal: harness.openExternal,
    readFile: harness.readFile,
    spawnSync: (() => ({ status: 0 })) as never,
    tlsPaths: () => harness.defaultTlsPaths,
    userDataPath: () => '/user/data',
    appPath: () => '/app'
  })

  assert.match(material.certificatePem.toString('utf8'), /BEGIN CERTIFICATE/)
  assert.match(material.keyPem.toString('utf8'), /BEGIN PRIVATE KEY/)
})

test('tls material loader rejects path escapes symlinks non-files wrong owners weak key perms and invalid certs', () => {
  const invalidMessage = /TLS preflight failed/

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: (() => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 501
        })) as never,
        openExternal: async () => {},
        readFile: () => VALID_LOCALHOST_CERT,
        tlsPaths: () => ({
          certificatePath: '/user/data/peeps-voice-auth/../outside/localhost-cert.pem',
          keyPath: '/user/data/peeps-voice-auth/localhost-key.pem'
        }),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: ((filePath: string) => ({
          isDirectory: () => false,
          isFile: () => filePath.endsWith('-key.pem'),
          isSymbolicLink: () => filePath.endsWith('-cert.pem'),
          mode: 0o600,
          uid: 501
        })) as never,
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: ((filePath: string) => ({
          isDirectory: () => false,
          isFile: () => !filePath.endsWith('-cert.pem'),
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 501
        })) as never,
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: (() => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 777
        })) as never,
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: ((filePath: string) => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: filePath.endsWith('-key.pem') ? 0o640 : 0o644,
          uid: 501
        })) as never,
        openExternal: async () => {},
        platform: 'darwin',
        readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: (() => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 501
        })) as never,
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? 'not-a-cert' : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: (() => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 501
        })) as never,
        now: () => new Date('2040-01-01T00:00:00.000Z'),
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )

  assert.throws(
    () =>
      loadValidatedPeepsVoiceAuthTlsMaterial({
        appPath: () => '/app',
        currentUid: () => 501,
        lstatSync: (() => ({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o600,
          uid: 501
        })) as never,
        now: () => new Date('2026-09-05T00:00:00.000Z'),
        openExternal: async () => {},
        readFile: filePath => (filePath.endsWith('-cert.pem') ? WRONG_SAN_CERT : VALID_KEY),
        tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
        userDataPath: () => '/user/data'
      }),
    invalidMessage
  )
})

test('tls material loader rejects symlinked directory components from userData through peeps-voice-auth', () => {
  const invalidMessage = /TLS preflight failed/

  for (const symlinkPath of ['/user/data', '/user/data/peeps-voice-auth']) {
    assert.throws(
      () =>
        loadValidatedPeepsVoiceAuthTlsMaterial({
          appPath: () => '/app',
          currentUid: () => 501,
          lstatSync: ((filePath: string) =>
            filePath === '/user/data' || filePath === '/user/data/peeps-voice-auth'
              ? {
                  isDirectory: () => true,
                  isFile: () => false,
                  isSymbolicLink: () => filePath === symlinkPath,
                  mode: 0o700,
                  uid: 501
                }
              : {
                  isDirectory: () => false,
                  isFile: () => true,
                  isSymbolicLink: () => false,
                  mode: 0o600,
                  uid: 501
                }) as never,
          now: () => new Date('2026-09-05T00:00:00.000Z'),
          openExternal: async () => {},
          readFile: filePath => (filePath.endsWith('-cert.pem') ? VALID_LOCALHOST_CERT : VALID_KEY),
          tlsPaths: () => resolvePeepsVoiceAuthTlsPaths('/user/data'),
          userDataPath: () => '/user/data'
        }),
      invalidMessage
    )
  }
})

async function handlersStart(
  harness: ReturnType<typeof createHarness>,
  id: string,
  nextFlow: PeepsVoiceAuthFlow = flow
) {
  return harness.handlers.start(id, { ...nextFlow, authSessionId: id })
}
