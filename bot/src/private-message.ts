import { createConnection, Socket } from 'net'

let socket: Socket | null = null
let socketPath: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function initCommandSocket(path: string): void {
  socketPath = path
  connect()
}

function connect(): void {
  if (!socketPath || socket) return

  socket = createConnection(socketPath)
  socket.on('connect', () => {
    console.log('[CommandSocket] Connected to proxy')
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  })
  socket.on('error', () => {
    // ENOENT / ECONNREFUSED = proxy not up yet, will retry on close
  })
  socket.on('close', () => {
    socket = null
    if (socketPath) reconnectTimer = setTimeout(connect, 3000)
  })
}

export function sendPrivateMessage(playerName: string, message: string): void {
  if (!socket || socket.destroyed) return
  try {
    socket.write(JSON.stringify({ type: 'private_message', target: playerName, message }) + '\n')
  } catch {
    socket?.destroy()
    socket = null
  }
}
