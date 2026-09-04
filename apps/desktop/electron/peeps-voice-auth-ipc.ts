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
  createServer?: typeof https.createServer
  existsSync?: (path: string) => boolean
  openExternal: (url: string) => Promise<void>
  readFile: (path: string, encoding?: BufferEncoding) => string | Buffer
  tlsPaths: () => { certificatePath?: string; keyPath?: string }
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

export function createPeepsVoiceAuthHandlers(deps: PeepsVoiceAuthDeps) {
  const pending = new Map<string, Pending>()
  const createServer = deps.createServer ?? https.createServer
  const existsSync = deps.existsSync ?? fs.existsSync
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

    const tls = deps.tlsPaths()
    if (
      !tls.certificatePath ||
      !tls.keyPath ||
      !existsSync(tls.certificatePath) ||
      !existsSync(tls.keyPath)
    ) {
      throw new Error(
        'Peeps voice authorization requires Electron-owned HTTPS localhost certificate and key files'
      )
    }

    const script = String(
      deps.readFile(path.join(deps.appPath(), 'dist', 'peeps-voice-auth-page.js'), 'utf8')
    )
    const html = authPage().replace(
      '<script id="peeps-flow" type="application/json"></script>',
      `<script id="peeps-flow" type="application/json">${escapeHtmlJson(flow)}</script>`
    )
    const server = createServer(
      { cert: deps.readFile(tls.certificatePath), key: deps.readFile(tls.keyPath) },
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
    readFile: fs.readFileSync,
    tlsPaths: () => resolvePeepsVoiceAuthTlsPaths(app.getPath('userData'))
  })
  ipcMain.handle('hermes:peeps-voice-auth:start', (_event, id, flow) => handlers.start(id, flow))
  ipcMain.handle('hermes:peeps-voice-auth:wait', (_event, id, timeout) => handlers.wait(id, timeout))
  ipcMain.handle('hermes:peeps-voice-auth:cancel', (_event, id) => handlers.cancel(id))
}
