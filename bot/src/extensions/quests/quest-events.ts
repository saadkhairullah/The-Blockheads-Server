import { QuestContext, LOG_BOT_DEBUG, FAILED_LOOKUP_COOLDOWN } from './quest-context'
import { ActivityEvent } from '../types/shared-types'
import { getUDSClient } from '../../uds-client'
import { resolveEventPlayer, sharedMappingState, listAndMapBlockheads, attachBlockheadsToUuid } from '../helpers/blockhead-mapping'
import { trackBlockheadOwner } from './quest-resolver'
import { checkTravelProgress } from './quest-completion'
import { refreshInventoryOnMove } from './quest-inventory'

// Track in-flight owner lookups to avoid duplicate queries
const pendingOwnerLookups = new Set<number>()
// Cache failed lookups to avoid repeated attempts
const failedOwnerLookups = new Map<number, number>()

const tryResolveUnknownBlockhead = async (ctx: QuestContext, blockheadId: number, event: ActivityEvent) => {
  if (pendingOwnerLookups.has(blockheadId)) return
  if (ctx.blockheadToPlayer.has(blockheadId)) return
  if (ctx.blockheadToOwnerUuid.has(blockheadId)) return

  const lastFailed = failedOwnerLookups.get(blockheadId)
  if (lastFailed && (Date.now() - lastFailed) < FAILED_LOOKUP_COOLDOWN) return

  pendingOwnerLookups.add(blockheadId)
  if (LOG_BOT_DEBUG) console.log(`[Quest System] Unknown blockhead ${blockheadId}, querying owner...`)

  try {
    // Try to find owner by checking all online players
    let ownerUuid: string | null = null
    for (const [name, ids] of ctx.playerToBlockheads.entries()) {
      if (ids.has(blockheadId)) {
        const uuid = ctx.playerToUuid.get(name)
        if (uuid) {
          ownerUuid = uuid
          break
        }
      }
    }

    if (!ownerUuid) {
      // Check blockheadToOwnerUuid
      ownerUuid = ctx.blockheadToOwnerUuid.get(blockheadId) ?? null
    }

    if (!ownerUuid) {
      // Try refreshing online players
      for (const name of ctx.onlinePlayers) {
        const uuid = ctx.playerToUuid.get(name)
        if (!uuid) continue
        await listAndMapBlockheads(name, uuid)
        const refreshed = ctx.blockheadToOwnerUuid.get(blockheadId)
        if (refreshed) {
          ownerUuid = refreshed
          break
        }
      }
    }

    if (ownerUuid) {
      ctx.blockheadToOwnerUuid.set(blockheadId, ownerUuid)
      attachBlockheadsToUuid(ownerUuid, [blockheadId], sharedMappingState)
      const playerName = ctx.uuidToPlayer.get(ownerUuid) ?? null

      if (playerName) {
        ctx.blockheadToPlayer.set(blockheadId, playerName)
        const set = ctx.playerToBlockheads.get(playerName) ?? new Set<number>()
        set.add(blockheadId)
        ctx.playerToBlockheads.set(playerName, set)
        if (LOG_BOT_DEBUG) console.log(`[Quest System] Mapped blockhead ${blockheadId} to ${playerName}`)

        if (typeof event.x === 'number' && typeof event.y === 'number') {
          if (ctx.onlinePlayers.has(playerName)) {
            ctx.playerToLastBlockhead.set(playerName, blockheadId)
            checkTravelProgress(ctx, playerName, event.x, event.y)
          }
        }
      } else {
        console.warn(`[Quest System] Owner UUID ${ownerUuid} unknown for blockhead ${blockheadId}`)
      }
    } else {
      failedOwnerLookups.set(blockheadId, Date.now())
    }
  } finally {
    pendingOwnerLookups.delete(blockheadId)
  }
}

export const processEvent = (ctx: QuestContext, event: ActivityEvent) => {
  trackBlockheadOwner(ctx, event)
  const eventPlayer = resolveEventPlayer(event, sharedMappingState)

  switch (event.type) {
    case 'PLAYER_MOVE':
    case 'PLAYER_ACTION':
    case 'ITEM_PICKUP':
    case 'ITEM_DROP':
    case 'INVENTORY_SNAPSHOT':
      if (typeof event.blockheadId === 'number') {
        if (typeof event.x === 'number' && typeof event.y === 'number') {
          ctx.lastCoords.set(event.blockheadId, { x: event.x, y: event.y, time: Date.now() })

          if (eventPlayer && ctx.onlinePlayers.has(eventPlayer)) {
            const accountName = event.playerAccount ?? eventPlayer
            // Determine if this blockhead is the tracked one (or the only one)
            const playerBHs = ctx.playerToBlockheads.get(eventPlayer)
            const trackedId = sharedMappingState.playerTrackedBlockhead.get(eventPlayer)
            const isTrackedBH = !playerBHs || playerBHs.size <= 1 || !trackedId || trackedId === event.blockheadId

            if (isTrackedBH) {
              if (accountName && accountName !== '?') {
                ctx.playerToLastBlockhead.set(accountName, event.blockheadId)
              }
              if (ctx.pendingInventoryRefresh.has(eventPlayer)) {
                refreshInventoryOnMove(ctx, eventPlayer, event.blockheadId).catch(err => {
                  console.warn(`[Quest System] Inventory refresh on move failed for ${eventPlayer}:`, err)
                })
              }
              checkTravelProgress(ctx, eventPlayer, event.x, event.y)
            }
          } else if (!eventPlayer && !ctx.blockheadToPlayer.has(event.blockheadId)) {
            tryResolveUnknownBlockhead(ctx, event.blockheadId, event)
          }
        }
        if (eventPlayer && ctx.onlinePlayers.has(eventPlayer)) {
          ctx.playerLastActivity.set(eventPlayer, Date.now())
        }
      }
      break
  }
}

export const startWatching = (ctx: QuestContext) => {
  const uds = getUDSClient()
  uds.on('event', (event: any) => {
    processEvent(ctx, event as ActivityEvent)
  })
  if (LOG_BOT_DEBUG) console.log('[Quest System] Subscribed to UDS events')
}

// Export for cleanup
export const cleanupEventState = () => {
  const now = Date.now()
  for (const [blockheadId, failTime] of failedOwnerLookups.entries()) {
    if (now - failTime > FAILED_LOOKUP_COOLDOWN) {
      failedOwnerLookups.delete(blockheadId)
    }
  }
}
