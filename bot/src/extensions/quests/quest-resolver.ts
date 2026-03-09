import { QuestContext, LOG_BOT_DEBUG } from './quest-context'
import { ActivityEvent } from '../types/shared-types'
import * as BlockheadService from '../../blockhead-service'
import { sharedMappingState, updateMappingsFromEvent, listBlockheadsForPlayerByUuid, listAndMapBlockheads } from '../helpers/blockhead-mapping'
import { getActivityMonitorAPI as _getActivityMonitorAPI } from '../helpers/extension-api'

/**
 * Update quest-specific Maps from an event, then delegate shared-map writes
 * to updateMappingsFromEvent in blockhead-mapping.
 */
export const trackBlockheadOwner = (ctx: QuestContext, event: ActivityEvent) => {
  if (typeof event.blockheadId !== 'number') return

  // Quest-specific: blockheadNameToId
  if (event.blockheadName && event.blockheadName !== '?') {
    ctx.blockheadNameToId.set(event.blockheadName, event.blockheadId)
  } else if (event.player && !event.player.startsWith('Blockhead#')) {
    ctx.blockheadNameToId.set(event.player, event.blockheadId)
  }

  // Quest-specific: blockheadIdToUuid cache
  if (event.playerUUID) {
    ctx.blockheadIdToUuid.set(event.blockheadId, event.playerUUID)
  }

  // Shared-map writes (playerToBlockheads, blockheadToPlayer, playerToUuid, etc.)
  updateMappingsFromEvent(event, sharedMappingState)

  // Quest-specific: playerToLastBlockhead
  const ownerName = event.playerAccount ?? (event.player && !event.player.startsWith('Blockhead#') ? event.player : null)
  if (ownerName && ownerName !== '?') {
    ctx.playerToLastBlockhead.set(ownerName, event.blockheadId)
  }
  if (event.playerUUID) {
    const knownName = ctx.uuidToPlayer.get(event.playerUUID)
    if (knownName) {
      ctx.playerToLastBlockhead.set(knownName, event.blockheadId)
    }
  } else {
    const cachedUuid = ctx.blockheadIdToUuid.get(event.blockheadId)
    if (cachedUuid) {
      const knownName = ctx.uuidToPlayer.get(cachedUuid)
      if (knownName) {
        ctx.playerToLastBlockhead.set(knownName, event.blockheadId)
      }
    }
  }

  // Quest-specific: resolve pendingBlockheadName
  if (event.blockheadName) {
    for (const [playerName, blockheadName] of ctx.pendingBlockheadName.entries()) {
      if (blockheadName === event.blockheadName) {
        ctx.playerToLastBlockhead.set(playerName, event.blockheadId)
        ctx.pendingBlockheadName.delete(playerName)
      }
    }
  }
}

export const ensureBlockheadOwner = async (ctx: QuestContext, blockheadId: number, playerUuid?: string): Promise<string | null> => {
  const cached = ctx.blockheadToOwnerUuid.get(blockheadId)
  if (cached) return cached
  let owner = await resolveOwnerUuidForBlockhead(ctx, blockheadId)
  if (!owner && typeof playerUuid === 'string') {
    const ids = await listBlockheadsForPlayerByUuid(playerUuid)
    if (ids.includes(blockheadId)) {
      owner = playerUuid
    }
  }
  if (owner) {
    ctx.blockheadToOwnerUuid.set(blockheadId, owner)
  }
  return owner
}

const resolveOwnerUuidForBlockhead = async (ctx: QuestContext, blockheadId: number): Promise<string | null> => {
  const cached = ctx.blockheadToOwnerUuid.get(blockheadId)
  if (cached) return cached
  const directName = ctx.blockheadToPlayer.get(blockheadId)
  if (directName) {
    const uuid = ctx.playerToUuid.get(directName)
    if (uuid) return uuid
  }
  for (const [name, ids] of ctx.playerToBlockheads.entries()) {
    if (ids.has(blockheadId)) {
      const uuid = ctx.playerToUuid.get(name)
      if (uuid) return uuid
    }
  }
  for (const name of ctx.onlinePlayers) {
    const uuid = ctx.playerToUuid.get(name)
    if (!uuid) continue
    await listAndMapBlockheads(name, uuid)
    const refreshed = ctx.blockheadToOwnerUuid.get(blockheadId)
    if (refreshed) return refreshed
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
  const ids = ctx.playerToBlockheads.get(playerName)
  if (ids && ids.size > 0) return Array.from(ids)
  const fallback = getBlockheadsFromActivityMonitor(ctx.bot, playerName)
  return fallback ?? []
}

export const isActiveBlockheadForPlayer = (ctx: QuestContext, playerName: string, blockheadId: number): boolean => {
  if (!ctx.onlinePlayers.has(playerName)) return false
  const coords = ctx.lastCoords.get(blockheadId)
  if (!coords) return false
  if (Date.now() - coords.time > 120000) return false
  const known = ctx.playerToBlockheads.get(playerName)
  return !known || known.has(blockheadId)
}

export const getBlockheadForPlayer = (ctx: QuestContext, playerName: string): number | null => {
  const last = ctx.playerToLastBlockhead.get(playerName)
  if (typeof last === 'number' && isActiveBlockheadForPlayer(ctx, playerName, last)) {
    if (LOG_BOT_DEBUG) console.log(`[Quest Debug] getBlockheadForPlayer(${playerName}): using lastActive=${last}`)
    return last
  }

  const ids = ctx.playerToBlockheads.get(playerName)
  const resolvedIds = (!ids || ids.size === 0) ? getBlockheadsFromActivityMonitor(ctx.bot, playerName) : Array.from(ids)
  if (resolvedIds && resolvedIds.length > 0) {
    let bestId: number | null = null
    let bestTime = -1
    for (const id of resolvedIds) {
      const coords = ctx.lastCoords.get(id)
      if (coords && coords.time > bestTime && isActiveBlockheadForPlayer(ctx, playerName, id)) {
        bestTime = coords.time
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
  const playerUuid = ctx.playerToUuid.get(playerName)
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
  let bestId: number | null = null
  let bestTime = -1
  for (const id of ids) {
    const coords = ctx.lastCoords.get(id)
    if (coords && coords.time > bestTime) {
      bestTime = coords.time
      bestId = id
    }
  }
  const result = bestId ?? ids[0]
  if (LOG_BOT_DEBUG) console.log(`[Quest Debug] resolveBlockheadId(${playerName}): LMDB ids=[${ids.join(',')}] bestByCoords=${bestId} result=${result}`)
  return result
}

export const findBlockheadsWithItems = async (ctx: QuestContext, playerName: string, itemIds: number[]): Promise<number[]> => {
  const playerUuid = ctx.playerToUuid.get(playerName)
  if (!playerUuid) return []

  const knownIds = getKnownBlockheadsForPlayer(ctx, playerName)
  const activeId = ctx.playerToLastBlockhead.get(playerName)
  const allIds = new Set<number>(knownIds)
  if (typeof activeId === 'number') allIds.add(activeId)

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
