import * as BlockheadService from '../../blockhead-service'
import {
  QuestContext, InventoryCache,
  INVENTORY_POLL_INTERVAL, MAX_INVENTORY_CACHE,
  INVENTORY_INACTIVITY_MS,
  LOG_QUEST_CACHE, LOG_BOT_DEBUG,
} from './quest-context'
import { playerManager } from '../helpers/blockhead-mapping'
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

export const pollOnlinePlayerInventories = async (ctx: QuestContext) => {
  if (inventoryPollInProgress) {
    console.warn('[Quest System] Skipping poll - previous poll still in progress')
    return
  }
  inventoryPollInProgress = true

  try {
    const now = Date.now()
    const activePlayers = Array.from(playerManager.online())
      .filter(p => {
        const lastActive = p.lastActivity
        return !(lastActive && (now - lastActive) > INVENTORY_INACTIVITY_MS)
      })

    if (activePlayers.length === 0) return

    await Promise.all(activePlayers.map(async (p) => {
      const uuid = p.uuid
      if (!uuid) return

      const counts = await BlockheadService.getPlayerInventoryCounts(uuid)
      if (!counts || Object.keys(counts).length === 0) return
      if (!p.isOnline) return

      setInventoryCacheEntry(ctx, p.name, {
        items: counts as { [itemId: string]: number },
        lastUpdated: Date.now(),
        blockheadId: -1,
      })

      if (LOG_QUEST_CACHE && LOG_BOT_DEBUG) {
        console.log(`[Quest System] ${p.name} inventory cached`)
      }

      ctx.checkQuestCompletion(p.name)
    }))
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
    const playerUuid = playerManager.get(playerName)?.uuid
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
