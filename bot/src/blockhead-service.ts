/**
 * Shared blockhead service using Python daemon.
 *
 * KEY OPTIMIZATION: Instead of spawning Python for each operation (~200ms overhead),
 * we keep a single daemon running that:
 * - Keeps LMDB open (no open/close overhead)
 * - Batches writes (auto-saves every 10 seconds)
 * - Responds in ~1-5ms per operation
 *
 * This turns 10 separate saves into 1 batched save!
 */

import { spawn, ChildProcess, execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { createInterface, Interface } from 'readline'

// Daemon state
let daemon: ChildProcess | null = null
let daemonReady = false
let daemonStarting: Promise<void> | null = null  // Track in-flight startup
let daemonStdout: Interface | null = null
let pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>()
let requestId = 0
let consecutiveTimeouts = 0

const execFileAsync = promisify(execFile)

// Concurrency limiter to prevent request pileup and deadlock
const MAX_CONCURRENT_REQUESTS = 4  // Keep low to prevent stdout buffer overflow
let activeRequests = 0
const requestQueue: Array<{ execute: () => void }> = []

const acquireSlot = (): Promise<void> => {
  return new Promise(resolve => {
    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
      activeRequests++
      resolve()
    } else {
      requestQueue.push({ execute: () => { activeRequests++; resolve() } })
    }
  })
}

const releaseSlot = (): void => {
  activeRequests--
  // Use setImmediate to prevent microtask starvation
  if (requestQueue.length > 0) {
    setImmediate(() => {
      const next = requestQueue.shift()
      if (next) next.execute()
    })
  }
}

const killDaemonProcess = () => {
  if (!daemon) return
  try {
    daemon.kill('SIGKILL')
  } catch (err) {
    console.warn('[BlockheadService] Failed to kill daemon process:', err)
  } finally {
    daemon = null
    daemonReady = false
    daemonStarting = null
  }
}

const pingDaemon = async (timeoutMs = 1500): Promise<boolean> => {
  try {
    const pong = await sendCommandWithTimeout<{ ok?: boolean }>(
      { op: 'ping' },
      timeoutMs,
      false
    )
    return Boolean(pong && pong.ok)
  } catch {
    return false
  }
}

// In-memory caches (populated from daemon responses)
const playerToBlockheads = new Map<string, Set<number>>()
const blockheadToPlayer = new Map<number, string>()
const MAX_CACHE_SIZE = 1000

// Prune cache if too large
const pruneCaches = () => {
  if (playerToBlockheads.size > MAX_CACHE_SIZE) {
    const entries = Array.from(playerToBlockheads.entries())
    playerToBlockheads.clear()
    for (const [k, v] of entries.slice(-MAX_CACHE_SIZE)) {
      playerToBlockheads.set(k, v)
    }
  }
  if (blockheadToPlayer.size > MAX_CACHE_SIZE * 5) { // Players can have multiple blockheads
    const entries = Array.from(blockheadToPlayer.entries())
    blockheadToPlayer.clear()
    for (const [k, v] of entries.slice(-MAX_CACHE_SIZE * 5)) {
      blockheadToPlayer.set(k, v)
    }
  }
}

// Configuration
let pythonPath = 'python3'
let rewardScript = ''
let worldSavePath = ''
let autoSaveInterval = 10
let initialized = false

/**
 * Initialize the blockhead service.
 */
export const initBlockheadService = (python: string, script: string, savePath: string, saveInterval = 10) => {
  pythonPath = python
  rewardScript = script
  worldSavePath = savePath
  autoSaveInterval = saveInterval
  initialized = true
}

/**
 * Start the daemon if not already running.
 */
const ensureDaemon = async (): Promise<void> => {
  // Already running
  if (daemon && daemonReady) {
    return Promise.resolve()
  }

  // Already starting - wait for that to complete
  if (daemonStarting) {
    return daemonStarting
  }

  if (!initialized) {
    return Promise.reject(new Error('[BlockheadService] Not initialized'))
  }

  if (daemon) {
    const alive = await pingDaemon()
    if (alive) {
      daemonReady = true
      return
    }
    killDaemonProcess()
  }

  daemonStarting = new Promise((resolve, reject) => {
    console.log('[BlockheadService] Starting daemon...')

    daemon = spawn(pythonPath, [
      rewardScript,
      '--daemon',
      '--save-path', worldSavePath,
      '--auto-save-interval', String(autoSaveInterval),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    daemon.on('error', (err) => {
      console.error('[BlockheadService] Daemon error:', err)
      killDaemonProcess()
      reject(err)
    })

    daemon.on('exit', (code, signal) => {
      console.log(`[BlockheadService] Daemon exited with code ${code} signal ${signal}`)
      killDaemonProcess()
      // Reject all pending requests
      for (const [, { reject: rej }] of pendingRequests) {
        rej(new Error('Daemon exited'))
      }
      pendingRequests.clear()
    })


    // Set up stdout reader
    daemonStdout = createInterface({ input: daemon.stdout! })

    daemonStdout.on('line', (line) => {
      if (!line.trim()) return

      try {
        const response = JSON.parse(line)

        // Check for ready signal
        if (response.ready) {
          console.log(`[BlockheadService] Daemon ready (auto-save: ${response.autoSaveInterval}s)`)
          daemonReady = true
          daemonStarting = null
          resolve()
          return
        }

        consecutiveTimeouts = 0
        // Pop oldest pending request (FIFO order)
        if (pendingRequests.size > 0) {
          const [id, { resolve: res }] = pendingRequests.entries().next().value
          pendingRequests.delete(id)
          res(response)
        
        }
      } catch (err) {
        console.error('[BlockheadService] Failed to parse daemon response:', line)
      }
    })

    // Timeout for startup
    setTimeout(() => {
      if (!daemonReady) {
        daemonStarting = null
        reject(new Error('Daemon startup timeout'))
        killDaemonProcess()
      }
    }, 30000)
  })

  return daemonStarting
}

/**
 * Send a command to the daemon and wait for response.
 * Uses concurrency limiter to prevent request pileup.
 */
const sendCommand = async <T>(cmd: object): Promise<T> => {
  // Wait for a slot - prevents overwhelming the daemon
  await acquireSlot()

  try {
    await ensureDaemon()

    if (!daemon || !daemon.stdin) {
      throw new Error('[BlockheadService] Daemon is not running')
    }

    return await sendCommandWithTimeout<T>(cmd, 120000, true)
  } finally {
    releaseSlot()
  }
}

const sendCommandWithTimeout = async <T>(cmd: object, timeoutMs: number, allowRestart: boolean): Promise<T> => {
  if (!daemon || !daemon.stdin) {
    throw new Error('[BlockheadService] Daemon is not running')
  }

  return new Promise((resolve, reject) => {
    const id = ++requestId
    pendingRequests.set(id, { resolve, reject })

    // Warn if too many pending requests - could indicate daemon is overwhelmed
    if (pendingRequests.size > 20) {
      console.warn(`[BlockheadService] WARNING: ${pendingRequests.size} pending requests - daemon may be overwhelmed`)
    }

    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        consecutiveTimeouts += 1
        daemonReady = false
        if (daemon && consecutiveTimeouts >= 2 && allowRestart) {
          killDaemonProcess()
        }
        reject(new Error('Command timeout'))
      }
    }, timeoutMs) // allow up to 120s for heavy LMDB ops

    const json = JSON.stringify(cmd) + '\n'
    const canWrite = daemon!.stdin!.write(json, (err) => {
      if (err) {
        clearTimeout(timeout)
        pendingRequests.delete(id)
        reject(err)
      }
    })

    // Handle backpressure - if buffer is full, log warning
    // The write is still queued, but daemon is overwhelmed
    if (!canWrite) {
      console.warn('[BlockheadService] Stdin buffer full - daemon is very slow')
    }

    // Wrap resolve to clear timeout
    const origResolve = pendingRequests.get(id)!.resolve
    pendingRequests.set(id, {
      resolve: (val) => {
        clearTimeout(timeout)
        origResolve(val)
      },
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      }
    })
  })
}

/**
 * Get all blockhead IDs for a player UUID.
 */
export const getBlockheadsForPlayer = async (playerUuid: string): Promise<number[]> => {
  try {
    // Check cache first
    const cached = playerToBlockheads.get(playerUuid)
    if (cached) {
      return Array.from(cached)
    }

    const response = await sendCommand<{ ok?: boolean, blockheadIds?: number[], error?: string }>({
      op: 'list-blockheads',
      playerUuid,
    })

    if (response.error) {
      console.error(`[BlockheadService] Error listing blockheads: ${response.error}`)
      return []
    }

    const ids = response.blockheadIds || []

    // Update caches
    playerToBlockheads.set(playerUuid, new Set(ids))
    for (const id of ids) {
      blockheadToPlayer.set(id, playerUuid)
    }

    return ids
  } catch (err) {
    console.error('[BlockheadService] list-blockheads failed:', err)
    return []
  }
}

/**
 * Fast owner lookup for a blockhead using candidate player UUIDs.
 * Uses direct LMDB key existence checks (no daemon) without full scans.
 */
export const findOwnerForBlockheadFast = async (blockheadId: number, candidateUuids: string[]): Promise<string | null> => {
  try {
    if (!candidateUuids || candidateUuids.length === 0) {
      return null
    }
    if (!worldSavePath || !rewardScript) {
      throw new Error('BlockheadService not initialized')
    }

    const lookupScript = path.join(path.dirname(rewardScript), 'fast_owner_lookup.py')
    const args = [
      lookupScript,
      '--save-path', worldSavePath,
      '--blockhead-id', String(blockheadId),
      '--candidate-uuids-json', JSON.stringify(candidateUuids),
    ]
    const { stdout } = await execFileAsync(pythonPath, args, {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    })
    const output = stdout.toString().trim().split('\n').pop() ?? ''
    const response = output ? JSON.parse(output) : {}

    if (response && response.playerUuid) {
      blockheadToPlayer.set(blockheadId, response.playerUuid)
      pruneCaches()
      return response.playerUuid
    }
    return null
  } catch (err) {
    console.error('[BlockheadService] find-blockhead-owner-fast failed:', err)
    return null
  }
}


/**
 * Fetch the full player->blockheads index from daemon.
 * Returns a Map of playerUuid -> Set of blockheadIds.
 * Also populates local caches.
 */
export const getFullBlockheadIndex = async (): Promise<Map<string, Set<number>>> => {
  try {
    const response = await sendCommand<{ ok?: boolean, index?: Record<string, number[]>, error?: string }>({
      op: 'get-full-index',
    })

    if (response.error || !response.index) {
      console.error(`[BlockheadService] Error fetching full index: ${response.error}`)
      return new Map()
    }

    const result = new Map<string, Set<number>>()
    for (const [playerUuid, blockheadIds] of Object.entries(response.index)) {
      const idSet = new Set(blockheadIds)
      result.set(playerUuid, idSet)
      // Populate local caches
      playerToBlockheads.set(playerUuid, idSet)
      for (const id of blockheadIds) {
        blockheadToPlayer.set(id, playerUuid)
      }
    }

    console.log(`[BlockheadService] Loaded full index: ${result.size} players, ${blockheadToPlayer.size} blockheads`)
    return result
  } catch (err) {
    console.error('[BlockheadService] getFullBlockheadIndex failed:', err)
    return new Map()
  }
}

/**
 * Get blockhead IDs and names for a player UUID (reads from _blockheads key).
 */
export const getBlockheadNames = async (playerUuid: string): Promise<{ blockheadId: number, name: string }[]> => {
  try {
    const response = await sendCommand<{ ok?: boolean, blockheads?: { blockheadId: number, name: string }[], error?: string }>({
      op: 'list-blockheads-with-names',
      playerUuid,
    })

    if (response.error || !response.blockheads) {
      console.error(`[BlockheadService] Error listing blockhead names: ${response.error}`)
      return []
    }

    return response.blockheads
  } catch (err) {
    console.error('[BlockheadService] getBlockheadNames failed:', err)
    return []
  }
}

/**
 * Give item to a blockhead (deferred save).
 */
export const giveItem = async (blockheadId: number, itemId: number, count = 1, playerUuid?: string, basketOnly = false): Promise<{ ok: boolean, error?: string }> => {
  try {
    const response = await sendCommand<{ ok?: boolean, error?: string }>({
      op: 'give-item',
      blockheadId,
      itemId,
      count,
      playerUuid,
      basketOnly,
    })

    return { ok: response.ok === true, error: response.error }
  } catch (err) {
    console.error('[BlockheadService] giveItem failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Take item from a blockhead (deferred save).
 */
export const takeItem = async (blockheadId: number, itemId: number, count = 1, playerUuid?: string): Promise<{ success: boolean, taken?: number, error?: string }> => {
  try {
    const response = await sendCommand<{ success?: boolean, taken?: number, error?: string }>({
      op: 'take-item',
      blockheadId,
      itemId,
      count,
      playerUuid,
    })

    return {
      success: response.success === true,
      taken: response.taken,
      error: response.error,
    }
  } catch (err) {
    console.error('[BlockheadService] takeItem failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Apply quest items (remove + give in one operation, deferred save).
 */
export const applyQuestItems = async (
  blockheadId: number,
  removeItems: { itemId: number, count: number }[],
  giveItems: { itemId: number, count: number }[],
  playerUuid?: string
): Promise<{ success: boolean, error?: string }> => {
  try {
    const response = await sendCommand<{ success?: boolean, error?: string }>({
      op: 'apply-quest-items',
      blockheadId,
      removeItems,
      giveItems,
      playerUuid,
    })

    return {
      success: response.success === true,
      error: response.error,
    }
  } catch (err) {
    console.error('[BlockheadService] applyQuestItems failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Teleport a blockhead to specific coordinates (deferred save).
 */
export const teleportBlockhead = async (
  blockheadId: number,
  x: number,
  y: number,
  playerUuid?: string
): Promise<{ ok: boolean, error?: string }> => {
  try {
    const response = await sendCommand<{ ok?: boolean, error?: string }>({
      op: 'teleport-blockhead',
      blockheadId,
      x,
      y,
      playerUuid,
    })

    return { ok: response.ok === true, error: response.error }
  } catch (err) {
    console.error('[BlockheadService] teleportBlockhead failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Get a blockhead's current position from LMDB.
 */
export const getBlockheadPosition = async (
  blockheadId: number,
  playerUuid?: string
): Promise<{ ok: boolean, x?: number, y?: number, error?: string }> => {
  try {
    const response = await sendCommand<{ ok?: boolean, x?: number, y?: number, error?: string }>({
      op: 'get-blockhead-position',
      blockheadId,
      playerUuid,
    })

    return { ok: response.ok === true, x: response.x, y: response.y, error: response.error }
  } catch (err) {
    console.error('[BlockheadService] getBlockheadPosition failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Get inventory counts for a blockhead.
 */
export const getInventoryCounts = async (blockheadId: number): Promise<Record<number, number> | null> => {
  try {
    const response = await sendCommand<{ ok?: boolean, items?: Record<number, number>, error?: string }>({
      op: 'inventory-counts',
      blockheadId,
    })

    if (response.error) {
      return null
    }

    return response.items || {}
  } catch (err) {
    console.error('[BlockheadService] inventory-counts failed:', err)
    return null
  }
}

/**
 * Get combined inventory counts for all blockheads of a player.
 */
export const getPlayerInventoryCounts = async (playerUuid: string): Promise<Record<number, number>> => {
  try {
    const response = await sendCommand<{ ok?: boolean, items?: Record<number, number>, error?: string }>({
      op: 'player-inventory-counts',
      playerUuid,
    })

    return response.items || {}
  } catch (err) {
    console.error('[BlockheadService] player-inventory-counts failed:', err)
    return {}
  }
}

/**
 * Check if a blockhead has any free inventory slot (including baskets).
 */




// --- Cache utilities (no daemon calls) ---


// Periodically prune caches to prevent memory leaks
setInterval(pruneCaches, 5 * 60 * 1000)

// Periodic health check - log status every 10 minutes to help diagnose freezes
setInterval(() => {
  const pending = pendingRequests.size
  const memUsage = process.memoryUsage()
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024)
  if (pending > 5 || heapMB > 500) {
    console.log(`[BlockheadService] Health: pending=${pending}, heap=${heapMB}MB, ready=${daemonReady}`)
  }
}, 10 * 60 * 1000)
