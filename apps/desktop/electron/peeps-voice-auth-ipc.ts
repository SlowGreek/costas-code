import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  X509Certificate
} from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { app, ipcMain, shell } from 'electron'

const AUTH_PAGE_JS_PATH = '/peeps-voice-auth-page.js'
const MAX_AUTH_BODY_BYTES = 16_384
const PEEPS_TLS_DIRNAME = 'peeps-voice-auth'
const REDIRECT_ORIGIN = 'https://localhost:8080'
const REDIRECT_URI = `${REDIRECT_ORIGIN}/`
const PEEPS_AUTHORITY = 'https://login.microsoftonline.com/organizations'
const PEEPS_CLIENT_ID = 'b6ca153a-37a1-4f59-ad95-c4e30313c64b'
const PEEPS_SCOPE = 'https://peeps.asgprototype.com/api/access-as-user'
const INFO = Buffer.from('hermes-peeps-voice-auth-v1')
const MAIN_CAPABILITY_TTL_MS = 300_000
const MAX_MAIN_CAPABILITIES = 32

export interface PeepsEnvelope {
  version: 1
  ephemeral_public_key: string
  nonce: string
  ciphertext: string
  tag: string
}

export interface PeepsVoiceAuthFlow {
  authSessionId: string
  authority: string
  clientId: string
  publicKey: string
  redirectUri: string
  scope: string
  state: string
}

interface Pending {
  server: https.Server
  waiters: Array<(result: PeepsEnvelope | null) => void>
}

interface ActiveCompletion {
  cancelled: boolean
  handle: string
}

export interface PeepsVoiceAuthDeps {
  appPath: () => string
  connectGateway?: (route: { connectionId: null | string; profile: string }) => Promise<{
    close: () => void
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  }>
  currentUid?: () => null | number
  createServer?: typeof https.createServer
  lstatSync?: (filePath: string) => fs.Stats
  now?: () => Date
  openExternal: (url: string) => Promise<void>
  platform?: NodeJS.Platform
  readFile: (filePath: string, encoding?: BufferEncoding) => string | Buffer
  spawnSync?: typeof nodeSpawnSync
  tlsPaths: () => { certificatePath?: string; keyPath?: string }
  userDataPath: () => string
}

export interface PeepsVoiceAuthCompletionRequest {
  authSessionId: string
  connectionId: null | string
  handle: string
  profile: string
  runtimeSessionId: string
}

export interface PeepsVoiceAuthCancellationRequest {
  authSessionId?: string
  handle: string
}

interface MainCapability {
  expiresAt: number
  secret: Buffer
}

export const authPage = () =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src https://localhost:8080 https://login.microsoftonline.com; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>Signing in</title><p>Signing in...</p><script id="peeps-flow" type="application/json"></script><script src="${AUTH_PAGE_JS_PATH}"></script>`

const b64url = (value: Buffer) => value.toString('base64url')

function sealToken(token: string, flow: PeepsVoiceAuthFlow): PeepsEnvelope {
  const remote = createPublicKey({
    format: 'jwk',
    key: { crv: 'X25519', kty: 'OKP', x: flow.publicKey }
  })

  const ephemeral = generateKeyPairSync('x25519')
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remote })
  const aad = Buffer.from(`${flow.authSessionId}:${flow.state}`)
  const key = Buffer.from(hkdfSync('sha256', shared, aad, INFO, 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const publicJwk = ephemeral.publicKey.export({ format: 'jwk' })

  const envelope: PeepsEnvelope = {
    version: 1,
    ephemeral_public_key: String(publicJwk.x),
    nonce: b64url(nonce),
    ciphertext: b64url(ciphertext),
    tag: b64url(cipher.getAuthTag())
  }

  key.fill(0)
  shared.fill(0)
  token = ''

  return envelope
}

function escapeHtmlJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, char =>
    char === '<' ? '\\u003c' : char === '>' ? '\\u003e' : '\\u0026'
  )
}

function closeServer(server: https.Server): void {
  try {
    server.close()
  } catch {
    // already closed
  }
}

export function resolvePeepsVoiceAuthTlsPaths(userDataPath: string) {
  const root = path.join(userDataPath, PEEPS_TLS_DIRNAME)

  return {
    certificatePath: path.join(root, 'localhost-cert.pem'),
    keyPath: path.join(root, 'localhost-key.pem')
  }
}

function tlsValidationError(): Error {
  return new Error('Peeps voice authorization TLS preflight failed')
}

function statOwnedPath(
  filePath: string,
  kind: 'directory' | 'file',
  ownerOnly: boolean,
  uid: number | null,
  lstatSync: (filePath: string) => fs.Stats
): void {
  let stats: fs.Stats

  try {
    stats = lstatSync(filePath)
  } catch {
    throw tlsValidationError()
  }

  if (
    stats.isSymbolicLink() ||
    (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) ||
    (uid !== null && stats.uid !== uid) ||
    (ownerOnly && (stats.mode & 0o077) !== 0)
  ) {
    throw tlsValidationError()
  }
}

export function loadValidatedPeepsVoiceAuthTlsMaterial(deps: PeepsVoiceAuthDeps) {
  const platform = deps.platform ?? process.platform

  if (platform !== 'darwin') {
    throw new Error('Peeps voice authorization TLS trust verification is supported only on macOS')
  }

  const userData = path.resolve(deps.userDataPath())
  const expected = resolvePeepsVoiceAuthTlsPaths(userData)
  const certificatePath = path.resolve(String(deps.tlsPaths().certificatePath || ''))
  const keyPath = path.resolve(String(deps.tlsPaths().keyPath || ''))

  if (certificatePath !== path.resolve(expected.certificatePath) || keyPath !== path.resolve(expected.keyPath)) {
    throw tlsValidationError()
  }

  const lstatSync = deps.lstatSync ?? fs.lstatSync
  const uid = deps.currentUid ? deps.currentUid() : (process.getuid?.() ?? null)
  statOwnedPath(userData, 'directory', false, uid, lstatSync)
  statOwnedPath(path.dirname(certificatePath), 'directory', false, uid, lstatSync)
  statOwnedPath(certificatePath, 'file', false, uid, lstatSync)
  statOwnedPath(keyPath, 'file', true, uid, lstatSync)

  let certificatePem: Buffer
  let keyPem: Buffer

  try {
    certificatePem = Buffer.from(deps.readFile(certificatePath))
    keyPem = Buffer.from(deps.readFile(keyPath))
  } catch {
    throw tlsValidationError()
  }

  try {
    const certificate = new X509Certificate(certificatePem)
    const now = (deps.now?.() ?? new Date()).getTime()

    if (
      now < Date.parse(certificate.validFrom) ||
      now > Date.parse(certificate.validTo) ||
      !String(certificate.subjectAltName).split(/,\s*/).includes('DNS:localhost')
    ) {
      throw tlsValidationError()
    }

    const keyPublic = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })
    const certPublic = certificate.publicKey.export({ type: 'spki', format: 'der' })

    if (!Buffer.from(keyPublic).equals(Buffer.from(certPublic))) {
      throw tlsValidationError()
    }
  } catch (error) {
    if (error instanceof Error && error.message === tlsValidationError().message) {
      throw error
    }

    throw tlsValidationError()
  }

  const trust = (deps.spawnSync ?? nodeSpawnSync)(
    '/usr/bin/security',
    ['verify-cert', '-c', certificatePath, '-p', 'ssl', '-n', 'localhost'],
    { shell: false, encoding: 'utf8' }
  ) as SpawnSyncReturns<string>

  if (trust.status !== 0 || trust.error) {
    throw tlsValidationError()
  }

  return { certificatePem, keyPem }
}

export function createPeepsVoiceAuthHandlers(deps: PeepsVoiceAuthDeps) {
  const pending = new Map<string, Pending>()
  const capabilities = new Map<string, MainCapability>()
  const activeCompletions = new Map<string, ActiveCompletion>()
  const createServer = deps.createServer ?? https.createServer
  let activeListenerId: string | null = null

  const nowMs = () => (deps.now?.() ?? new Date()).getTime()
  const destroyCapability = (handle: string) => {
    const capability = capabilities.get(handle)
    capabilities.delete(handle)
    capability?.secret.fill(0)
  }
  const pruneCapabilities = () => {
    const now = nowMs()
    for (const [handle, capability] of capabilities) {
      if (capability.expiresAt <= now) {
        destroyCapability(handle)
      }
    }
  }
  const prepare = () => {
    pruneCapabilities()
    while (capabilities.size >= MAX_MAIN_CAPABILITIES) {
      const oldest = capabilities.keys().next().value as string | undefined
      if (!oldest) {
        break
      }
      destroyCapability(oldest)
    }
    const secret = randomBytes(32)
    const handle = randomBytes(32).toString('base64url')
    capabilities.set(handle, { expiresAt: nowMs() + MAIN_CAPABILITY_TTL_MS, secret })
    return { challenge: createHash('sha256').update(secret).digest('base64url'), handle }
  }

  const close = (id: string, result: PeepsEnvelope | null) => {
    const entry = pending.get(id)

    if (!entry) {
      return
    }
    pending.delete(id)

    if (activeListenerId === id) {
      activeListenerId = null
    }
    closeServer(entry.server)
    entry.waiters.splice(0).forEach(waiter => waiter(result))
  }

  const start = async (id: string, flow: PeepsVoiceAuthFlow) => {
    if (activeListenerId && activeListenerId !== id) {
      close(activeListenerId, null)
    }

    if (pending.has(id)) {
      throw new Error('Peeps voice authorization is already pending')
    }

    if (id !== flow.authSessionId || flow.redirectUri !== REDIRECT_URI) {
      throw new Error('Peeps voice authorization flow is invalid')
    }

    const tls = loadValidatedPeepsVoiceAuthTlsMaterial(deps)
    const script = String(deps.readFile(path.join(deps.appPath(), 'dist', 'peeps-voice-auth-page.js'), 'utf8'))

    const html = authPage().replace(
      '<script id="peeps-flow" type="application/json"></script>',
      `<script id="peeps-flow" type="application/json">${escapeHtmlJson(flow)}</script>`
    )

    const server = createServer({ cert: tls.certificatePem, key: tls.keyPem }, (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)

        return
      }

      if (req.method === 'GET' && req.url === AUTH_PAGE_JS_PATH) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }).end(script)

        return
      }

      if (req.method !== 'POST' || req.url !== '/' || req.headers.origin !== REDIRECT_ORIGIN) {
        res.writeHead(req.method === 'POST' ? 400 : 404).end()
        close(id, null)

        return
      }

      let size = 0
      const chunks: Buffer[] = []
      req.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length

        if (size > MAX_AUTH_BODY_BYTES) {
          res.writeHead(413).end()
          close(id, null)
          req.destroy()

          return
        }

        chunks.push(buffer)
      })
      req.on('aborted', () => close(id, null))
      req.on('error', () => close(id, null))
      req.on('end', () => {
        if (!pending.has(id)) {
          return
        }

        try {
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { state?: unknown; token?: unknown }

          if (
            message.state !== flow.state ||
            typeof message.token !== 'string' ||
            !message.token ||
            message.token.length > 8192
          ) {
            throw new Error('invalid')
          }

          let token = message.token
          const envelope = sealToken(token, flow)
          token = ''
          message.token = undefined
          chunks.splice(0).forEach(chunk => chunk.fill(0))
          res.writeHead(204).end()
          close(id, envelope)
        } catch {
          chunks.splice(0).forEach(chunk => chunk.fill(0))
          res.writeHead(400).end()
          close(id, null)
        }
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(8080, '127.0.0.1', resolve)
      })
      pending.set(id, { server, waiters: [] })
      activeListenerId = id
      await deps.openExternal(flow.redirectUri)

      return true
    } catch (error) {
      closeServer(server)
      pending.delete(id)

      if (activeListenerId === id) {
        activeListenerId = null
      }
      throw error
    }
  }

  const wait = async (id: string, timeout: number) => {
    const entry = pending.get(id)

    if (!entry) {
      return null
    }

    return new Promise<PeepsEnvelope | null>(resolve => {
      const timer = setTimeout(
        () => {
          close(id, null)
          resolve(null)
        },
        Math.min(Math.max(timeout, 1000), 300_000)
      )

      entry.waiters.push(result => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  const complete = async (input: PeepsVoiceAuthCompletionRequest): Promise<boolean> => {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'authSessionId,connectionId,handle,profile,runtimeSessionId'
    ) {
      throw new Error('Peeps voice authorization request is invalid')
    }
    const authSessionId = typeof input?.authSessionId === 'string' ? input.authSessionId.trim() : ''
    const connectionId = typeof input?.connectionId === 'string' ? input.connectionId.trim() : null
    const handle = typeof input?.handle === 'string' ? input.handle : ''
    const profile = typeof input?.profile === 'string' ? input.profile.trim() : ''
    const runtimeSessionId = typeof input?.runtimeSessionId === 'string' ? input.runtimeSessionId.trim() : ''

    if (
      !deps.connectGateway ||
      !/^[A-Za-z0-9_-]{43}$/.test(handle) ||
      !authSessionId ||
      authSessionId.length > 256 ||
      (connectionId !== null && (!connectionId || connectionId.length > 256)) ||
      !profile ||
      profile.length > 128 ||
      !runtimeSessionId ||
      runtimeSessionId.length > 256
    ) {
      throw new Error('Peeps voice authorization request is invalid')
    }

    pruneCapabilities()
    const capability = capabilities.get(handle)
    if (!capability) {
      throw new Error('Peeps voice authorization request is invalid')
    }
    capabilities.delete(handle)
    if (activeCompletions.size >= MAX_MAIN_CAPABILITIES) {
      capability.secret.fill(0)
      throw new Error('Too many Peeps voice authorization requests are active')
    }
    const operation: ActiveCompletion = { cancelled: false, handle }
    activeCompletions.set(authSessionId, operation)
    let gateway: Awaited<ReturnType<NonNullable<PeepsVoiceAuthDeps['connectGateway']>>> | null = null
    let attemptedClaim = false
    let completed = false

    try {
      gateway = await deps.connectGateway({ connectionId, profile })
      attemptedClaim = true
      const claimed = (await gateway.request('voice.realtime.peeps.claim', {
        auth_session_id: authSessionId,
        native_main_proof: capability.secret.toString('base64url'),
        peeps_main_handle: handle,
        session_id: runtimeSessionId
      })) as Record<string, unknown>
      if (operation.cancelled) {
        throw new Error('Peeps voice authorization was cancelled or timed out')
      }
      const claimedAuthSessionId = typeof claimed?.auth_session_id === 'string' ? claimed.auth_session_id : ''
      const publicKey = typeof claimed?.public_key === 'string' ? claimed.public_key : ''
      const state = typeof claimed?.state === 'string' ? claimed.state : ''
      const timeoutSeconds = claimed?.timeout_seconds

      if (
        claimedAuthSessionId !== authSessionId ||
        !/^[A-Za-z0-9_-]{43}$/.test(publicKey) ||
        !state ||
        state.length > 256 ||
        typeof timeoutSeconds !== 'number' ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > 300
      ) {
        throw new Error('Peeps voice authorization flow is invalid')
      }

      const flow: PeepsVoiceAuthFlow = {
        authSessionId,
        authority: PEEPS_AUTHORITY,
        clientId: PEEPS_CLIENT_ID,
        publicKey,
        redirectUri: REDIRECT_URI,
        scope: PEEPS_SCOPE,
        state
      }

      await start(authSessionId, flow)
      const envelope = await wait(authSessionId, timeoutSeconds * 1000)

      if (!envelope) {
        throw new Error('Peeps voice authorization was cancelled or timed out')
      }

      await gateway.request('voice.realtime.peeps.complete', {
        auth_session_id: authSessionId,
        envelope,
        session_id: runtimeSessionId,
        state
      })
      completed = true

      return true
    } finally {
      if (gateway && attemptedClaim && !completed) {
        await gateway
          .request('voice.realtime.peeps.cancel', {
            auth_session_id: authSessionId,
            session_id: runtimeSessionId
          })
          .catch(() => undefined)
      }
      if (activeCompletions.get(authSessionId) === operation) {
        activeCompletions.delete(authSessionId)
      }
      capability.secret.fill(0)
      close(authSessionId, null)
      gateway?.close()
    }
  }

  return {
    cancel: (input: string | PeepsVoiceAuthCancellationRequest) => {
      const handle = typeof input === 'string' ? input : String(input?.handle || '')
      const authSessionId = typeof input === 'string' ? input : String(input?.authSessionId || '')
      const operation = activeCompletions.get(authSessionId)
      if (operation?.handle === handle) {
        operation.cancelled = true
      }
      destroyCapability(handle)
      if (authSessionId) {
        close(authSessionId, null)
      }

      return true
    },
    complete,
    prepare,
    start,
    wait
  }
}

export function registerPeepsVoiceAuthIpc(connectGateway: NonNullable<PeepsVoiceAuthDeps['connectGateway']>) {
  const handlers = createPeepsVoiceAuthHandlers({
    appPath: () => app.getAppPath(),
    connectGateway,
    openExternal: shell.openExternal,
    userDataPath: () => app.getPath('userData'),
    readFile: fs.readFileSync,
    tlsPaths: () => resolvePeepsVoiceAuthTlsPaths(app.getPath('userData'))
  })

  ipcMain.handle('hermes:peeps-voice-auth:complete', (_event, input) => handlers.complete(input))
  ipcMain.handle('hermes:peeps-voice-auth:prepare', () => handlers.prepare())
  ipcMain.handle('hermes:peeps-voice-auth:cancel', (_event, input) => handlers.cancel(input))
}
