import { eventDispatcher } from '../../event-dispatcher'
import * as BlockheadService from '../../blockhead-service'
import { playerManager } from '../helpers/blockhead-mapping'
import { getBankAPI as _getBankAPI } from '../helpers/extension-api'
import { ActivityEvent } from '../types/shared-types'
import {
  ActivityContext, LOG_BOT_DEBUG, LOG_ACTIVITY_EVENTS,
  FAILED_LOOKUP_COOLDOWN,
  markPlayerActive,
} from './activity-context'
import {
  handleForbiddenDetected, handleForbiddenCleared,
  drainPendingForbiddenForBlockhead,
} from './forbidden-items'

// ============================================================================
// Event processing
// ============================================================================

export const processEvent = (ctx: ActivityContext, bot: any, event: ActivityEvent) => {
  if (LOG_ACTIVITY_EVENTS) {
    if (LOG_BOT_DEBUG) console.log(`[Activity] ${event.type}: ${event.player} (account=${event.playerAccount}, blockhead=${event.blockheadName}, uuid=${event.playerUUID})`)
  }

  // Register player/blockhead in playerManager (creates player if new, indexes blockhead)
  playerManager.updateFromEvent(event)

  // Drain pending forbidden items now that we have the blockhead mapped
  if (typeof event.blockheadId === 'number') {
    drainPendingForbiddenForBlockhead(ctx, event.blockheadId)
    // If blockhead still not mapped to a player, kick off a background owner lookup
    if (!event.playerUUID && !playerManager.getByBlockheadId(event.blockheadId)) {
      resolveUnknownBlockhead(ctx, event.blockheadId)
    }
  }

  const resolvedOwner = playerManager.resolveEventPlayer(event)

  const bankAPI = _getBankAPI(bot)

  switch (event.type) {
    case 'PLAYER_MOVE':
      if (typeof event.blockheadId === 'number' && typeof event.x === 'number' && typeof event.y === 'number') {
        updateBlockheadCoords(event.blockheadId, event.x, event.y)
        if (event.blockheadName) {
          const bh = playerManager.getByBlockheadId(event.blockheadId)?.blockheads.get(event.blockheadId)
          if (bh) bh.name = event.blockheadName
        }
      }
      markPlayerActive(resolvedOwner)
      break

    case 'PLAYER_ACTION':
      if (typeof event.blockheadId === 'number' && typeof event.x === 'number' && typeof event.y === 'number') {
        updateBlockheadCoords(event.blockheadId, event.x, event.y)
        if (event.blockheadName) {
          const bh = playerManager.getByBlockheadId(event.blockheadId)?.blockheads.get(event.blockheadId)
          if (bh) bh.name = event.blockheadName
        }
      }
      markPlayerActive(resolvedOwner)
      checkInventoryChangeForForbidden(ctx, event)
      break

    case 'ITEM_PICKUP':
    case 'ITEM_DROP':
      if (typeof event.itemId === 'number' && ctx.forbiddenItemIds.has(event.itemId)) {
        const blockheadId = event.blockheadId
        const key = typeof blockheadId === 'number' ? `${blockheadId}:${event.itemId}` : null
        if (key) {
          const prev = ctx.forbiddenCounts.get(key) ?? 0
          if (prev <= 0) {
            ctx.forbiddenCounts.set(key, Math.max(1, event.count ?? 1))
            handleForbiddenDetected(ctx, event, event.itemId, event.item ?? `item ${event.itemId}`, event.count ?? 1, blockheadId)
          }
        } else {
          handleForbiddenDetected(ctx, event, event.itemId, event.item ?? `item ${event.itemId}`, event.count ?? 1, event.blockheadId)
        }
      }
      markPlayerActive(resolvedOwner)
      break

    case 'INVENTORY_SNAPSHOT':
      if (typeof event.blockheadId === 'number') {
        const snapshotCounts = new Map<number, number>()
        if (event.items && Array.isArray(event.items)) {
          for (const item of event.items) {
            if (typeof item.itemId === 'number') {
              snapshotCounts.set(item.itemId, item.count ?? 0)
            }
          }
        }
        for (const itemId of ctx.forbiddenItemIds) {
          const count = snapshotCounts.get(itemId) ?? 0
          const stateKey = `${event.blockheadId}:${itemId}`
          const prev = ctx.forbiddenCounts.get(stateKey) ?? 0
          if (count <= 0) {
            if (prev > 0) {
              ctx.forbiddenCounts.delete(stateKey)
              handleForbiddenCleared(ctx, event, itemId, event.blockheadId)
            }
          } else {
            ctx.forbiddenCounts.set(stateKey, count)
            if (prev <= 0) {
              const name = itemId === 1074 ? 'PORTAL_CHEST' : 'FREIGHT_CAR'
              handleForbiddenDetected(ctx, event, itemId, name, count, event.blockheadId)
            }
          }
        }
      }
      markPlayerActive(resolvedOwner)
      break

    case 'block_placed':
      if (bankAPI) {
        bankAPI.addCoins(event.player, 1, 'Building reward')
      }
      break

    case 'block_mined':
      if (bankAPI) {
        bankAPI.addCoins(event.player, 2, 'Mining reward')
      }
      break
  }
}

// ============================================================================
// Helpers
// ============================================================================

const updateBlockheadCoords = (blockheadId: number, x: number, y: number) => {
  const player = playerManager.getByBlockheadId(blockheadId)
  if (!player) return
  const bh = player.blockheads.get(blockheadId)
  if (bh) {
    bh.lastCoords = { x, y, time: Date.now() }
    player.lastBlockheadId = blockheadId
  }
}

const checkInventoryChangeForForbidden = (ctx: ActivityContext, event: ActivityEvent) => {
  if (!event.inventoryChange) return
  const itemMatches = event.inventoryChange.matchAll(/([A-Z_]+)([+-])(\d+)/g)
  for (const match of itemMatches) {
    const itemName = match[1]
    const op = match[2]
    const delta = Number(match[3])
    if (op !== '+') continue

    let itemId: number | null = null
    if (itemName === 'PORTAL_CHEST') itemId = 1074
    else if (itemName === 'FREIGHT_CAR') itemId = 206
    if (itemId === null) continue

    const blockheadId = event.blockheadId
    if (typeof blockheadId === 'number') {
      const key = `${blockheadId}:${itemId}`
      const prev = ctx.forbiddenCounts.get(key) ?? 0
      if (prev <= 0) {
        ctx.forbiddenCounts.set(key, Math.max(1, delta))
        handleForbiddenDetected(ctx, event, itemId, itemName, Math.max(1, delta), blockheadId)
      }
    } else {
      handleForbiddenDetected(ctx, event, itemId, itemName, Math.max(1, delta), event.blockheadId)
    }
  }
}

const resolveUnknownBlockhead = (ctx: ActivityContext, bhId: number) => {
  const lastFailed = ctx.failedOwnerLookups.get(bhId)
  if (ctx.pendingOwnerLookups.has(bhId) || (lastFailed && (Date.now() - lastFailed) < FAILED_LOOKUP_COOLDOWN)) return

  ctx.pendingOwnerLookups.add(bhId)

  ;(async () => {
    // Fast LMDB check: collect UUIDs for all online players
    const candidateUuids: string[] = []
    for (const p of playerManager.online()) {
      if (p.uuid) candidateUuids.push(p.uuid)
    }

    if (candidateUuids.length) {
      const ownerUuid = await BlockheadService.findOwnerForBlockheadFast(bhId, candidateUuids)
      if (ownerUuid) {
        const owner = playerManager.getByUuid(ownerUuid)
        if (owner) playerManager.attachBlockheads(owner, [bhId])
        return
      }
    }

    // Full refresh: try each online player
    for (const p of playerManager.online()) {
      await ctx.listBlockheadsForPlayer(p.name, p.uuid)
      if (playerManager.getByBlockheadId(bhId)) return
    }

    ctx.failedOwnerLookups.set(bhId, Date.now())
  })().catch(() => {
    ctx.failedOwnerLookups.set(bhId, Date.now())
  }).finally(() => {
    ctx.pendingOwnerLookups.delete(bhId)
  })
}

// ============================================================================
// Start watching
// ============================================================================

export const startWatching = (ctx: ActivityContext, bot: any) => {
  eventDispatcher.subscribeAll((event) => processEvent(ctx, bot, event))
  if (LOG_BOT_DEBUG) console.log('[Activity Monitor] Subscribed to UDS events')
}
