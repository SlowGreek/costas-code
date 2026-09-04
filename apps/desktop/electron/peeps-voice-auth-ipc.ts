import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { app, ipcMain, shell } from 'electron'

const AUTH_PAGE_JS_PATH = '/peeps-voice-auth-page.js'
const AUTH_PAGE_TIMEOUT_MS_MAX = 300_000
const AUTH_PAGE_TIMEOUT_MS_MIN = 1_000
const MAX_AUTH_BODY_BYTES = 16_384
const PEEPS_TLS_DIRNAME = 'peeps-voice-auth'
const PEEPS_REDIRECT_ORIGIN = 'https://localhost:8080'
const PEEPS_REDIRECT_URI = `${PEEPS_REDIRECT_ORIGIN}/`

export interface PeepsVoiceAuthFlow {
  authority: string
  clientId: string
  redirectUri: string
  scope: string
  state: string
}

interface Pending {
  server: https.Server
  waiters: Array<(result: string | null) => void>
}

export interface PeepsVoiceAuthDeps {
  appPath: () => string
  currentUid?: () => null | number
  createServer?: typeof https.createServer
  lstatSync?: (path: string) => fs.Stats
  now?: () => Date
  openExternal: (url: string) => Promise<void>
  platform?: NodeJS.Platform
  readFile: (path: string, encoding?: BufferEncoding) => string | Buffer
  tlsPaths: () => { certificatePath?: string; keyPath?: string }
  userDataPath: () => string
}

export const authPage = () =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src https://localhost:8080 https://login.microsoftonline.com; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>Signing in</title><p>Signing in...</p><script id="peeps-flow" type="application/json"></script><script src="${AUTH_PAGE_JS_PATH}"></script>`

function escapeHtmlJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, char => {
    if (char === '<') {
      return '\\u003c'
    }

    if (char === '>') {
      return '\\u003e'
    }

    return '\\u0026'
  })
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
  return new Error(
    'Peeps voice authorization requires a valid pre-provisioned Electron-owned localhost certificate and private key'
  )
}

function resolveExpectedTlsPaths(userDataPath: string) {
  const resolved = resolvePeepsVoiceAuthTlsPaths(userDataPath)

  return {
    certificatePath: path.resolve(resolved.certificatePath),
    keyPath: path.resolve(resolved.keyPath)
  }
}

function validateOwnedRealDirectory(options: {
  currentUid: null | number
  directoryPath: string
  lstatSync: (filePath: string) => fs.Stats
}): void {
  let stats: fs.Stats

  try {
    stats = options.lstatSync(options.directoryPath)
  } catch {
    throw tlsValidationError()
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw tlsValidationError()
  }

  if (options.currentUid !== null && stats.uid !== options.currentUid) {
    throw tlsValidationError()
  }
}

function validateOwnedRegularFile(options: {
  currentUid: null | number
  expectedPath: string
  lstatSync: (filePath: string) => fs.Stats
  ownerOnly: boolean
  platform: NodeJS.Platform
}): void {
  let stats: fs.Stats

  try {
    stats = options.lstatSync(options.expectedPath)
  } catch {
    throw tlsValidationError()
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw tlsValidationError()
  }

  if (options.currentUid !== null && stats.uid !== options.currentUid) {
    throw tlsValidationError()
  }

  if (options.ownerOnly && options.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw tlsValidationError()
  }
}

export function loadValidatedPeepsVoiceAuthTlsMaterial(deps: PeepsVoiceAuthDeps) {
  const configured = deps.tlsPaths()
  const userDataPath = path.resolve(deps.userDataPath())
  const expected = resolveExpectedTlsPaths(userDataPath)
  const tlsRootPath = path.dirname(expected.certificatePath)
  const certificatePath = path.resolve(String(configured.certificatePath || ''))
  const keyPath = path.resolve(String(configured.keyPath || ''))

  if (!certificatePath || !keyPath) {
    throw tlsValidationError()
  }

  if (certificatePath !== expected.certificatePath || keyPath !== expected.keyPath) {
    throw tlsValidationError()
  }

  const lstatSync = deps.lstatSync ?? fs.lstatSync
  const currentUid = deps.currentUid ? deps.currentUid() : typeof process.getuid === 'function' ? process.getuid() : null
  const platform = deps.platform ?? process.platform

  validateOwnedRealDirectory({
    currentUid,
    directoryPath: userDataPath,
    lstatSync
  })
  validateOwnedRealDirectory({
    currentUid,
    directoryPath: tlsRootPath,
    lstatSync
  })
  validateOwnedRegularFile({
    currentUid,
    expectedPath: certificatePath,
    lstatSync,
    ownerOnly: false,
    platform
  })
  validateOwnedRegularFile({
    currentUid,
    expectedPath: keyPath,
    lstatSync,
    ownerOnly: true,
    platform
  })

  let certificatePem: Buffer
  let keyPem: Buffer

  try {
    certificatePem = Buffer.from(deps.readFile(certificatePath))
    keyPem = Buffer.from(deps.readFile(keyPath))
  } catch {
    throw tlsValidationError()
  }

  let certificate: X509Certificate

  try {
    certificate = new X509Certificate(certificatePem)
  } catch {
    throw tlsValidationError()
  }

  const now = deps.now?.() ?? new Date()
  const validFrom = Date.parse(certificate.validFrom)
  const validTo = Date.parse(certificate.validTo)

  const sanEntries = String(certificate.subjectAltName || '')
    .split(/,\s*/)
    .map(entry => entry.trim())
    .filter(Boolean)

  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now.getTime() < validFrom ||
    now.getTime() > validTo ||
    !sanEntries.includes('DNS:localhost')
  ) {
    throw tlsValidationError()
  }

  return { certificatePem, keyPem }
}

export function createPeepsVoiceAuthHandlers(deps: PeepsVoiceAuthDeps) {
  const pending = new Map<string, Pending>()
  const createServer = deps.createServer ?? https.createServer
  let activeListenerId: null | string = null

  const close = (id: string, result: string | null) => {
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

    const redirect = new URL(flow.redirectUri)

    if (flow.redirectUri !== PEEPS_REDIRECT_URI || redirect.origin !== PEEPS_REDIRECT_ORIGIN) {
      throw new Error('Peeps voice authorization requires the exact https://localhost:8080/ redirect')
    }

    const tls = loadValidatedPeepsVoiceAuthTlsMaterial(deps)

    const script = String(
      deps.readFile(path.join(deps.appPath(), 'dist', 'peeps-voice-auth-page.js'), 'utf8')
    )

    const html = authPage().replace(
      '<script id="peeps-flow" type="application/json"></script>',
      `<script id="peeps-flow" type="application/json">${escapeHtmlJson(flow)}</script>`
    )

    const server = createServer(
      { cert: tls.certificatePem, key: tls.keyPem },
      (req, res) => {
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)

          return
        }

        if (req.method === 'GET' && req.url === AUTH_PAGE_JS_PATH) {
          res
            .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
            .end(script)

          return
        }

        if (req.method !== 'POST' || req.url !== '/' || req.headers.origin !== PEEPS_REDIRECT_ORIGIN) {
          res.writeHead(req.method === 'POST' ? 400 : 404).end()
          close(id, null)

          return
        }

        let size = 0
        const chunks: Buffer[] = []
        req.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.byteLength

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
            const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              state?: unknown
              token?: unknown
            }

            if (
              message.state !== flow.state ||
              typeof message.token !== 'string' ||
              message.token.length === 0 ||
              message.token.length > 8_192
            ) {
              throw new Error('invalid')
            }

            res.writeHead(204).end()
            close(id, message.token)
          } catch {
            res.writeHead(400).end()
            close(id, null)
          }
        })
      }
    )

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

      if (activeListenerId === id) {
        activeListenerId = null
      }

      pending.delete(id)
      throw error
    }
  }

  const wait = async (id: string, timeout: number) => {
    const entry = pending.get(id)

    if (!entry) {
      return null
    }

    return new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        close(id, null)
        resolve(null)
      }, Math.min(Math.max(timeout, AUTH_PAGE_TIMEOUT_MS_MIN), AUTH_PAGE_TIMEOUT_MS_MAX))

      entry.waiters.push(result => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  return {
    cancel: (id: string) => {
      close(id, null)

      return true
    },
    start,
    wait
  }
}

export function registerPeepsVoiceAuthIpc() {
  const handlers = createPeepsVoiceAuthHandlers({
    appPath: () => app.getAppPath(),
    openExternal: shell.openExternal,
    userDataPath: () => app.getPath('userData'),
    readFile: fs.readFileSync,
    tlsPaths: () => resolvePeepsVoiceAuthTlsPaths(app.getPath('userData'))
  })

  ipcMain.handle('hermes:peeps-voice-auth:start', (_event, id, flow) => handlers.start(id, flow))
  ipcMain.handle('hermes:peeps-voice-auth:wait', (_event, id, timeout) => handlers.wait(id, timeout))
  ipcMain.handle('hermes:peeps-voice-auth:cancel', (_event, id) => handlers.cancel(id))
}
