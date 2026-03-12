import { readFile, appendFile, writeFile } from 'fs/promises'
import { enqueueShared } from '../../shared-queue'
import * as BlockheadService from '../../blockhead-service'
import { normalizePlayerName, resolveOwnerFromMappings, resolveEventPlayer } from '../helpers/blockhead-mapping'
import { isAdmin as isAdminHelper } from '../helpers/isAdmin'
import { ActivityEvent } from '../types/shared-types'
import {
  ActivityContext, LOG_BOT_DEBUG, MAX_PENDING_UUIDS,
  FORBIDDEN_ITEM_IDS, SUSPICIOUS_LOG_PATH, PORTAL_CHEST_BUYERS_PATH,
  pruneMap, sleep,
} from './activity-context'

// ============================================================================
// Portal chest buyer management
// ============================================================================

export const loadPortalChestBuyers = async (ctx: ActivityContext) => {
  try {
    const content = await readFile(PORTAL_CHEST_BUYERS_PATH, 'utf8')
    const data = JSON.parse(content)
    ctx.portalChestBuyers = new Set((data.buyers || []).map((n: string) => n.toLowerCase()))
    console.log(`[Activity Monitor] Loaded ${ctx.portalChestBuyers.size} portal chest buyers`)
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error('[Activity Monitor] Failed to load portal chest buyers:', err)
    }
  }
}

export const savePortalChestBuyers = async (ctx: ActivityContext) => {
  try {
    const data = { buyers: Array.from(ctx.portalChestBuyers), updatedAt: new Date().toISOString() }
    await writeFile(PORTAL_CHEST_BUYERS_PATH, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('[Activity Monitor] Failed to save portal chest buyers:', err)
  }
}

export const addPortalChestBuyer = (ctx: ActivityContext, playerName: string) => {
  if (!playerName) return
  const normalized = playerName.toLowerCase()
  ctx.portalChestBuyers.add(normalized)
  savePortalChestBuyers(ctx)
  if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Added ${playerName} to portal chest buyers`)
}

export const removePortalChestBuyer = (ctx: ActivityContext, playerName: string) => {
  if (!playerName) return
  const normalized = playerName.toLowerCase()
  ctx.portalChestBuyers.delete(normalized)
  savePortalChestBuyers(ctx)
  if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Removed ${playerName} from portal chest buyers`)
}

export const isAllowedForbiddenItems = (ctx: ActivityContext, playerName: string | null): boolean => {
  if (!playerName) return false
  const normalized = playerName.toLowerCase()
  return isAdminHelper(normalized) || ctx.portalChestBuyers.has(normalized)
}

// ============================================================================
// Enforcement helpers
// ============================================================================

const logSuspiciousRemoval = async (payload: Record<string, unknown>) => {
  try {
    await appendFile(SUSPICIOUS_LOG_PATH, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch (err) {
    console.error('[Activity Monitor] Failed to write suspicious log:', err)
  }
}

const banForForbidden = (ctx: ActivityContext, playerName: string, itemId: number): boolean => {
  const key = `${playerName}:${itemId}`
  if (ctx.bannedForForbidden.has(key)) {
    console.log(`[Activity Monitor] Skipping ban for ${playerName} - already banned for item ${itemId}`)
    return false
  }
  ctx.bannedForForbidden.add(key)
  const name = normalizePlayerName(playerName)
  console.log(`[Activity Monitor] Sending ban command: /ban ${name}`)
  ctx.bot.send(`/ban ${name}`)
  return true
}

const unbanForForbidden = (ctx: ActivityContext, playerName: string, itemId: number) => {
  const key = `${playerName}:${itemId}`
  if (!ctx.bannedForForbidden.has(key)) return
  ctx.bannedForForbidden.delete(key)
  const name = normalizePlayerName(playerName)
  console.log(`[Activity Monitor] Sending unban command: /unban ${name}`)
  ctx.bot.send(`/unban ${name}`)
}

const getBlockheadItemCount = async (playerUuid: string, blockheadId: number, itemId: number): Promise<number | null> => {
  const counts = await BlockheadService.getInventoryCounts(blockheadId, playerUuid)
  if (!counts) return null
  return counts[itemId] ?? 0
}

const resolveBlockheadForRemoval = async (ctx: ActivityContext, playerName: string, eventBlockheadId: number | undefined, itemId: number): Promise<number | null> => {
  const ids = ctx.playerToBlockheads.get(playerName)
  if (!ids || ids.size === 0) return null

  if (typeof eventBlockheadId === 'number' && ids.has(eventBlockheadId)) {
    return eventBlockheadId
  }

  const playerUuid = ctx.playerToUuid.get(playerName)
  if (!playerUuid) return null

  for (const id of ids) {
    const count = await getBlockheadItemCount(playerUuid, id, itemId)
    if (typeof count === 'number' && count > 0) {
      return id
    }
  }

  return null
}

const scheduleRemoval = async (ctx: ActivityContext, playerName: string, itemId: number, itemName: string, count: number, eventBlockheadId?: number): Promise<boolean> => {
  const playerUuid = ctx.playerToUuid.get(playerName)
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Removal attempt ${attempt + 1}/${MAX_RETRIES} for ${playerName}`)

    if (attempt > 0) {
      await sleep(1000)
    }

    const targetBlockheadId = await resolveBlockheadForRemoval(ctx, playerName, eventBlockheadId, itemId)
    if (typeof targetBlockheadId === 'number') {
      if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Attempting to remove ${count}x ${itemName} from blockhead ${targetBlockheadId}`)
      const result = await enqueueShared(() => ctx.takeItemFromBlockhead(targetBlockheadId, itemId, count, playerUuid))
      if (result.success && (result.taken ?? 0) > 0) {
        if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Removed ${result.taken}x ${itemName} from blockhead ${targetBlockheadId}`)
        ctx.bot.send(`Removed ${result.taken}x ${itemName} from inventory.`)
        const stateKey = `${targetBlockheadId}:${itemId}`
        ctx.forbiddenCounts.delete(stateKey)
        return true
      }
      if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Could not remove item: ${result.error ?? 'unknown error'}`)

      const ids = ctx.playerToBlockheads.get(playerName)
      if (ids && ids.size > 0) {
        for (const id of ids) {
          if (id === targetBlockheadId) continue
          if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Attempting to remove ${count}x ${itemName} from blockhead ${id}`)
          const fallback = await enqueueShared(() => ctx.takeItemFromBlockhead(id, itemId, count, playerUuid))
          if (fallback.success && (fallback.taken ?? 0) > 0) {
            if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Removed ${fallback.taken}x ${itemName} from blockhead ${id}`)
            ctx.bot.send(`Removed ${fallback.taken}x ${itemName} from inventory.`)
            const stateKey = `${id}:${itemId}`
            ctx.forbiddenCounts.delete(stateKey)
            return true
          }
        }
      }
    } else {
      if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] No valid blockhead found for ${playerName} to remove ${itemName}`)
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(2000)
    }
  }
  console.log(`[Activity Monitor] All ${MAX_RETRIES} removal attempts failed for ${playerName}`)
  return false
}

// ============================================================================
// Core enforcement
// ============================================================================

export const enforceForbiddenForPlayer = async (
  ctx: ActivityContext,
  playerName: string,
  itemId: number,
  itemName: string,
  count: number,
  blockheadId?: number,
  verifyFirst?: boolean
) => {
  const pendingKey = `${playerName}:${itemId}`
  if (ctx.pendingRemovals.has(pendingKey)) {
    if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Skipping enforcement for ${playerName}/${itemName} - already in progress`)
    return
  }

  if (verifyFirst) {
    const resolved = await resolveBlockheadForRemoval(ctx, playerName, blockheadId, itemId)
    if (resolved === null) {
      logSuspiciousRemoval({
        time: new Date().toISOString(),
        player: playerName,
        itemId, itemName, blockheadId,
        reason: 'missing_on_verify'
      })
      return
    }
  }

  if (isAllowedForbiddenItems(ctx, playerName)) return

  ctx.pendingRemovals.set(pendingKey, Date.now())
  try {
    console.log(`[Activity Monitor] Banning ${playerName} for forbidden item ${itemName}`)
    const banned = banForForbidden(ctx, playerName, itemId)
    if (!banned) {
      console.log(`[Activity Monitor] Player ${playerName} already banned, skipping redundant enforcement`)
      return
    }

    const removed = await scheduleRemoval(ctx, playerName, itemId, itemName, Math.max(1, count), blockheadId)

    if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Waiting 5 seconds before unbanning ${playerName}...`)
    await sleep(5000)

    if (removed) {
      if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Successfully removed ${itemName} from ${playerName}, unbanning`)
      unbanForForbidden(ctx, playerName, itemId)
      if (typeof blockheadId === 'number') {
        ctx.forbiddenCounts.delete(`${blockheadId}:${itemId}`)
      }
    } else {
      console.warn(`[Activity Monitor] Failed to remove ${itemName} from ${playerName} after all retries - unbanning anyway`)
      await logSuspiciousRemoval({
        time: new Date().toISOString(),
        player: playerName,
        itemId, itemName, blockheadId,
        playerUuid: ctx.playerToUuid.get(playerName),
        reason: 'removal_failed_unbanned'
      })
      unbanForForbidden(ctx, playerName, itemId)
      if (typeof blockheadId === 'number') {
        ctx.forbiddenCounts.delete(`${blockheadId}:${itemId}`)
      }
    }
  } finally {
    ctx.pendingRemovals.delete(pendingKey)
  }
}

// ============================================================================
// Pending forbidden queues
// ============================================================================

export const queuePendingForbidden = (ctx: ActivityContext, playerUuid: string, entry: { itemId: number; itemName: string; count: number; blockheadId?: number }) => {
  const existing = ctx.pendingForbiddenByUuid.get(playerUuid) ?? []
  existing.push(entry)
  ctx.pendingForbiddenByUuid.set(playerUuid, existing)
  pruneMap(ctx.pendingForbiddenByUuid, MAX_PENDING_UUIDS)
}

export const queuePendingForbiddenByBlockhead = (ctx: ActivityContext, blockheadId: number, entry: { itemId: number; itemName: string; count: number }) => {
  const existing = ctx.pendingForbiddenByBlockhead.get(blockheadId) ?? []
  existing.push(entry)
  ctx.pendingForbiddenByBlockhead.set(blockheadId, existing)
  pruneMap(ctx.pendingForbiddenByBlockhead, MAX_PENDING_UUIDS)
}

export const drainPendingForbiddenForBlockhead = (ctx: ActivityContext, blockheadId: number) => {
  const owner = resolveOwnerFromMappings(blockheadId, {
    playerToBlockheads: ctx.playerToBlockheads,
    playerToUuid: ctx.playerToUuid,
    uuidToPlayer: ctx.uuidToPlayer,
  })
  if (!owner) return
  const pending = ctx.pendingForbiddenByBlockhead.get(blockheadId)
  if (!pending || pending.length === 0) return
  ctx.pendingForbiddenByBlockhead.delete(blockheadId)
  for (const entry of pending) {
    enforceForbiddenForPlayer(ctx, owner, entry.itemId, entry.itemName, entry.count, blockheadId, true)
  }
}

// ============================================================================
// Event handlers for forbidden item detection
// ============================================================================

export const handleForbiddenDetected = async (
  ctx: ActivityContext,
  event: ActivityEvent,
  itemId: number,
  itemName: string,
  count: number,
  blockheadId?: number
) => {
  if (!FORBIDDEN_ITEM_IDS.has(itemId)) return
  const state = {
    playerToBlockheads: ctx.playerToBlockheads,
    playerToUuid: ctx.playerToUuid,
    uuidToPlayer: ctx.uuidToPlayer,
    blockheadToPlayer: ctx.blockheadToPlayer,
    blockheadToUuid: ctx.blockheadToUuid,
    blockheadToOwnerUuid: ctx.blockheadToOwnerUuid,
  }
  const playerName = resolveEventPlayer(event, state) ?? resolveOwnerFromMappings(blockheadId, state)
  const ownerName = playerName ? normalizePlayerName(playerName) : null
  if (ownerName && isAllowedForbiddenItems(ctx, ownerName)) {
    if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] ${ownerName} has forbidden item ${itemName} - allowed (admin or purchased)`)
    return
  }

  if (ownerName) {
    await enforceForbiddenForPlayer(ctx, ownerName, itemId, itemName, count, blockheadId)
    return
  }

  if (event.playerUUID) {
    queuePendingForbidden(ctx, event.playerUUID, { itemId, itemName, count, blockheadId })
  } else if (typeof blockheadId === 'number') {
    queuePendingForbiddenByBlockhead(ctx, blockheadId, { itemId, itemName, count })
  }
}

export const handleForbiddenCleared = async (ctx: ActivityContext, event: ActivityEvent, itemId: number, blockheadId?: number) => {
  const state = {
    playerToBlockheads: ctx.playerToBlockheads,
    playerToUuid: ctx.playerToUuid,
    uuidToPlayer: ctx.uuidToPlayer,
    blockheadToPlayer: ctx.blockheadToPlayer,
    blockheadToUuid: ctx.blockheadToUuid,
    blockheadToOwnerUuid: ctx.blockheadToOwnerUuid,
  }
  const playerName = resolveEventPlayer(event, state) ?? resolveOwnerFromMappings(blockheadId, state)
  if (!playerName) return
  if (isAllowedForbiddenItems(ctx, playerName)) return

  const key = `${playerName}:${itemId}`
  if (ctx.pendingRemovals.has(key)) return

  if (ctx.bannedForForbidden.has(key)) {
    console.log(`[Activity Monitor] Forbidden item ${itemId} cleared for ${playerName} (snapshot confirms removal) - unbanning`)
    unbanForForbidden(ctx, playerName, itemId)
  }
}

// ============================================================================
// Cleanup
// ============================================================================

export const cleanupPendingRemovals = (ctx: ActivityContext) => {
  const now = Date.now()
  for (const [key, timestamp] of ctx.pendingRemovals.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      ctx.pendingRemovals.delete(key)
    }
  }
}
