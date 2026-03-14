import { MessageBot } from '@bhmb/bot'
import type { AppConfig } from '../config'
import type { BotContext, ExtensionFactory } from '../bot-context'
import { playerManager, listBlockheadsForPlayerByUuid } from './helpers/blockhead-mapping'
import { setKillCallback } from '../linux-api'

// Sub-modules
import { createQuestContext } from './quests/quest-context'
import { loadQuestProgress, loadPendingRewards, saveQuestProgress, savePendingRewards, startAutoSave, stopAutoSave, getPlayerProgress } from './quests/quest-persistence'
import { getInventoryCount, hasFreshInventory, startInventoryPolling, stopInventoryPolling } from './quests/quest-inventory'
import { checkQuestCompletion, isPlayerCurrentlyAtLocation, sendDialogue } from './quests/quest-completion'
import { registerQuestCommands } from './quests/quest-commands'
import { startWatching, cleanupEventState } from './quests/quest-events'
import { processKillEvent } from './quests/quest-kills'

export const QuestSystem: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('quest-system', (ex) => {
  console.log('Quest System extension loaded!')

  const ctx = createQuestContext(ex, cfg)

  // Wire cross-module function references on the context
  ctx.checkQuestCompletion = (playerName: string) => checkQuestCompletion(ctx, playerName)
  ctx.saveQuestProgress = () => saveQuestProgress(ctx)
  ctx.savePendingRewards = () => savePendingRewards(ctx)
  ctx.getInventoryCount = (playerName: string, itemId: number) => getInventoryCount(ctx, playerName, itemId)
  ctx.hasFreshInventory = (playerName: string) => hasFreshInventory(ctx, playerName)
  ctx.isPlayerCurrentlyAtLocation = (playerName, req) => isPlayerCurrentlyAtLocation(ctx, playerName, req)

  // -------------------------------------------------------------------------
  // Join lookup queue (throttled LMDB lookups on player join)
  // -------------------------------------------------------------------------

  const JOIN_LOOKUP_CONCURRENCY = 2
  const JOIN_LOOKUP_SPACING_MS = 250
  const joinLookupQueue: Array<{
    playerName: string
    playerUuid: string
    resolve: (ids: number[]) => void
    reject: (err: Error) => void
  }> = []
  let joinLookupsInFlight = 0

  const drainJoinLookupQueue = () => {
    while (joinLookupsInFlight < JOIN_LOOKUP_CONCURRENCY && joinLookupQueue.length > 0) {
      const task = joinLookupQueue.shift()
      if (!task) return
      joinLookupsInFlight += 1
      listBlockheadsForPlayerByUuid(task.playerUuid)
        .then(ids => task.resolve(ids ?? []))
        .catch(err => task.reject(err instanceof Error ? err : new Error(String(err))))
        .finally(() => {
          setTimeout(() => {
            joinLookupsInFlight -= 1
            drainJoinLookupQueue()
          }, JOIN_LOOKUP_SPACING_MS)
        })
    }
  }

  const enqueueJoinBlockheadLookup = (playerName: string, playerUuid: string): Promise<number[]> => {
    const p = playerManager.get(playerName)
    if (p && p.blockheads.size > 0) {
      return Promise.resolve(Array.from(p.blockheads.keys()))
    }
    return new Promise((resolve, reject) => {
      joinLookupQueue.push({ playerName, playerUuid, resolve, reject })
      drainJoinLookupQueue()
    })
  }

  // -------------------------------------------------------------------------
  // Kill event callback (from linux-api log watcher)
  // -------------------------------------------------------------------------

  setKillCallback((killer, victim) => {
    processKillEvent(ctx, killer, victim)
  })

  // -------------------------------------------------------------------------
  // Register chat commands
  // -------------------------------------------------------------------------

  registerQuestCommands(ctx)

  // -------------------------------------------------------------------------
  // Player join handler
  // -------------------------------------------------------------------------

  ex.world.onJoin.sub((player: any) => {
    const playerName = player.name
    const playerUuid = (player.uuid ?? player.id ?? player.playerId ?? player.userId) as string | undefined
    const blockheadName = (player as any).blockheadName as string | undefined

    if (!playerName || !playerUuid) return

    // Register/update in playerManager
    const p = playerManager.setOnline(playerName, playerUuid)

    // Handle blockhead name from join event (resolve to ID when next event arrives)
    if (blockheadName) {
      p.primaryBlockheadName = blockheadName
      const id = playerManager.blockheadNameIndex.get(blockheadName)
      if (typeof id === 'number') {
        p.lastBlockheadId = id
      } else {
        p.pendingBlockheadName = blockheadName
      }
    }

    // Apply blockheads seen via packet events (blockheadIdToUuid equivalent now in playerManager)
    // playerManager.updateFromEvent already handled this for events that arrived before join

    // Background blockhead lookup for players without known blockheads
    if (p.blockheads.size === 0) {
      enqueueJoinBlockheadLookup(playerName, playerUuid).then(blockheadIds => {
        if (!p.isOnline) return

        if (blockheadIds && blockheadIds.length > 0) {
          playerManager.attachBlockheads(p, blockheadIds)
        } else {
          setTimeout(async () => {
            if (!p.isOnline) return
            const retryIds = await listBlockheadsForPlayerByUuid(playerUuid)
            if (!p.isOnline) return
            if (retryIds && retryIds.length > 0) {
              playerManager.attachBlockheads(p, retryIds)
            }
          }, 3000)
        }
      }).catch(err => {
        console.error(`[Quest System] Background blockhead lookup failed for ${playerName}:`, err)
      })
    }

    // Drain any dialogue queued from a kick-based quest completion
    const pendingLines = ctx.pendingKickDialogue.get(playerName)
    if (pendingLines) {
      ctx.pendingKickDialogue.delete(playerName)
      setTimeout(() => sendDialogue(playerName, pendingLines), 5000)
    }

    // Delay inventory fetch until the player moves
    ctx.pendingInventoryRefresh.add(playerName)
  })

  // -------------------------------------------------------------------------
  // Player leave handler
  // -------------------------------------------------------------------------

  ex.world.onLeave.sub((player: any) => {
    const playerName = player.name
    if (playerName) {
      playerManager.setOffline(playerName)
      ctx.pendingInventoryRefresh.delete(playerName)
      ctx.inventoryCache.delete(playerName)
    }
  })

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  Promise.all([loadQuestProgress(ctx), loadPendingRewards(ctx)]).then(() => {
    startWatching(ctx)
    startInventoryPolling(ctx)
    startAutoSave(ctx)
  })

  // -------------------------------------------------------------------------
  // Periodic cleanup
  // -------------------------------------------------------------------------

  const cleanupStaleMaps = () => {
    const now = Date.now()

    // Prune blockheadNameIndex
    playerManager.pruneBlockheadNameIndex(1000)

    cleanupEventState()

    for (const [key, failTime] of ctx.recentRewardFailures.entries()) {
      if (now - failTime > 30000) {
        ctx.recentRewardFailures.delete(key)
      }
    }
  }

  setInterval(cleanupStaleMaps, 5 * 60 * 1000)

  // Heartbeat to detect event loop freezes
  let lastHeartbeat = Date.now()
  setInterval(() => {
    const now = Date.now()
    const delta = now - lastHeartbeat
    if (delta > 15000) {
      console.warn(`[Quest System] HEARTBEAT: Event loop was frozen for ${delta}ms!`)
    }
    lastHeartbeat = now
  }, 5000)

  // Export helpers for other extensions
  ex.exports = {
    hasCompletedQuest: (playerName: string, questId: string) => {
      const progress = getPlayerProgress(ctx, playerName)
      return progress.completedQuests.includes(questId)
    }
  }

  ex.remove = () => {
    stopInventoryPolling()
    stopAutoSave()
    saveQuestProgress(ctx)
    savePendingRewards(ctx)
    console.log('Quest System stopped')
  }
  })
  return 'quest-system'
}
QuestSystem.extensionName = 'quest-system'
QuestSystem.requires = ['activity-monitor']
