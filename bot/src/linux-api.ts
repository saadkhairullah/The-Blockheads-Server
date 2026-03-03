import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { watch } from 'fs'
import { appendFile } from 'fs/promises'
import { config } from './config'

function writeToPipe(pipePath: string, message: string): void {
  appendFile(pipePath, message + '\n').catch(err => {
    console.error('[API] Pipe write error:', err.message)
  })
}

type WorldStatus = 'online' | 'offline' | 'startup' | 'shutdown' | 'stopping' | 'storing' | 'deleting' | 'move' | 'maintenance' | 'unavailable'

export interface WorldInfo {
  name: string
  id: string
  owner: string
  ip: string
  port: number
}

interface ChatMessage {
  player: { name: string; id: string }
  message: string
  timestamp: Date
}
let chatWatcher: any = null
let commandWatcher: any = null
let messageCallback: ((msg: ChatMessage) => void) | null = null
let joinCallback: ((player: { name: string; id: string }) => void) | null = null
let leaveCallback: ((player: { name: string; id: string }) => void) | null = null
let killCallback: ((killer: string, victim: string) => void) | null = null

// Tracks the last player to land a hit on each victim (victim playerName → attacker playerName)
const lastHit: Map<string, string> = new Map()


export class Api {
  public readonly name: string
  public readonly id: string
  private savePath: string
  private inputPipe: string
  
  constructor(public info: WorldInfo) {
    this.name = info.name
    this.id = info.id
    this.savePath = config.paths.worldSave
    this.inputPipe = config.paths.inputPipe
  }
  
  async send(message: string): Promise<void> {
    writeToPipe(this.inputPipe, message)
  }
  
  async getLists() {
    return {
      adminlist: await this.getAdminlist(),
      modlist: await this.getModlist(),
      blacklist: await this.getBlacklist(),
      whitelist: await this.getWhitelist()
    }
  }
  
  async setLists(lists: any) {
    if (lists.adminlist) await this.setAdminlist(lists.adminlist)
    if (lists.modlist) await this.setModlist(lists.modlist)
    if (lists.blacklist) await this.setBlacklist(lists.blacklist)
    if (lists.whitelist) await this.setWhitelist(lists.whitelist)
  }
  
  async getOverview() {
    return {
      name: this.name,
      owner: this.info.owner,
      created: new Date(),
      last_activity: new Date(),
      credit_until: new Date(),
      link: `${this.info.ip}:${this.info.port}`,
      status: 'online' as WorldStatus,
      pvp: false,
      privacy: 'public' as 'public' | 'private' | 'searchable',
      password: false,
      size: '16x' as '1/16x' | '1/4x' | '1x' | '4x' | '16x',
      whitelist: false,
      online: []
    }
  }
  
  async getLogs() {
    try {
      const logContent = await readFile(config.paths.serverLog, 'utf8')
      const lines = logContent.split('\n').slice(-100)
      
      return lines.filter(line => line.trim()).map((line) => ({
        timestamp: new Date(),
        message: line,
        raw: line
      }))
    } catch {
      return []
    }
  }
  
  async getAdminlist(): Promise<string[]> {
    try {
      const data = await readFile(join(this.savePath, 'adminlist.txt'), 'utf8')
      return data.split('\n').filter(line => line.trim())
    } catch {
      return []
    }
  }
  
  async getModlist(): Promise<string[]> {
    try {
      const data = await readFile(join(this.savePath, 'modlist.txt'), 'utf8')
      return data.split('\n').filter(line => line.trim())
    } catch {
      return []
    }
  }
  
  async getBlacklist(): Promise<string[]> {
    try {
      const data = await readFile(join(this.savePath, 'blacklist.txt'), 'utf8')
      return data.split('\n').filter(line => line.trim())
    } catch {
      return []
    }
  }
  
  async getWhitelist(): Promise<string[]> {
    try {
      const data = await readFile(join(this.savePath, 'whitelist.txt'), 'utf8')
      return data.split('\n').filter(line => line.trim())
    } catch {
      return []
    }
  }
  
  async setAdminlist(list: string[]): Promise<void> {
    await writeFile(join(this.savePath, 'adminlist.txt'), list.join('\n'))
  }
  
  async setModlist(list: string[]): Promise<void> {
    await writeFile(join(this.savePath, 'modlist.txt'), list.join('\n'))
  }
  
  async setBlacklist(list: string[]): Promise<void> {
    await writeFile(join(this.savePath, 'blacklist.txt'), list.join('\n'))
  }
  
  async setWhitelist(list: string[]): Promise<void> {
    await writeFile(join(this.savePath, 'whitelist.txt'), list.join('\n'))
  }
  
  async getMessages(_from?: number) {
    return {
      nextId: 0,
      log: []
    }
  }
  
  async getStatus(): Promise<WorldStatus> {
    return 'online'
  }
  
  async restart(): Promise<void> {
    console.log('Restart not supported on Linux server')
  }
  
  async start(): Promise<void> {
    // Already started
  }
  
  async stop(): Promise<void> {
    // Can't stop server
  }
}

export async function getWorlds(): Promise<WorldInfo[]> {
  return []
}

export function watchChat() {
  const logPath = config.paths.serverLog
  let lastPosition = 0
  
  console.log('[watchChat] Starting to watch:', logPath)
  
  readFile(logPath, 'utf8').then(content => {
    lastPosition = content.length
    console.log('[watchChat] Initial file size:', lastPosition)
  }).catch(() => {
    console.log('[watchChat] Log file not found, will start from beginning')
    lastPosition = 0
  })
  
  chatWatcher = watch(logPath, async (eventType) => {
    if (eventType === 'change') {
      try {
        const content = await readFile(logPath, 'utf8')
        const newContent = content.slice(lastPosition)
        lastPosition = content.length
        
        if (!newContent.trim()) return
        
        const lines = newContent.split('\n')
        
        for (const line of lines) {
          if (!line.trim()) continue
          
          // Check for player connections
          if (line.includes('Player Connected')) {
            const connectMatch = line.match(/Player Connected\s+(\S+)\s+\|\s+[\d.]+\s+\|\s+(\S+)/)
            if (connectMatch) {
              const playerName = connectMatch[1]
              const playerId = connectMatch[2]
              console.log(`[watchChat] Player joined: ${playerName} (${playerId})`)
              
              if (joinCallback) {
                joinCallback({ name: playerName, id: playerId })
              }
            }
            continue
          }
          
          // Check for player disconnections  
          if (line.includes('Player Disconnected')) {
            const disconnectMatch = line.match(/Player Disconnected\s+(\S+)/)
            if (disconnectMatch) {
              const playerName = disconnectMatch[1]
              console.log(`[watchChat] Player left: ${playerName}`)
              
              if (leaveCallback) {
                leaveCallback({ name: playerName, id: playerName })
              }
            }
            continue
          }
          
          // Track PvP hits: "Blockhead named X owned by player VICTIM was harmed by player KILLER."
          const harmMatch = line.match(/Blockhead named .+ owned by player (.+) was harmed by player (.+)\.$/)
          if (harmMatch) {
            const victim = harmMatch[1].trim()
            const attacker = harmMatch[2].trim()
            lastHit.set(victim, attacker)
            continue
          }

          // Track kills: "Blockhead died named X owned by player VICTIM."
          const deathMatch = line.match(/Blockhead died named .+ owned by player (.+)\.$/)
          if (deathMatch) {
            const victim = deathMatch[1].trim()
            const killer = lastHit.get(victim)
            lastHit.delete(victim)
            if (killer && killCallback) {
              killCallback(killer, victim)
            }
            continue
          }

          // Skip other system messages
          if (line.includes('SERVER:') || line.includes('Client disconnected')) {
            continue
          }
          
          // Parse chat messages
          const chatRegex = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \S+ (.+?):\s*(.+)$/
          const match = line.match(chatRegex)
          if (match) {
            const playerName = match[1].trim()
            const message = match[2].trim()
            
            const msg: ChatMessage = {
              player: { name: playerName, id: playerName },
              message: message,
              timestamp: new Date()
            }
            
            if (messageCallback) {
              messageCallback(msg)
            }
          }
        }
      } catch (err) {
        console.error('[watchChat] Error:', err)
      }
    }
  })
  
  console.log('Watching chat log at:', logPath)
}

export function watchCommandEvents() {
  const commandPath = config.paths.commandEvents
  let lastPosition = 0

  console.log('[watchCommands] Starting to watch:', commandPath)

  readFile(commandPath, 'utf8').then(content => {
    lastPosition = content.length
    console.log('[watchCommands] Initial file size:', lastPosition)
  }).catch(() => {
    console.log('[watchCommands] Command file not found, will start from beginning')
    lastPosition = 0
  })

  commandWatcher = watch(commandPath, async (eventType) => {
    if (eventType !== 'change') return
    try {
      const content = await readFile(commandPath, 'utf8')
      const newContent = content.slice(lastPosition)
      lastPosition = content.length
      if (!newContent.trim()) return

      const lines = newContent.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const evt = JSON.parse(line)
          const playerName = (evt.player ?? '').toString().trim()
          const message = (evt.message ?? '').toString().trim()
          if (!playerName || !message) continue

          const msg: ChatMessage = {
            player: { name: playerName, id: playerName },
            message: message,
            timestamp: new Date()
          }
          if (messageCallback) {
            messageCallback(msg)
          }
        } catch {
          // Ignore malformed lines
        }
      }
    } catch (err) {
      console.error('[watchCommands] Error:', err)
    }
  })

  console.log('Watching command events at:', commandPath)
}

export function setMessageCallback(callback: (msg: ChatMessage) => void) {
  console.log('[setMessageCallback] Callback registered')
  messageCallback = callback
}

export function setJoinCallback(callback: (player: { name: string; id: string }) => void) {
  console.log('[setJoinCallback] Callback registered')
  joinCallback = callback
}

export function setLeaveCallback(callback: (player: { name: string; id: string }) => void) {
  console.log('[setLeaveCallback] Callback registered')
  leaveCallback = callback
}

export function setKillCallback(callback: (killer: string, victim: string) => void) {
  console.log('[setKillCallback] Callback registered')
  killCallback = callback
}

export function unwatchChat() {
  if (chatWatcher) {
    chatWatcher.close()
    chatWatcher = null
  }
}

export function unwatchCommandEvents() {
  if (commandWatcher) {
    commandWatcher.close()
    commandWatcher = null
  }
}
