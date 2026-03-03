import { MessageBot } from '@bhmb/bot'
import * as BlockheadService from '../blockhead-service'
import { sharedMappingState, pruneMappingCaches, getBlockheadsForUuid, listBlockheadsForPlayerByUuid } from './helpers/blockhead-mapping'
import { setKillCallback } from '../linux-api'

// Sub-modules
import { createQuestContext, WORLD_SAVE_PATH, PYTHON_PATH, REWARD_SCRIPT } from './quests/quest-context'
import { loadQuestProgress, loadPendingRewards, saveQuestProgress, savePendingRewards, startAutoSave, stopAutoSave, getPlayerProgress } from './quests/quest-persistence'
import { getInventoryCount, hasFreshInventory, startInventoryPolling, stopInventoryPolling } from './quests/quest-inventory'
import { checkQuestCompletion, isPlayerCurrentlyAtLocation } from './quests/quest-completion'
import { registerQuestCommands } from './quests/quest-commands'
import { startWatching, cleanupEventState } from './quests/quest-events'
import { processKillEvent } from './quests/quest-kills'

MessageBot.registerExtension('quest-system', (ex) => {
  console.log('Quest System extension loaded!')

  const ctx = createQuestContext(ex)

  // Initialize the shared blockhead daemon service
  BlockheadService.initBlockheadService(PYTHON_PATH, REWARD_SCRIPT, WORLD_SAVE_PATH, 10)

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
    const cached = ctx.playerToBlockheads.get(playerName)
    if (cached && cached.size > 0) {
      return Promise.resolve(Array.from(cached))
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

    ctx.playerToUuid.set(playerName, playerUuid)
    ctx.uuidToPlayer.set(playerUuid, playerName)
    ctx.playerLastActivity.set(playerName, Date.now())

    // Mark online IMMEDIATELY
    ctx.onlinePlayers.add(playerName)

    // Use pre-loaded index (fast, synchronous)
    const preKnown = getBlockheadsForUuid(playerUuid, sharedMappingState)
    if (preKnown && preKnown.size > 0) {
      for (const bhId of preKnown) {
        ctx.blockheadToPlayer.set(bhId, playerName)
        const set = ctx.playerToBlockheads.get(playerName) ?? new Set<number>()
        set.add(bhId)
        ctx.playerToBlockheads.set(playerName, set)
      }
    }

    // Check blockheadIdToUuid for any seen via packet events
    for (const [bhId, ownerUuid] of ctx.blockheadIdToUuid.entries()) {
      if (ownerUuid !== playerUuid) continue
      if (ctx.blockheadToPlayer.get(bhId) === playerName) continue
      ctx.blockheadToPlayer.set(bhId, playerName)
      const set = ctx.playerToBlockheads.get(playerName) ?? new Set<number>()
      set.add(bhId)
      ctx.playerToBlockheads.set(playerName, set)
    }

    if (blockheadName) {
      ctx.playerToBlockheadName.set(playerName, blockheadName)
      const id = ctx.blockheadNameToId.get(blockheadName)
      if (typeof id === 'number') {
        ctx.playerToLastBlockhead.set(playerName, id)
      } else {
        ctx.pendingBlockheadName.set(playerName, blockheadName)
      }
    }

    // Background blockhead lookup for new players
    const currentSet = ctx.playerToBlockheads.get(playerName)
    if (!currentSet || currentSet.size === 0) {
      enqueueJoinBlockheadLookup(playerName, playerUuid).then(blockheadIds => {
        if (!ctx.onlinePlayers.has(playerName)) return

        if (blockheadIds && blockheadIds.length > 0) {
          const set = ctx.playerToBlockheads.get(playerName) ?? new Set<number>()
          for (const id of blockheadIds) {
            set.add(id)
            ctx.blockheadToPlayer.set(id, playerName)
            ctx.blockheadToOwnerUuid.set(id, playerUuid)
          }
          ctx.playerToBlockheads.set(playerName, set)
        } else {
          setTimeout(async () => {
            if (!ctx.onlinePlayers.has(playerName)) return
            const retryIds = await listBlockheadsForPlayerByUuid(playerUuid)
            if (!ctx.onlinePlayers.has(playerName)) return
            if (retryIds && retryIds.length > 0) {
              const retrySet = ctx.playerToBlockheads.get(playerName) ?? new Set<number>()
              for (const id of retryIds) {
                retrySet.add(id)
                ctx.blockheadToPlayer.set(id, playerName)
                ctx.blockheadToOwnerUuid.set(id, playerUuid)
              }
              ctx.playerToBlockheads.set(playerName, retrySet)
            }
          }, 3000)
        }
      }).catch(err => {
        console.error(`[Quest System] Background blockhead lookup failed for ${playerName}:`, err)
      })
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
      ctx.onlinePlayers.delete(playerName)
      ctx.pendingInventoryRefresh.delete(playerName)
      ctx.playerLastActivity.delete(playerName)
      ctx.playerToLastBlockhead.delete(playerName)
      ctx.inventoryCache.delete(playerName)
    }
  })

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  Promise.all([loadQuestProgress(ctx), loadPendingRewards(ctx)]).then(async () => {
    // Fetch full blockhead index from daemon on startup
    try {
      const fullIndex = await BlockheadService.getFullBlockheadIndex()
      for (const [playerUuid, blockheadIds] of fullIndex.entries()) {
        const { attachBlockheadsToUuid } = require('./helpers/blockhead-mapping')
        attachBlockheadsToUuid(playerUuid, Array.from(blockheadIds), sharedMappingState)
      }
      console.log(`[Quest System] Pre-loaded ${fullIndex.size} player->blockhead mappings`)
    } catch (err) {
      console.error('[Quest System] Failed to pre-load blockhead index:', err)
    }

    startWatching(ctx)
    startInventoryPolling(ctx)
    startAutoSave(ctx)
  })

  // -------------------------------------------------------------------------
  // Periodic cleanup
  // -------------------------------------------------------------------------

  const cleanupStaleMaps = () => {
    const MAX_MAPPING_SIZE = 1000

    pruneMappingCaches(sharedMappingState, MAX_MAPPING_SIZE)

    if (ctx.blockheadNameToId.size > MAX_MAPPING_SIZE) {
      const entries = Array.from(ctx.blockheadNameToId.entries())
      ctx.blockheadNameToId.clear()
      for (const [k, v] of entries.slice(-MAX_MAPPING_SIZE)) {
        ctx.blockheadNameToId.set(k, v)
      }
    }

    if (ctx.lastCoords.size > 100000) {
      console.log(`[Quest System] lastCoords exceeded 100000 (${ctx.lastCoords.size}), clearing — online players will repopulate from events`)
      ctx.lastCoords.clear()
    }

    if (ctx.blockheadIdToUuid.size > MAX_MAPPING_SIZE) {
      const entries = Array.from(ctx.blockheadIdToUuid.entries())
      ctx.blockheadIdToUuid.clear()
      for (const [k, v] of entries.slice(-MAX_MAPPING_SIZE)) {
        ctx.blockheadIdToUuid.set(k, v)
      }
    }

    const now = Date.now()
    for (const [player, lastTime] of ctx.playerLastActivity.entries()) {
      if (!ctx.onlinePlayers.has(player) && now - lastTime > 30 * 60 * 1000) {
        ctx.playerLastActivity.delete(player)
      }
    }

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
