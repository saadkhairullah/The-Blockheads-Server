import { join } from 'path'
import { config } from '../../config'
import { playerManager } from '../helpers/blockhead-mapping'

// ============================================================================
// Constants
// ============================================================================

export const LOG_BOT_DEBUG = process.env.BH_LOG_BOT_DEBUG === '1'
export const LOG_ACTIVITY_EVENTS = process.env.BH_LOG_ACTIVITY_EVENTS === '1'
export const LOG_BLOCKHEAD_MAP = process.env.BH_LOG_BLOCKHEAD_MAP === '1'

export const SUSPICIOUS_LOG_PATH = join(config.paths.dataDir, 'suspicious-portal-chest.jsonl')
export const PORTAL_CHEST_BUYERS_PATH = join(config.paths.dataDir, 'portal-chest-buyers.json')

export const MAX_PENDING_UUIDS = 200
export const BLOCKHEAD_REFRESH_INTERVAL_MS = 10000
export const ACTIVE_PLAYER_WINDOW_MS = 120000
export const FAILED_LOOKUP_COOLDOWN = 10 * 1000

export const FORBIDDEN_ITEM_IDS = new Set(config.game.forbiddenItemIds)

// ============================================================================
// ActivityContext — shared state passed to all sub-modules
// ============================================================================

export interface ActivityContext {
  bot: { send: (msg: string) => void }

  // Forbidden items state
  portalChestBuyers: Set<string>
  pendingForbiddenByUuid: Map<string, Array<{ itemId: number; itemName: string; count: number; blockheadId?: number }>>
  pendingForbiddenByBlockhead: Map<number, Array<{ itemId: number; itemName: string; count: number }>>
  pendingRemovals: Map<string, number>
  forbiddenCounts: Map<string, number>
  bannedForForbidden: Set<string>
  pendingOwnerLookups: Set<number>
  failedOwnerLookups: Map<number, number>

  // Wirable cross-module function references
  takeItemFromBlockhead: (blockheadId: number, itemId: number, count: number, playerUuid?: string) => Promise<{ success: boolean; taken?: number; error?: string }>
  listBlockheadsForPlayer: (playerName: string, playerUuid: string) => Promise<void>
  getPlayerUuid: (playerName: string) => string | null
  savePortalChestBuyers: () => Promise<void>
}

export function createActivityContext(bot: any): ActivityContext {
  return {
    bot,

    portalChestBuyers: new Set(),
    pendingForbiddenByUuid: new Map(),
    pendingForbiddenByBlockhead: new Map(),
    pendingRemovals: new Map(),
    forbiddenCounts: new Map(),
    bannedForForbidden: new Set(),
    pendingOwnerLookups: new Set(),
    failedOwnerLookups: new Map(),

    // Wired after init
    takeItemFromBlockhead: async () => ({ success: false, error: 'not initialized' }),
    listBlockheadsForPlayer: async () => {},
    getPlayerUuid: () => null,
    savePortalChestBuyers: async () => {},
  }
}

// ============================================================================
// Shared utility functions
// ============================================================================

export const setWithLimit = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > limit) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
}

export const pruneMap = <K, V>(map: Map<K, V>, limit: number) => {
  while (map.size > limit) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
}

export const markPlayerActive = (playerName: string | null) => {
  if (!playerName) return
  const player = playerManager.get(playerName)
  if (player) player.lastActivity = Date.now()
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
