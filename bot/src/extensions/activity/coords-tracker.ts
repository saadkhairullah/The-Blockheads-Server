import { sendPrivateMessage } from '../../private-message'
import { ActivityContext, LOG_BOT_DEBUG, LOG_BLOCKHEAD_MAP } from './activity-context'
import { playerManager } from '../helpers/blockhead-mapping'

// ============================================================================
// Coordinate tracking
// ============================================================================

export const getLatestCoordsForPlayer = (_ctx: ActivityContext, playerName: string) => {
  const player = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
  return player?.mostRecentCoords ?? null
}

// No-op: coords live on Blockhead objects, no separate map to clean up
export const cleanupCoordsMaps = (_ctx: ActivityContext) => {}

// ============================================================================
// /coords command
// ============================================================================

export const registerCoordsCommand = (ctx: ActivityContext, world: any) => {
  world.onMessage.sub(({ player, message }: { player: any; message: string }) => {
    if (message !== '/coords') return

    const playerName = player.name

    const coords = getLatestCoordsForPlayer(ctx, playerName)

    if (!coords) {
      if (LOG_BLOCKHEAD_MAP) {
        const pm = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
        if (LOG_BOT_DEBUG) console.log(`[/coords] No coords for ${playerName}, tracked blockheads: ${pm ? Array.from(pm.blockheads.keys()).join(',') : 'none'}, uuid: ${pm?.uuid ?? 'none'}`)
      }
      sendPrivateMessage(player.name, `${player.name} coords are not available yet. Try moving around.`)
      return
    }
    sendPrivateMessage(player.name, `${player.name} coords: x: ${coords.x}, y: ${coords.y}`)
  })
}
