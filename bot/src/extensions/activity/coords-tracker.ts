import { sendPrivateMessage } from '../../private-message'
import { ActivityContext, LOG_BOT_DEBUG, LOG_BLOCKHEAD_MAP } from './activity-context'
import { sharedMappingState } from '../helpers/blockhead-mapping'

// ============================================================================
// Coordinate tracking
// ============================================================================

export const setCoords = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.set(key, value)
}

export const getLatestCoordsForPlayer = (ctx: ActivityContext, playerName: string) => {
  const ids = ctx.playerToBlockheads.get(playerName)
  if (!ids || ids.size === 0) return null

  // Multi-BH player with an explicit selection — use that blockhead's coords
  if (ids.size > 1) {
    const trackedId = sharedMappingState.playerTrackedBlockhead.get(playerName)
    if (trackedId && ids.has(trackedId)) {
      return ctx.lastCoords.get(trackedId) ?? null
    }
  }

  // Fall back to last active
  let best: { x: number; y: number; time: string } | null = null
  let bestTime = -1
  for (const id of ids) {
    const coords = ctx.lastCoords.get(id)
    if (!coords) continue
    const t = Date.parse(coords.time)
    if (Number.isNaN(t)) continue
    if (t > bestTime) {
      bestTime = t
      best = coords
    }
  }
  return best
}

export const cleanupCoordsMaps = (ctx: ActivityContext) => {
  const MAX_COORDS = 100000

  if (ctx.lastCoords.size > MAX_COORDS) {
    console.log(`[Activity Monitor] lastCoords exceeded ${MAX_COORDS} (${ctx.lastCoords.size}), clearing — online players will repopulate from events`)
    ctx.lastCoords.clear()
  }

  if (ctx.lastPlayerCoords.size > MAX_COORDS) {
    console.log(`[Activity Monitor] lastPlayerCoords exceeded ${MAX_COORDS} (${ctx.lastPlayerCoords.size}), clearing — online players will repopulate from events`)
    ctx.lastPlayerCoords.clear()
  }
}

// ============================================================================
// /coords command
// ============================================================================

export const registerCoordsCommand = (ctx: ActivityContext, world: any) => {
  world.onMessage.sub(({ player, message }: { player: any; message: string }) => {
    if (message !== '/coords') return

    const playerName = player.name

    const coords = getLatestCoordsForPlayer(ctx, playerName)
      ?? ctx.lastPlayerCoords.get(playerName)
      ?? ctx.lastPlayerCoords.get(playerName.toUpperCase())
      ?? ctx.lastPlayerCoords.get((player as any).characterName)
      ?? ctx.lastPlayerCoords.get((player as any).blockheadName)

    if (!coords) {
      if (LOG_BLOCKHEAD_MAP) {
        const trackedBlockheads = ctx.playerToBlockheads.get(playerName)
        const trackedUuid = ctx.playerToUuid.get(playerName)
        if (LOG_BOT_DEBUG) console.log(`[/coords] No coords for ${playerName}, tracked blockheads: ${trackedBlockheads ? Array.from(trackedBlockheads).join(',') : 'none'}, uuid: ${trackedUuid ?? 'none'}`)
      }
      sendPrivateMessage(player.name, `${player.name} coords are not available yet. Try moving around.`)
      return
    }
    sendPrivateMessage(player.name, `${player.name} coords: x: ${coords.x}, y: ${coords.y}`)
  })
}
