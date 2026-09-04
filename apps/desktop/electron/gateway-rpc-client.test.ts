import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'vitest'

import { connectGatewayRpc } from './gateway-rpc-client'

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  url: string
  options: unknown

  constructor(url: string, options?: unknown) {
    super()
    this.url = url
    this.options = options
    FakeWebSocket.instances.push(this)
  }

  addEventListener(event: string, listener: (...args: any[]) => void, options?: { once?: boolean }) {
    if (options?.once) {
      this.once(event, listener)
    } else {
      this.on(event, listener)
    }
  }

  removeEventListener(event: string, listener: (...args: any[]) => void) {
    this.off(event, listener)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  frame(value: unknown) {
    this.emit('message', { data: JSON.stringify(value) })
  }
}

test('gateway RPC client keeps one authenticated socket for claim and completion', async () => {
  FakeWebSocket.instances = []
  const connecting = connectGatewayRpc({
    headers: { 'CF-Access-Client-Id': 'trusted-header' },
    timeoutMs: 1_000,
    WebSocketImpl: FakeWebSocket as never,
    wsUrl: 'wss://gateway.example/api/ws?ticket=one-use'
  })
  const socket = FakeWebSocket.instances[0]
  socket.open()
  const client = await connecting

  const pending = client.request('voice.realtime.peeps.claim', {
    auth_session_id: 'auth',
    session_id: 'runtime'
  })
  const request = JSON.parse(socket.sent[0])
  socket.frame({ jsonrpc: '2.0', id: request.id, result: { state: 'trusted' } })

  assert.deepEqual(await pending, { state: 'trusted' })
  assert.deepEqual(socket.options, { headers: { 'CF-Access-Client-Id': 'trusted-header' } })
  assert.equal(socket.url, 'wss://gateway.example/api/ws?ticket=one-use')

  client.close()
  assert.equal(socket.readyState, 3)
})
