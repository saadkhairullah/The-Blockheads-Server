import { readFile, writeFile, stat, mkdir, rename } from 'fs/promises'
import {
  QuestContext, PlayerQuestProgress, PendingReward, Quest,
  QUEST_DATA_PATH, PENDING_REWARDS_PATH, BACKUP_DIR,
  AUTO_SAVE_INTERVAL, BACKUP_INTERVAL, LOG_BOT_DEBUG,
  // @ts-ignore — LAST_OLD_QUEST_ID, FIRST_NEW_QUEST_ID will be used in upcoming quest migration
  CURRENT_QUEST_VERSION, LAST_OLD_QUEST_ID, FIRST_NEW_QUEST_ID,
} from './quest-context'

const questBackupPath = `${BACKUP_DIR}/quest-progress-backup.json`

// Debounce: coalesce rapid save calls into one disk write per 500ms window
let debounceTimer: NodeJS.Timeout | null = null
let saveInProgress = false

const ensureBackupDir = async () => {
  try {
    await stat(BACKUP_DIR)
  } catch {
    await mkdir(BACKUP_DIR, { recursive: true })
    console.log(`[Quest System] Created backup directory: ${BACKUP_DIR}`)
  }
}

export const loadQuestProgress = async (ctx: QuestContext) => {
  try {
    const data = await readFile(QUEST_DATA_PATH, 'utf8')
    const parsed = JSON.parse(data) as Record<string, PlayerQuestProgress>
    for (const [player, progress] of Object.entries(parsed)) {
      ctx.playerProgress.set(player, progress)
    }
    console.log(`[Quest System] Loaded progress for ${ctx.playerProgress.size} players`)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.log('[Quest System] No existing progress file, starting fresh')
    } else {
      console.error(`[Quest System] ERROR loading quest progress: ${err.message}`)
      console.log('[Quest System] Attempting to load from backup...')
      try {
        const backupData = await readFile(questBackupPath, 'utf8')
        const parsed = JSON.parse(backupData) as Record<string, PlayerQuestProgress>
        for (const [player, progress] of Object.entries(parsed)) {
          ctx.playerProgress.set(player, progress)
        }
        console.log(`[Quest System] Restored ${ctx.playerProgress.size} players from backup!`)
      } catch (backupErr: any) {
        console.error(`[Quest System] Backup also failed: ${backupErr.message}`)
        console.log('[Quest System] Starting fresh (no valid data found)')
      }
    }
  }
}

const _doSave = async (ctx: QuestContext) => {
  if (saveInProgress) return
  saveInProgress = true

  const obj: Record<string, PlayerQuestProgress> = {}
  for (const [player, progress] of ctx.playerProgress.entries()) {
    obj[player] = progress
  }
  const jsonData = JSON.stringify(obj, null, 2)

  try {
    const tempPath = QUEST_DATA_PATH + '.tmp'
    await writeFile(tempPath, jsonData)
    await rename(tempPath, QUEST_DATA_PATH)
    console.log(`[Quest System] Saved progress for ${ctx.playerProgress.size} players`)
  } catch (err: any) {
    console.error(`[Quest System] ERROR saving quest progress: ${err.message}`)
  } finally {
    saveInProgress = false
  }
}

export const saveQuestProgress = (ctx: QuestContext): void => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    _doSave(ctx)
  }, 500)
}

const saveBackup = async (ctx: QuestContext) => {
  if (ctx.playerProgress.size === 0) return

  try {
    await ensureBackupDir()
    const obj: Record<string, PlayerQuestProgress> = {}
    for (const [player, progress] of ctx.playerProgress.entries()) {
      obj[player] = progress
    }
    const jsonData = JSON.stringify(obj, null, 2)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const timestampedPath = `${BACKUP_DIR}/quest-progress-${timestamp}.json`
    await writeFile(timestampedPath, jsonData)
    await writeFile(questBackupPath, jsonData)

    console.log(`[Quest System] Hourly backup saved: ${timestampedPath}`)
  } catch (err: any) {
    console.error(`[Quest System] ERROR saving backup: ${err.message}`)
  }
}

export const loadPendingRewards = async (ctx: QuestContext) => {
  try {
    const data = await readFile(PENDING_REWARDS_PATH, 'utf8')
    const parsed = JSON.parse(data) as Record<string, PendingReward[]>
    for (const [player, rewards] of Object.entries(parsed)) {
      ctx.pendingRewards.set(player, rewards)
    }
    console.log(`[Quest System] Loaded pending rewards for ${ctx.pendingRewards.size} players`)
  } catch {
    console.log('[Quest System] No existing pending rewards file')
  }
}

export const savePendingRewards = async (ctx: QuestContext) => {
  const obj: Record<string, PendingReward[]> = {}
  for (const [player, rewards] of ctx.pendingRewards.entries()) {
    if (rewards.length > 0) {
      obj[player] = rewards
    }
  }
  await writeFile(PENDING_REWARDS_PATH, JSON.stringify(obj, null, 2))
}

export const markQuestCompleted = (ctx: QuestContext, playerName: string, quest: Quest) => {
  const progress = getPlayerProgress(ctx, playerName)
  if (!progress.completedQuests.includes(quest.id)) {
    progress.completedQuests.push(quest.id)
  }
  progress.travelCompleted = {}
  if (quest.nextQuestId) {
    progress.currentQuestId = quest.nextQuestId
  } else {
    progress.currentQuestId = ''
  }
}

export const getPlayerProgress = (ctx: QuestContext, playerName: string): PlayerQuestProgress => {
  let progress = ctx.playerProgress.get(playerName)
  if (!progress) {
    progress = {
      currentQuestId: ctx.firstQuestId ?? '',
      travelCompleted: {},
      completedQuests: [],
      questVersion: CURRENT_QUEST_VERSION,
    }
    ctx.playerProgress.set(playerName, progress)
  }
  return progress
}

/**
 * Apply the season reset for a single player.
 * - currentQuestId resets to quest '1' (full restart)
 * - travelCompleted and killProgress are cleared
 * - completedQuests is KEPT so already-rewarded quests don't pay out again
 * - questVersion is bumped to CURRENT_QUEST_VERSION
 * Returns true if the progress was actually changed.
 */
export const applySeasonResetForPlayer = (ctx: QuestContext, playerName: string): boolean => {
  const progress = ctx.playerProgress.get(playerName)
  if (!progress) return false
  if ((progress.questVersion ?? 1) >= CURRENT_QUEST_VERSION) return false

  progress.currentQuestId = ctx.firstQuestId ?? '1'
  progress.travelCompleted = {}
  progress.killProgress = {}
  progress.questVersion = CURRENT_QUEST_VERSION
  console.log(`[Quest System] Season reset applied to ${playerName} (completedQuests preserved)`)
  return true
}

/**
 * Bulk season reset: applies to all players not yet on CURRENT_QUEST_VERSION.
 * Returns the count of players updated.
 */
export const applySeasonReset = (ctx: QuestContext): number => {
  let count = 0
  for (const [playerName] of ctx.playerProgress.entries()) {
    if (applySeasonResetForPlayer(ctx, playerName)) count++
  }
  return count
}

export const getCurrentQuest = (ctx: QuestContext, playerName: string): Quest | null => {
  const progress = getPlayerProgress(ctx, playerName)
  if (!progress.currentQuestId) return null
  return ctx.questById.get(progress.currentQuestId) ?? null
}

// Timer management
let autoSaveTimer: NodeJS.Timeout | null = null
let backupTimer: NodeJS.Timeout | null = null

export const startAutoSave = (ctx: QuestContext) => {
  if (autoSaveTimer) clearInterval(autoSaveTimer)
  autoSaveTimer = setInterval(() => {
    if (ctx.playerProgress.size > 0) {
      saveQuestProgress(ctx)
    }
  }, AUTO_SAVE_INTERVAL)
  console.log('[Quest System] Auto-save started (every hour)')

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => saveBackup(ctx), BACKUP_INTERVAL)
  setTimeout(() => saveBackup(ctx), 5000)
  console.log('[Quest System] Hourly backup started')
}

export const stopAutoSave = () => {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer)
    autoSaveTimer = null
  }
  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
}

// Pending reward helpers
export const getPendingRewards = (ctx: QuestContext, playerName: string): PendingReward[] => {
  return ctx.pendingRewards.get(playerName) ?? []
}

export const clearPendingRewards = (ctx: QuestContext, playerName: string) => {
  ctx.pendingRewards.delete(playerName)
  ctx.savePendingRewards()
}

export const hasPendingRewards = (ctx: QuestContext, playerName: string): boolean => {
  const rewards = ctx.pendingRewards.get(playerName)
  return rewards !== undefined && rewards.length > 0
}

export const addToPendingRewards = (
  ctx: QuestContext,
  playerName: string,
  items: Array<{ itemId: number; count: number; itemName?: string }>,
  source: string
) => {
  if (items.length === 0) return
  const pr: PendingReward = {
    questId: `failed_${Date.now()}`,
    questTitle: source,
    timestamp: Date.now(),
    rewards: items.map(i => ({ type: 'item' as const, itemId: i.itemId, count: i.count, itemName: i.itemName })),
  }
  const existing = ctx.pendingRewards.get(playerName) ?? []
  existing.push(pr)
  ctx.pendingRewards.set(playerName, existing)
  ctx.savePendingRewards()
  if (LOG_BOT_DEBUG) console.log(`[Quest System] Added ${items.length} failed items to pending rewards for ${playerName}`)
}
