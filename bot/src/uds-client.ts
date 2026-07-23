import { createConnection, Socket } from 'net'
import { EventEmitter } from 'events'

/**
 * Unix Domain Socket client for receiving events from the Java proxy.
 * Much faster than file watching - direct push with <5ms latency.
 */

export interface ProxyEvent {
  type: 'join' | 'leave' | 'chat' | 'command' | 'position' | 'packet'
  player?: string
  id?: string
  ip?: string
  message?: string
  command?: string
  blockheadId?: number
  x?: number
  y?: number
  direction?: string
  packetId?: number
  length?: number
  time: number
}

export class UDSClient extends EventEmitter {
  private socket: Socket | null = null
  private buffer = ''
  private reconnectTimer: NodeJS.Timeout | null = null
  private connected = false

  constructor(private socketPath: string = '/tmp/bh-events.sock') {
    super()
  }

  connect(): void {
    if (this.socket) {
      this.socket.destroy()
    }

    console.log(`[UDS] Connecting to ${this.socketPath}...`)

    this.socket = createConnection(this.socketPath)

    this.socket.on('connect', () => {
      console.log('[UDS] Connected to proxy')
      this.connected = true
      this.emit('connected')

      // Clear reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    })

    this.socket.on('data', (data) => {
      this.buffer += data.toString()

      // Process complete JSON lines
      let newlineIndex: number
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex)
        this.buffer = this.buffer.slice(newlineIndex + 1)

        if (line.trim()) {
          try {
            const event: ProxyEvent = JSON.parse(line)
            this.handleEvent(event)
          } catch (err) {
            console.error('[UDS] Failed to parse event:', line)
          }
        }
      }
    })

    this.socket.on('error', (err) => {
      if ((err as any).code === 'ENOENT') {
        console.log('[UDS] Socket not found, proxy may not be running')
      } else if ((err as any).code === 'ECONNREFUSED') {
        console.log('[UDS] Connection refused, proxy may not be running')
      } else {
        console.error('[UDS] Socket error:', err.message)
      }
      this.connected = false
    })

    this.socket.on('close', () => {
      console.log('[UDS] Disconnected from proxy')
      this.connected = false
      this.emit('disconnected')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      console.log('[UDS] Attempting reconnect...')
      this.connect()
    }, 5000)
  }

  private handleEvent(event: ProxyEvent): void {
    // Emit a single canonical event stream.
    // Downstream routers (e.g. event-dispatcher, setupUDSEventHandlers)
    // can fan out by event.type as needed.
    this.emit('event', event)

    // Debug logging (comment out in production)
    // console.log(`[UDS] ${event.type}:`, event)
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }

    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }
}

// Singleton instance
let udsClient: UDSClient | null = null

export function getUDSClient(socketPath?: string): UDSClient {
  if (!udsClient) {
    udsClient = new UDSClient(socketPath)
    udsClient.connect()
  }
  return udsClient
}

// Convenience function to set up all event handlers
export function setupUDSEventHandlers(
  onJoin?: (event: ProxyEvent) => void,
  onLeave?: (event: ProxyEvent) => void,
  onChat?: (event: ProxyEvent) => void,
  onCommand?: (event: ProxyEvent) => void,
  onPosition?: (event: ProxyEvent) => void
): UDSClient {
  const client = getUDSClient()

  client.on('event', (event: ProxyEvent) => {
    switch (event.type) {
      case 'join':
        if (onJoin) onJoin(event)
        break
      case 'leave':
        if (onLeave) onLeave(event)
        break
      case 'chat':
        if (onChat) onChat(event)
        break
      case 'command':
        if (onCommand) onCommand(event)
        break
      case 'position':
        if (onPosition) onPosition(event)
        break
      default:
        break
    }
  })

  return client
}
