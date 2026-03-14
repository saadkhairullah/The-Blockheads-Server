import { createConnection, Socket } from 'net'

/**
 * Node.js client for the WorldManager UDS daemon (uds_daemon.py).
 *
 * Replaces execFileAsync spawns in blockhead-service.ts with a persistent
 * socket connection. Latency: ~1-5ms per op vs ~100-400ms for Python spawns.
 *
 * Protocol: newline-delimited JSON
 *   Request:  {"id":"1","cmd":"give_item","blockheadId":123,...}\n
 *   Response: {"id":"1","ok":true,...}\n
 */

interface WMResponse {
  id: string
  ok?: boolean
  error?: string
  [key: string]: unknown
}

type PendingEntry = {
  resolve: (r: WMResponse) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

class WMClient {
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, PendingEntry>()
  private reqCounter = 0
  private connected = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopping = false

  constructor(private readonly socketPath: string) {}

  connect(): void {
    if (this.stopping) return
    this.socket = createConnection(this.socketPath)

    this.socket.on('connect', () => {
      this.connected = true
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      console.log('[WM] Connected to WorldManager daemon')
    })

    this.socket.on('data', (data) => {
      this.buffer += data.toString()
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const resp: WMResponse = JSON.parse(line)
          const entry = this.pending.get(resp.id)
          if (entry) {
            this.pending.delete(resp.id)
            clearTimeout(entry.timer)
            entry.resolve(resp)
          }
        } catch {
          console.error('[WM] Failed to parse response:', line)
        }
      }
    })

    this.socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        console.log('[WM] Daemon not available, retrying...')
      } else {
        console.error('[WM] Socket error:', err.message)
      }
      this.connected = false
    })

    this.socket.on('close', () => {
      this.connected = false
      this._rejectAll('WM daemon disconnected')
      if (!this.stopping) this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }

  private _rejectAll(msg: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(msg))
    }
    this.pending.clear()
  }

  send(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<WMResponse> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('WM daemon not connected'))
        return
      }

      const id = String(++this.reqCounter)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WM request timed out: ${cmd}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.socket.write(JSON.stringify({ id, cmd, ...params }) + '\n')
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  disconnect(): void {
    this.stopping = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._rejectAll('WM client disconnecting')
    this.socket?.destroy()
    this.socket = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }
}

export { WMClient }

export function createWMClient(socketPath: string): WMClient {
  const client = new WMClient(socketPath)
  client.connect()
  return client
}
