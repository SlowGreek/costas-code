interface GatewayWebSocket {
  readyState: number
  addEventListener: (event: string, listener: (event?: any) => void, options?: { once?: boolean }) => void
  removeEventListener: (event: string, listener: (event?: any) => void) => void
  send: (value: string) => void
  close: () => void
}

interface GatewayWebSocketConstructor {
  OPEN: number
  new (url: string, options?: { headers?: Record<string, string> }): GatewayWebSocket
}

export interface GatewayRpcClient {
  close: () => void
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

export interface ConnectGatewayRpcOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  WebSocketImpl?: GatewayWebSocketConstructor
  wsUrl: string
}

const DEFAULT_TIMEOUT_MS = 20_000

export async function connectGatewayRpc(options: ConnectGatewayRpcOptions): Promise<GatewayRpcClient> {
  const WebSocketImpl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as GatewayWebSocketConstructor)

  if (!WebSocketImpl || !options.wsUrl) {
    throw new Error('Peeps gateway connection is unavailable')
  }

  const socket =
    Object.keys(options.headers ?? {}).length > 0
      ? new WebSocketImpl(options.wsUrl, { headers: options.headers })
      : new WebSocketImpl(options.wsUrl)
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 300_000)

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error('Peeps gateway connection timed out'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Peeps gateway connection failed'))
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Peeps gateway connection closed'))
    }

    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onClose, { once: true })
  })

  let sequence = 0
  let closed = false
  const pending = new Map<
    string,
    {
      reject: (error: Error) => void
      resolve: (value: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const rejectPending = () => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Peeps gateway connection closed'))
    }
    pending.clear()
  }

  socket.addEventListener('close', rejectPending)
  socket.addEventListener('error', rejectPending)
  socket.addEventListener('message', event => {
    try {
      const frame = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data ?? ''))
      const id = typeof frame?.id === 'string' ? frame.id : ''
      const entry = pending.get(id)

      if (!entry) {
        return
      }
      pending.delete(id)
      clearTimeout(entry.timer)

      if (frame.error) {
        entry.reject(new Error(String(frame.error.message || 'Peeps gateway request failed')))
      } else {
        entry.resolve(frame.result)
      }
    } catch {
      rejectPending()
      socket.close()
    }
  })

  return {
    close: () => {
      if (closed) {
        return
      }
      rejectPending()
      socket.close()
    },
    request: (method, params) => {
      if (closed || socket.readyState !== WebSocketImpl.OPEN) {
        return Promise.reject(new Error('Peeps gateway connection is closed'))
      }

      const id = `peeps-main-${++sequence}`

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Peeps gateway request timed out'))
        }, timeoutMs)

        pending.set(id, { reject, resolve, timer })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    }
  }
}
