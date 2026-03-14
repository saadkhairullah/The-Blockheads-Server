import { join } from 'path'
import { readFileSync } from 'fs'
import type { AppConfig } from '../../config'
import { Quest, QuestRequirement, QuestReward } from './quest-types'

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


// ============================================================================
// Quest versioning — bump CURRENT_QUEST_VERSION when adding new quests so
// players who finished the old questline are migrated to the new start point.
// ============================================================================
export const CURRENT_QUEST_VERSION = 2
export const LAST_OLD_QUEST_ID = '26'    // Last quest in the main chain
export const FIRST_NEW_QUEST_ID = '8.1'  // First new quest in the expanded chain


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
// (All player/blockhead mappings removed — use playerManager directly)
// ============================================================================

export interface QuestContext {
  // Config-derived paths and values (computed at factory time)
  questDataPath: string
  pendingRewardsPath: string
  shutdownFlagPath: string
  backupDir: string
  arenaCenterX: number
  arenaCenterY: number
  arenaRadius: number

  // Bot framework
  bot: { send: (msg: string) => void }
  world: {
    onMessage: { sub: (handler: (data: { player: { name: string }, message: string }) => void) => void }
    onJoin: { sub: (handler: (player: any) => void) => void }
    onLeave: { sub: (handler: (player: any) => void) => void }
  }

  // Quest-specific state
  playerProgress: Map<string, PlayerQuestProgress>
  inventoryCache: Map<string, InventoryCache>
  pendingInventoryRefresh: Set<string>
  inflightInventoryRefresh: Set<string>
  pendingRewards: Map<string, PendingReward[]>
  recentRewardFailures: Map<string, number>
  completionInFlight: Set<string>
  pendingKickDialogue: Map<string, string[]>

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

export function createQuestContext(ex: any, cfg: AppConfig): QuestContext {
  const QUESTS: Quest[] = JSON.parse(readFileSync(cfg.paths.questData, 'utf8'))
  const questById = new Map<string, Quest>()
  for (const q of QUESTS) {
    questById.set(q.id, q)
  }

  return {
    questDataPath: join(cfg.paths.dataDir, 'quest-progress.json'),
    pendingRewardsPath: join(cfg.paths.dataDir, 'pending-rewards.json'),
    shutdownFlagPath: join(cfg.paths.dataDir, '.bot-shutdown-pending'),
    backupDir: join(cfg.paths.dataDir, 'backups'),
    arenaCenterX: cfg.game.arena.x,
    arenaCenterY: cfg.game.arena.y,
    arenaRadius: cfg.game.arena.radius,

    bot: ex.bot,
    world: ex.world,

    playerProgress: new Map(),
    inventoryCache: new Map(),
    pendingInventoryRefresh: new Set(),
    inflightInventoryRefresh: new Set(),
    pendingRewards: new Map(),
    recentRewardFailures: new Map(),
    completionInFlight: new Set(),
    pendingKickDialogue: new Map(),

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
