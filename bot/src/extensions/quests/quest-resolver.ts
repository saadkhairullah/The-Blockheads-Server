import { QuestContext, LOG_BOT_DEBUG } from './quest-context'
import { ActivityEvent } from '../types/shared-types'
import * as BlockheadService from '../../blockhead-service'
import { playerManager, listBlockheadsForPlayerByUuid, listAndMapBlockheads } from '../helpers/blockhead-mapping'
import { getActivityMonitorAPI as _getActivityMonitorAPI } from '../helpers/extension-api'

/**
 * Update playerManager from an event, then update quest-specific state
 * (blockheadNameIndex, pendingBlockheadName, lastBlockheadId).
 */
export const trackBlockheadOwner = (_ctx: QuestContext, event: ActivityEvent) => {
  if (typeof event.blockheadId !== 'number') return

  // Index blockhead name → id (server-unique character names)
  if (event.blockheadName && event.blockheadName !== '?') {
    playerManager.blockheadNameIndex.set(event.blockheadName, event.blockheadId)
  } else if (event.player && !event.player.startsWith('Blockhead#')) {
    playerManager.blockheadNameIndex.set(event.player, event.blockheadId)
  }

  // Shared-map writes via playerManager
  playerManager.updateFromEvent(event)

  // Update lastBlockheadId on the player
  const ownerName = event.playerAccount ?? (event.player && !event.player.startsWith('Blockhead#') ? event.player : null)
  if (ownerName && ownerName !== '?') {
    const p = playerManager.get(ownerName)
    if (p) p.lastBlockheadId = event.blockheadId
  }
  if (event.playerUUID) {
    const p = playerManager.getByUuid(event.playerUUID)
    if (p) p.lastBlockheadId = event.blockheadId
  } else {
    const p = playerManager.getByBlockheadId(event.blockheadId)
    if (p) p.lastBlockheadId = event.blockheadId
  }

  // Resolve pendingBlockheadName → lastBlockheadId
  if (event.blockheadName) {
    for (const p of playerManager.online()) {
      if (p.pendingBlockheadName === event.blockheadName) {
        p.lastBlockheadId = event.blockheadId
        p.pendingBlockheadName = null
      }
    }
  }
}

export const ensureBlockheadOwner = async (_ctx: QuestContext, blockheadId: number, playerUuid?: string): Promise<string | null> => {
  const cached = playerManager.getByBlockheadId(blockheadId)?.uuid
  if (cached) return cached
  let owner = await resolveOwnerUuidForBlockhead(blockheadId)
  if (!owner && typeof playerUuid === 'string') {
    const ids = await listBlockheadsForPlayerByUuid(playerUuid)
    if (ids.includes(blockheadId)) {
      owner = playerUuid
    }
  }
  if (owner) {
    const p = playerManager.getByUuid(owner)
    if (p) playerManager.attachBlockheads(p, [blockheadId])
  }
  return owner
}

const resolveOwnerUuidForBlockhead = async (blockheadId: number): Promise<string | null> => {
  // Check reverse index first
  const player = playerManager.getByBlockheadId(blockheadId)
  if (player) return player.uuid

  // Try refreshing all online players
  for (const p of playerManager.online()) {
    await listAndMapBlockheads(p.name, p.uuid)
    const refreshed = playerManager.getByBlockheadId(blockheadId)
    if (refreshed) return refreshed.uuid
  }
  return null
}

export const getBlockheadsFromActivityMonitor = (bot: any, playerName: string): number[] => {
  const activityAPI = _getActivityMonitorAPI(bot)
  if (!activityAPI || typeof activityAPI.getBlockheadsForPlayer !== 'function') {
    return []
  }
  try {
    const ids = activityAPI.getBlockheadsForPlayer(playerName)
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

export const getKnownBlockheadsForPlayer = (ctx: QuestContext, playerName: string): number[] => {
  const p = playerManager.get(playerName)
  if (p && p.blockheads.size > 0) return Array.from(p.blockheads.keys())
  const fallback = getBlockheadsFromActivityMonitor(ctx.bot, playerName)
  return fallback ?? []
}

export const isActiveBlockheadForPlayer = (_ctx: QuestContext, playerName: string, blockheadId: number): boolean => {
  const p = playerManager.get(playerName)
  if (!p?.isOnline) return false
  const bh = p.blockheads.get(blockheadId)
  if (!bh?.lastCoords) return false
  if (Date.now() - bh.lastCoords.time > 120000) return false
  return p.blockheads.has(blockheadId)
}

export const getBlockheadForPlayer = (ctx: QuestContext, playerName: string): number | null => {
  const p = playerManager.get(playerName)
  if (!p) return null

  const last = p.lastBlockheadId
  if (typeof last === 'number' && isActiveBlockheadForPlayer(ctx, playerName, last)) {
    if (LOG_BOT_DEBUG) console.log(`[Quest Debug] getBlockheadForPlayer(${playerName}): using lastActive=${last}`)
    return last
  }

  const resolvedIds = p.blockheads.size > 0
    ? Array.from(p.blockheads.keys())
    : getBlockheadsFromActivityMonitor(ctx.bot, playerName)

  if (resolvedIds && resolvedIds.length > 0) {
    let bestId: number | null = null
    let bestTime = -1
    for (const id of resolvedIds) {
      const bh = p.blockheads.get(id)
      if (bh?.lastCoords && bh.lastCoords.time > bestTime && isActiveBlockheadForPlayer(ctx, playerName, id)) {
        bestTime = bh.lastCoords.time
        bestId = id
      }
    }
    if (bestId !== null) {
      if (LOG_BOT_DEBUG) console.log(`[Quest Debug] getBlockheadForPlayer(${playerName}): using blockhead=${bestId} with coords (verified active)`)
      return bestId
    }
  }

  if (LOG_BOT_DEBUG) console.log(`[Quest Debug] getBlockheadForPlayer(${playerName}): NO ACTIVE blockhead (player needs to move first)`)
  return null
}

export const resolveBlockheadId = async (ctx: QuestContext, playerName: string): Promise<number | null> => {
  const existing = getBlockheadForPlayer(ctx, playerName)
  if (existing !== null) {
    if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): found cached blockhead=${existing}`)
    return existing
  }
  const playerUuid = playerManager.get(playerName)?.uuid
  if (!playerUuid) {
    if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): NO playerUuid found`)
    return null
  }
  if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): querying LMDB for uuid=${playerUuid}`)
  const ids = await listAndMapBlockheads(playerName, playerUuid)
  if (ids.length === 0) {
    if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): LMDB returned no blockheads`)
    return null
  }
  const p = playerManager.get(playerName)
  let bestId: number | null = null
  let bestTime = -1
  for (const id of ids) {
    const bh = p?.blockheads.get(id)
    if (bh?.lastCoords && bh.lastCoords.time > bestTime) {
      bestTime = bh.lastCoords.time
      bestId = id
    }
  }
  const result = bestId ?? ids[0]
  if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): LMDB ids=[${ids.join(',')}] bestByCoords=${bestId} result=${result}`)
  return result
}

export const findBlockheadsWithItems = async (ctx: QuestContext, playerName: string, itemIds: number[]): Promise<number[]> => {
  const playerUuid = playerManager.get(playerName)?.uuid
  if (!playerUuid) return []

  const p = playerManager.get(playerName)
  const knownIds = getKnownBlockheadsForPlayer(ctx, playerName)
  const allIds = new Set<number>(knownIds)
  if (p?.lastBlockheadId != null) allIds.add(p.lastBlockheadId)

  const result: number[] = []
  for (const bhId of allIds) {
    const counts = await getPlayerInventoryCounts(bhId, playerUuid)
    if (!counts) continue
    const hasAll = itemIds.every(id => (counts[String(id)] ?? 0) > 0)
    if (hasAll) result.push(bhId)
  }
  return result
}

const getPlayerInventoryCounts = async (blockheadId: number, playerUuid: string): Promise<{ [itemId: string]: number } | null> => {
  try {
    const counts = await BlockheadService.getInventoryCounts(blockheadId, playerUuid)
    return counts as { [itemId: string]: number } | null
  } catch {
    return null
  }
}
