import { join } from 'path'
import { config } from '../../config'
import { Quest, QuestRequirement, QuestReward } from './quest-types'
import { QUESTS } from './quest-data'

// ============================================================================
// Types
// ============================================================================

export interface PlayerQuestProgress {
  currentQuestId: string
  travelCompleted: { [key: string]: boolean }
  completedQuests: string[]
  killProgress?: { [questId: string]: number }  // Arena kill counts per quest
  questVersion?: number                          // Version for migration
}

export interface InventoryCache {
  items: { [itemId: string]: number }
  lastUpdated: number
  blockheadId: number
}

export interface PendingReward {
  questId: string
  questTitle: string
  rewards: QuestReward[]
  timestamp: number
}

// ============================================================================
// Constants
// ============================================================================

export const QUEST_DATA_PATH = join(config.paths.dataDir, 'quest-progress.json')
export const PENDING_REWARDS_PATH = join(config.paths.dataDir, 'pending-rewards.json')
export const WORLD_SAVE_PATH = config.paths.worldSave
export const PYTHON_PATH = config.paths.python
export const REWARD_SCRIPT = config.paths.worldManager
export const FAST_INVENTORY_SCRIPT = config.paths.inventoryReader
export const SHUTDOWN_FLAG_PATH = join(config.paths.dataDir, '.bot-shutdown-pending')
export const BACKUP_DIR = join(config.paths.dataDir, 'backups')

// ============================================================================
// Quest versioning — bump CURRENT_QUEST_VERSION when adding new quests so
// players who finished the old questline are migrated to the new start point.
// ============================================================================
export const CURRENT_QUEST_VERSION = 2
export const LAST_OLD_QUEST_ID = '26'    // Last quest in the main chain
export const FIRST_NEW_QUEST_ID = '8.1'  // First new quest in the expanded chain

// Arena where kill quests count. Configure in config.json game.arena.
export const ARENA_CENTER_X = config.game.arena.x
export const ARENA_CENTER_Y = config.game.arena.y
export const ARENA_RADIUS    = config.game.arena.radius

export const INVENTORY_POLL_INTERVAL = 15000
export const MAX_INVENTORY_CACHE = 500
export const AUTO_SAVE_INTERVAL = 60 * 60 * 1000
export const BACKUP_INTERVAL = 60 * 60 * 1000
export const ACTIVE_BLOCKHEAD_WINDOW_MS = 120000
export const INVENTORY_INACTIVITY_MS = Number(process.env.BH_INVENTORY_INACTIVITY_MS ?? 120000)
export const JOIN_LOOKUP_CONCURRENCY = 2
export const JOIN_LOOKUP_SPACING_MS = 250
export const LOG_QUEST_CACHE = process.env.BH_LOG_QUEST_CACHE === '1'
export const LOG_BOT_DEBUG = process.env.BH_LOG_BOT_DEBUG === '1'
export const FAILED_LOOKUP_COOLDOWN = 10 * 1000

// ============================================================================
// QuestContext — shared state passed to all sub-modules
// ============================================================================

export interface QuestContext {
  // Bot framework
  bot: { send: (msg: string) => void }
  world: {
    onMessage: { sub: (handler: (data: { player: { name: string }, message: string }) => void) => void }
    onJoin: { sub: (handler: (player: any) => void) => void }
    onLeave: { sub: (handler: (player: any) => void) => void }
  }

  // Shared maps
  playerProgress: Map<string, PlayerQuestProgress>
  playerToBlockheads: Map<string, Set<number>>
  blockheadToPlayer: Map<number, string>
  blockheadToOwnerUuid: Map<number, string>
  playerToLastBlockhead: Map<string, number>
  playerToBlockheadName: Map<string, string>
  pendingBlockheadName: Map<string, string>
  blockheadNameToId: Map<string, number>
  lastCoords: Map<number, { x: number; y: number; time: number }>
  playerToUuid: Map<string, string>
  uuidToPlayer: Map<string, string>
  onlinePlayers: Set<string>
  blockheadIdToUuid: Map<number, string>
  inventoryCache: Map<string, InventoryCache>
  pendingInventoryRefresh: Set<string>
  inflightInventoryRefresh: Set<string>
  pendingRewards: Map<string, PendingReward[]>
  recentRewardFailures: Map<string, number>
  completionInFlight: Set<string>
  playerLastActivity: Map<string, number>

  // Quest data (prebuilt)
  questById: Map<string, Quest>
  firstQuestId: string | null

  // Wirable cross-module function references (set after module init)
  checkQuestCompletion: (playerName: string) => void
  saveQuestProgress: () => void
  savePendingRewards: () => Promise<void>
  getInventoryCount: (playerName: string, itemId: number) => number
  hasFreshInventory: (playerName: string) => boolean
  isPlayerCurrentlyAtLocation: (playerName: string, req: QuestRequirement) => boolean
}

export function createQuestContext(ex: any): QuestContext {
  const { sharedMappingState } = require('../helpers/blockhead-mapping')

  const questById = new Map<string, Quest>()
  for (const q of QUESTS) {
    questById.set(q.id, q)
  }

  return {
    bot: ex.bot,
    world: ex.world,

    playerProgress: new Map(),
    playerToBlockheads: sharedMappingState.playerToBlockheads,
    blockheadToPlayer: sharedMappingState.blockheadToPlayer,
    blockheadToOwnerUuid: sharedMappingState.blockheadToOwnerUuid,
    playerToLastBlockhead: new Map(),
    playerToBlockheadName: new Map(),
    pendingBlockheadName: new Map(),
    blockheadNameToId: new Map(),
    lastCoords: new Map(),
    playerToUuid: sharedMappingState.playerToUuid,
    uuidToPlayer: sharedMappingState.uuidToPlayer,
    onlinePlayers: new Set(),
    blockheadIdToUuid: new Map(),
    inventoryCache: new Map(),
    pendingInventoryRefresh: new Set(),
    inflightInventoryRefresh: new Set(),
    pendingRewards: new Map(),
    recentRewardFailures: new Map(),
    completionInFlight: new Set(),
    playerLastActivity: new Map(),

    questById,
    firstQuestId: QUESTS.length > 0 ? QUESTS[0].id : null,

    // Wired up after module init
    checkQuestCompletion: () => {},
    saveQuestProgress: async () => {},
    savePendingRewards: async () => {},
    getInventoryCount: () => 0,
    hasFreshInventory: () => false,
    isPlayerCurrentlyAtLocation: () => false,
  }
}

// Re-export quest types for convenience
export type { Quest, QuestRequirement, QuestReward }
