import { getUDSClient } from '../../uds-client'
import * as BlockheadService from '../../blockhead-service'
import {
  resolveEventPlayer, resolveOwnerFromMappings, resolveOwnerWithRefresh,
  updateMappingsFromEvent, sharedMappingState,
} from '../helpers/blockhead-mapping'
import { getBankAPI as _getBankAPI } from '../helpers/extension-api'
import { ActivityEvent } from '../types/shared-types'
import {
  ActivityContext, LOG_BOT_DEBUG, LOG_ACTIVITY_EVENTS, LOG_BLOCKHEAD_MAP,
  MAX_PLAYER_CACHE, FORBIDDEN_ITEM_IDS, FAILED_LOOKUP_COOLDOWN,
  setWithLimit, markPlayerActive,
} from './activity-context'
import { setCoords } from './coords-tracker'
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
  const eventTime = event.time ?? event.timestamp ?? new Date().toISOString()

  // Shared mapping writes (playerToBlockheads, blockheadToPlayer, etc.)
  updateMappingsFromEvent(event, sharedMappingState)

  // Activity-specific: register with setWithLimit bounds + drain pending forbidden
  if (event.playerAccount && event.playerUUID && event.playerAccount !== '?') {
    setWithLimit(ctx.playerToUuid, event.playerAccount, event.playerUUID, MAX_PLAYER_CACHE)
    setWithLimit(ctx.uuidToPlayer, event.playerUUID, event.playerAccount, MAX_PLAYER_CACHE)
  }

  if (typeof event.blockheadId === 'number' && event.playerAccount && event.playerAccount !== '?') {
    const existing = ctx.playerToBlockheads.get(event.playerAccount)
    if (!existing || !existing.has(event.blockheadId)) {
      if (LOG_BLOCKHEAD_MAP) {
        if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] Registered blockhead ${event.blockheadId} -> ${event.playerAccount}`)
      }
    }
    drainPendingForbiddenForBlockhead(ctx, event.blockheadId)
  }

  if (typeof event.blockheadId === 'number' && event.playerUUID) {
    setWithLimit(ctx.blockheadToUuid, event.blockheadId, event.playerUUID, MAX_PLAYER_CACHE)
    drainPendingForbiddenForBlockhead(ctx, event.blockheadId)
  } else if (typeof event.blockheadId === 'number' && !ctx.blockheadToUuid.has(event.blockheadId)) {
    // Last-resort owner lookup for events without playerUUID
    resolveUnknownBlockhead(ctx, event.blockheadId)
  }

  const state = {
    playerToBlockheads: ctx.playerToBlockheads,
    playerToUuid: ctx.playerToUuid,
    uuidToPlayer: ctx.uuidToPlayer,
    blockheadToPlayer: ctx.blockheadToPlayer,
    blockheadToUuid: ctx.blockheadToUuid,
    blockheadToOwnerUuid: ctx.blockheadToOwnerUuid,
  }
  const ownerAlias = resolveOwnerFromMappings(event.blockheadId, state)
  const resolvedOwner = resolveEventPlayer(event, state) ?? ownerAlias

  const bankAPI = _getBankAPI(bot)

  switch (event.type) {
    case 'PLAYER_MOVE':
      if (typeof event.blockheadId === 'number' && typeof event.x === 'number' && typeof event.y === 'number') {
        setCoords(ctx.lastCoords, event.blockheadId, { x: event.x, y: event.y, time: eventTime })
        const moveOwner = resolveMoveOwner(ctx, event, ownerAlias)
        if (moveOwner) {
          setCoords(ctx.lastPlayerCoords, moveOwner, { x: event.x, y: event.y, time: eventTime })
          if (event.blockheadName) {
            ctx.blockheadNameToOwner.set(event.blockheadName, moveOwner)
          }
        }
      }
      markPlayerActive(ctx, resolvedOwner)
      break

    case 'PLAYER_ACTION':
      if (typeof event.blockheadId === 'number' && typeof event.x === 'number' && typeof event.y === 'number') {
        setCoords(ctx.lastCoords, event.blockheadId, { x: event.x, y: event.y, time: eventTime })
        const actionOwner = resolveMoveOwner(ctx, event, ownerAlias)
        if (actionOwner) {
          setCoords(ctx.lastPlayerCoords, actionOwner, { x: event.x, y: event.y, time: eventTime })
          if (event.blockheadName) {
            ctx.blockheadNameToOwner.set(event.blockheadName, actionOwner)
          }
        }
      }
      markPlayerActive(ctx, resolvedOwner)
      checkInventoryChangeForForbidden(ctx, event)
      break

    case 'ITEM_PICKUP':
    case 'ITEM_DROP':
      if (typeof event.itemId === 'number' && FORBIDDEN_ITEM_IDS.has(event.itemId)) {
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
      markPlayerActive(ctx, resolvedOwner)
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
        for (const itemId of FORBIDDEN_ITEM_IDS) {
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
      markPlayerActive(ctx, resolvedOwner)
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

const resolveMoveOwner = (ctx: ActivityContext, event: ActivityEvent, ownerAlias: string | null | undefined): string | undefined => {
  let owner: string | undefined = event.playerAccount ?? ownerAlias ?? event.player
  if (!owner || owner === '?' || owner.startsWith('Blockhead#')) {
    if (typeof event.blockheadId === 'number') {
      const uuid = ctx.blockheadToUuid.get(event.blockheadId)
      if (uuid) {
        owner = ctx.uuidToPlayer.get(uuid)
      }
    }
  }
  if (owner && owner !== '?' && !owner.startsWith('Blockhead#')) {
    return owner
  }
  return undefined
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
    // Fast LMDB key existence check for online players
    const candidateUuids: string[] = []
    for (const name of ctx.onlinePlayers) {
      const uuid = ctx.getPlayerUuid(name) ?? ctx.playerToUuid.get(name)
      if (uuid) candidateUuids.push(uuid)
    }

    if (candidateUuids.length) {
      const ownerUuid = await BlockheadService.findOwnerForBlockheadFast(bhId, candidateUuids)
      if (ownerUuid) {
        setWithLimit(ctx.blockheadToUuid, bhId, ownerUuid, MAX_PLAYER_CACHE)
        ctx.blockheadToOwnerUuid.set(bhId, ownerUuid)
        const ownerName = ctx.uuidToPlayer.get(ownerUuid)
        if (ownerName) {
          ctx.blockheadToPlayer.set(bhId, ownerName)
          const set = ctx.playerToBlockheads.get(ownerName) ?? new Set<number>()
          set.add(bhId)
          ctx.playerToBlockheads.set(ownerName, set)
        }
        return
      }
    }

    const ownerName = await resolveOwnerWithRefresh(
      bhId,
      {
        playerToBlockheads: ctx.playerToBlockheads,
        playerToUuid: ctx.playerToUuid,
        uuidToPlayer: ctx.uuidToPlayer,
        blockheadToUuid: ctx.blockheadToUuid,
        blockheadToPlayer: ctx.blockheadToPlayer,
        blockheadToOwnerUuid: ctx.blockheadToOwnerUuid,
      },
      ctx.onlinePlayers,
      async (name, uuid) => { await ctx.listBlockheadsForPlayer(name, uuid) }
    )
    if (!ownerName) {
      ctx.failedOwnerLookups.set(bhId, Date.now())
    }
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
  const uds = getUDSClient()
  uds.on('event', (event: any) => {
    processEvent(ctx, bot, event as ActivityEvent)
  })
  if (LOG_BOT_DEBUG) console.log('[Activity Monitor] Subscribed to UDS events')
}
