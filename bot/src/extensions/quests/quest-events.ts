import { QuestContext, LOG_BOT_DEBUG, FAILED_LOOKUP_COOLDOWN } from './quest-context'
import { ActivityEvent } from '../types/shared-types'
import { eventDispatcher } from '../../event-dispatcher'
import { playerManager, listAndMapBlockheads } from '../helpers/blockhead-mapping'
import { trackBlockheadOwner } from './quest-resolver'
import { checkTravelProgress } from './quest-completion'
import { refreshInventoryOnMove } from './quest-inventory'

// Track in-flight owner lookups to avoid duplicate queries
const pendingOwnerLookups = new Set<number>()
// Cache failed lookups to avoid repeated attempts
const failedOwnerLookups = new Map<number, number>()

const tryResolveUnknownBlockhead = async (ctx: QuestContext, blockheadId: number, event: ActivityEvent) => {
  if (pendingOwnerLookups.has(blockheadId)) return
  if (playerManager.getByBlockheadId(blockheadId)) return

  const lastFailed = failedOwnerLookups.get(blockheadId)
  if (lastFailed && (Date.now() - lastFailed) < FAILED_LOOKUP_COOLDOWN) return

  pendingOwnerLookups.add(blockheadId)
  if (LOG_BOT_DEBUG) console.log(`[Quest System] Unknown blockhead ${blockheadId}, querying owner...`)

  try {
    let ownerPlayer = playerManager.getByBlockheadId(blockheadId)

    if (!ownerPlayer) {
      // Try refreshing all online players
      for (const p of playerManager.online()) {
        await listAndMapBlockheads(p.name, p.uuid)
        ownerPlayer = playerManager.getByBlockheadId(blockheadId)
        if (ownerPlayer) break
      }
    }

    if (ownerPlayer) {
      ownerPlayer.lastBlockheadId = blockheadId
      if (LOG_BOT_DEBUG) console.log(`[Quest System] Mapped blockhead ${blockheadId} to ${ownerPlayer.name}`)

      if (typeof event.x === 'number' && typeof event.y === 'number' && ownerPlayer.isOnline) {
        checkTravelProgress(ctx, ownerPlayer.name, event.x, event.y)
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
  const eventPlayer = playerManager.resolveEventPlayer(event)

  switch (event.type) {
    case 'PLAYER_MOVE':
    case 'PLAYER_ACTION':
    case 'ITEM_PICKUP':
    case 'ITEM_DROP':
    case 'INVENTORY_SNAPSHOT':
      if (typeof event.blockheadId === 'number') {
        if (typeof event.x === 'number' && typeof event.y === 'number') {
          // Write coords to Blockhead object
          const bhPlayer = playerManager.getByBlockheadId(event.blockheadId)
          const bh = bhPlayer?.blockheads.get(event.blockheadId)
          if (bh) bh.lastCoords = { x: event.x, y: event.y, time: Date.now() }
          if (bhPlayer) bhPlayer.lastBlockheadId = event.blockheadId

          if (eventPlayer && (playerManager.get(eventPlayer)?.isOnline ?? false)) {
            const accountName = event.playerAccount ?? eventPlayer
            const p = playerManager.get(eventPlayer)
            // Only process travel/inventory for the tracked blockhead (or single BH)
            const trackedId = p?.trackedBlockheadId
            const isTrackedBH = !p || p.blockheads.size <= 1 || !trackedId || trackedId === event.blockheadId

            if (isTrackedBH) {
              if (accountName && accountName !== '?') {
                const ap = playerManager.get(accountName)
                if (ap) ap.lastBlockheadId = event.blockheadId
              }
              if (ctx.pendingInventoryRefresh.has(eventPlayer)) {
                refreshInventoryOnMove(ctx, eventPlayer, event.blockheadId).catch(err => {
                  console.warn(`[Quest System] Inventory refresh on move failed for ${eventPlayer}:`, err)
                })
              }
              checkTravelProgress(ctx, eventPlayer, event.x, event.y)
            }
          } else if (!eventPlayer && !playerManager.getByBlockheadId(event.blockheadId)) {
            tryResolveUnknownBlockhead(ctx, event.blockheadId, event)
          }
        }
        if (eventPlayer) {
          const p = playerManager.get(eventPlayer)
          if (p?.isOnline) p.lastActivity = Date.now()
        }
      }
      break
  }
}

export const startWatching = (ctx: QuestContext) => {
  eventDispatcher.subscribeAll((event) => processEvent(ctx, event))
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
