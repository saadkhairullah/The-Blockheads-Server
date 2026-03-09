import { spawn } from 'child_process'
import * as BlockheadService from '../../blockhead-service'
import {
  QuestContext, InventoryCache,
  INVENTORY_POLL_INTERVAL, MAX_INVENTORY_CACHE,
  INVENTORY_INACTIVITY_MS, FAST_INVENTORY_SCRIPT,
  PYTHON_PATH, WORLD_SAVE_PATH,
  LOG_QUEST_CACHE, LOG_BOT_DEBUG,
} from './quest-context'
import { getKnownBlockheadsForPlayer } from './quest-resolver'

let inventoryPollTimer: NodeJS.Timeout | null = null
let inventoryPollInProgress = false

export const setInventoryCacheEntry = (ctx: QuestContext, playerName: string, entry: InventoryCache) => {
  if (ctx.inventoryCache.has(playerName)) {
    ctx.inventoryCache.delete(playerName)
  }
  ctx.inventoryCache.set(playerName, entry)
  while (ctx.inventoryCache.size > MAX_INVENTORY_CACHE) {
    const oldestKey = ctx.inventoryCache.keys().next().value
    ctx.inventoryCache.delete(oldestKey)
  }
}

export const getInventoryCount = (ctx: QuestContext, playerName: string, itemId: number): number => {
  const cache = ctx.inventoryCache.get(playerName)
  if (!cache) return 0
  return cache.items[String(itemId)] ?? 0
}

export const hasFreshInventory = (ctx: QuestContext, playerName: string): boolean => {
  const cache = ctx.inventoryCache.get(playerName)
  if (!cache) return false
  return (Date.now() - cache.lastUpdated) <= (INVENTORY_POLL_INTERVAL * 2)
}

export const getPlayerInventoryCounts = async (blockheadId: number, playerUuid: string): Promise<{ [itemId: string]: number } | null> => {
  try {
    const counts = await BlockheadService.getInventoryCounts(blockheadId, playerUuid)
    return counts as { [itemId: string]: number } | null
  } catch {
    return null
  }
}

export const getPlayerInventoryCountsAny = async (playerUuid: string): Promise<{ [itemId: string]: number } | null> => {
  try {
    const counts = await BlockheadService.getPlayerInventoryCounts(playerUuid)
    return counts as { [itemId: string]: number }
  } catch {
    return null
  }
}

type BatchBlockhead = { blockheadId: number; items: { [itemId: string]: number } }
type BatchEntry = { playerUuid: string; blockheads: BatchBlockhead[] }

export const getBatchInventoryCounts = (playerUuids: string[]): Promise<Map<string, BatchEntry>> => {
  return new Promise((resolve) => {
    if (playerUuids.length === 0) {
      resolve(new Map())
      return
    }
    const args = [
      FAST_INVENTORY_SCRIPT,
      '--inventory-counts-batch',
      '--save-path', WORLD_SAVE_PATH,
      '--player-uuids-json', JSON.stringify(playerUuids),
    ]
    const proc = spawn(PYTHON_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let finished = false

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true
        console.warn('[Quest System] Inventory batch timeout, killing process')
        proc.kill('SIGKILL')
        resolve(new Map())
      }
    }, 30000)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.on('close', (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (code !== 0) {
        resolve(new Map())
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim())
        const map = new Map<string, BatchEntry>()
        if (parsed && Array.isArray(parsed.players)) {
          for (const entry of parsed.players) {
            if (!entry || typeof entry.playerUuid !== 'string') continue
            const blockheads = Array.isArray(entry.blockheads) ? entry.blockheads : []
            map.set(entry.playerUuid, { playerUuid: entry.playerUuid, blockheads })
          }
        }
        resolve(map)
      } catch {
        resolve(new Map())
      }
    })
  })
}

export const pollOnlinePlayerInventories = async (ctx: QuestContext) => {
  if (inventoryPollInProgress) {
    console.warn('[Quest System] Skipping poll - previous poll still in progress')
    return
  }
  inventoryPollInProgress = true

  try {
    const now = Date.now()
    const activePlayers = Array.from(ctx.onlinePlayers).filter(name => {
      const lastActive = ctx.playerLastActivity.get(name)
      if (lastActive && (now - lastActive) > INVENTORY_INACTIVITY_MS) {
        return false
      }
      return true
    })

    if (activePlayers.length === 0) return

    const uuidList: string[] = []
    const playerByUuid = new Map<string, string>()
    for (const name of activePlayers) {
      const uuid = ctx.playerToUuid.get(name)
      if (!uuid) continue
      uuidList.push(uuid)
      playerByUuid.set(uuid, name)
    }

    if (uuidList.length === 0) return

    const batch = await getBatchInventoryCounts(uuidList)
    for (const uuid of uuidList) {
      const playerName = playerByUuid.get(uuid)
      if (!playerName) continue
      if (!ctx.onlinePlayers.has(playerName)) continue
      const entry = batch.get(uuid)
      if (!entry || !entry.blockheads || entry.blockheads.length === 0) continue

      let cacheBlockheadId = -1
      let cacheItems: { [itemId: string]: number } = {}

      if (entry.blockheads.length === 1) {
        cacheBlockheadId = typeof entry.blockheads[0].blockheadId === 'number' ? entry.blockheads[0].blockheadId : -1
        cacheItems = entry.blockheads[0].items ?? {}
      } else {
        const merged: { [itemId: string]: number } = {}
        for (const bh of entry.blockheads) {
          if (!bh || !bh.items) continue
          for (const [itemId, count] of Object.entries(bh.items)) {
            const numCount = typeof count === 'number' ? count : 0
            if (numCount > 0) {
              merged[itemId] = (merged[itemId] ?? 0) + numCount
            }
          }
        }
        cacheItems = merged
        cacheBlockheadId = -1
      }

      setInventoryCacheEntry(ctx, playerName, {
        items: cacheItems,
        lastUpdated: Date.now(),
        blockheadId: cacheBlockheadId
      })

      if (LOG_QUEST_CACHE) {
        const label = cacheBlockheadId >= 0 ? `(blockhead ${cacheBlockheadId})` : '(all blockheads)'
        if (LOG_BOT_DEBUG) console.log(`[Quest System] ${playerName} inventory cached ${label}`)
      }

      ctx.checkQuestCompletion(playerName)
    }
  } finally {
    inventoryPollInProgress = false
  }
}

export const startInventoryPolling = (ctx: QuestContext) => {
  if (inventoryPollTimer) return

  inventoryPollTimer = setInterval(() => {
    pollOnlinePlayerInventories(ctx).catch(err => {
      console.error('[Quest System] Inventory poll error:', err)
    })
  }, INVENTORY_POLL_INTERVAL)

  console.log(`[Quest System] Started inventory polling every ${INVENTORY_POLL_INTERVAL}ms`)
}

export const stopInventoryPolling = () => {
  if (inventoryPollTimer) {
    clearInterval(inventoryPollTimer)
    inventoryPollTimer = null
  }
}

export const refreshInventoryOnMove = async (ctx: QuestContext, playerName: string, blockheadId: number) => {
  if (ctx.inflightInventoryRefresh.has(playerName)) return
  ctx.inflightInventoryRefresh.add(playerName)
  ctx.pendingInventoryRefresh.delete(playerName)
  try {
    const playerUuid = ctx.playerToUuid.get(playerName)
    if (!playerUuid) return
    const knownIds = getKnownBlockheadsForPlayer(ctx, playerName)
    if (knownIds.length > 1) {
      const counts = await getPlayerInventoryCountsAny(playerUuid)
      if (counts) {
        setInventoryCacheEntry(ctx, playerName, { items: counts, lastUpdated: Date.now(), blockheadId: -1 })
      }
      return
    }
    const targetId = knownIds[0] ?? blockheadId
    const counts = await getPlayerInventoryCounts(targetId, playerUuid)
    if (counts) {
      setInventoryCacheEntry(ctx, playerName, { items: counts, lastUpdated: Date.now(), blockheadId: targetId })
    }
  } finally {
    ctx.inflightInventoryRefresh.delete(playerName)
  }
}
