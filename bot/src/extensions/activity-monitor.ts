import { MessageBot } from '@bhmb/bot'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { config } from '../config'
import * as BlockheadService from '../blockhead-service'
import { sendPrivateMessage } from '../private-message'
import { attachBlockheadsToPlayer, normalizePlayerName, sharedMappingState, pruneMappingCaches } from './helpers/blockhead-mapping'

// Sub-modules
import {
  createActivityContext,
  LOG_BOT_DEBUG, LOG_BLOCKHEAD_MAP,
  MAX_PLAYER_CACHE, BLOCKHEAD_REFRESH_INTERVAL_MS, ACTIVE_PLAYER_WINDOW_MS,
  setWithLimit, markPlayerActive, pruneMap,
} from './activity/activity-context'
import {
  loadPortalChestBuyers, addPortalChestBuyer, removePortalChestBuyer,
  enforceForbiddenForPlayer, drainPendingForbiddenForBlockhead,
  cleanupPendingRemovals,
} from './activity/forbidden-items'
import { setCoords, registerCoordsCommand, cleanupCoordsMaps } from './activity/coords-tracker'
import { startWatching } from './activity/activity-events'

MessageBot.registerExtension('activity-monitor', (ex) => {
  console.log('Activity Monitor extension loaded!')

  const ctx = createActivityContext(ex.bot)

  // Load portal chest buyers on startup
  loadPortalChestBuyers(ctx)

  // -------------------------------------------------------------------------
  // listBlockheadsForPlayer — bridges mapping, forbidden items, and coords
  // -------------------------------------------------------------------------

  const listBlockheadsForPlayer = async (playerName: string, playerUuid: string) => {
    try {
      const ids = await BlockheadService.getBlockheadsForPlayer(playerUuid)
      if (!ids || ids.length === 0) return
      attachBlockheadsToPlayer(
        playerName,
        playerUuid,
        ids,
        sharedMappingState,
        { maxCache: MAX_PLAYER_CACHE, pruneMap }
      )
      for (const id of ids) {
        drainPendingForbiddenForBlockhead(ctx, id)
      }

      // Retroactively associate existing coords with this player
      // Fixes race condition where PLAYER_MOVE events arrive before mapping is ready
      for (const id of ids) {
        const existingCoords = ctx.lastCoords.get(id)
        if (existingCoords) {
          const current = ctx.lastPlayerCoords.get(playerName)
          const existingTime = Date.parse(existingCoords.time)
          const currentTime = current ? Date.parse(current.time) : -1
          if (!current || (Number.isFinite(existingTime) && existingTime > currentTime)) {
            setCoords(ctx.lastPlayerCoords, playerName, existingCoords)
          }
        }
      }

      if (LOG_BLOCKHEAD_MAP) {
        if (LOG_BOT_DEBUG) console.log(`[Activity Monitor] ${playerName} blockheads: ${ids.join(', ')}`)
      }
    } catch (err) {
      console.error('[Activity Monitor] Failed to list blockheads:', err)
    }
  }

  // -------------------------------------------------------------------------
  // takeItemFromBlockhead — daemon wrapper
  // -------------------------------------------------------------------------

  const takeItemFromBlockhead = async (blockheadId: number, itemId: number, count: number, playerUuid?: string): Promise<{ success: boolean; taken?: number; error?: string }> => {
    try {
      return await BlockheadService.takeItem(blockheadId, itemId, count, playerUuid)
    } catch (err) {
      console.error('[Activity Monitor] Failed to take item:', err)
      return { success: false, error: String(err) }
    }
  }

  // -------------------------------------------------------------------------
  // Export helpers (defined early so they can be wired on ctx)
  // -------------------------------------------------------------------------

  const getPlayerUuid = (playerName: string): string | null => {
    return ctx.playerToUuid.get(playerName) ?? ctx.playerToUuid.get(playerName.toUpperCase()) ?? null
  }

  // -------------------------------------------------------------------------
  // Wire cross-module function references on the context
  // -------------------------------------------------------------------------

  ctx.takeItemFromBlockhead = takeItemFromBlockhead
  ctx.listBlockheadsForPlayer = listBlockheadsForPlayer
  ctx.getPlayerUuid = getPlayerUuid
  ctx.savePortalChestBuyers = async () => {
    const { savePortalChestBuyers: _save } = require('./activity/forbidden-items')
    await _save(ctx)
  }

  // -------------------------------------------------------------------------
  // /coords command
  // -------------------------------------------------------------------------

  registerCoordsCommand(ctx, ex.world)

  // -------------------------------------------------------------------------
  // Tracked blockhead selection — /tracked and /track <n>
  // -------------------------------------------------------------------------

  const TRACKED_BH_PATH = join(config.paths.dataDir, 'tracked-blockheads.json')
  const playerTrackedBlockhead = sharedMappingState.playerTrackedBlockhead

  // Load persisted selections on startup
  readFile(TRACKED_BH_PATH, 'utf8').then(data => {
    const parsed = JSON.parse(data) as Record<string, number>
    for (const [name, id] of Object.entries(parsed)) {
      playerTrackedBlockhead.set(name, id)
    }
    console.log(`[Activity Monitor] Loaded ${playerTrackedBlockhead.size} tracked blockhead selections`)
  }).catch(() => {
    console.log('[Activity Monitor] No tracked-blockheads.json, starting fresh')
  })

  const saveTrackedBlockheads = () => {
    const obj: Record<string, number> = {}
    for (const [name, id] of playerTrackedBlockhead.entries()) {
      obj[name] = id
    }
    writeFile(TRACKED_BH_PATH, JSON.stringify(obj, null, 2)).catch(err =>
      console.error('[Activity Monitor] Failed to save tracked blockheads:', err)
    )
  }

  // /tracked — show which blockhead is being tracked
  ex.world.onMessage.sub(async ({ player, message }: { player: any; message: string }) => {
    if (message !== '/tracked') return
    const playerName = player.name as string
    const playerUuid = getPlayerUuid(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your account. Try moving around first.`)
      return
    }

    const blockheads = await BlockheadService.getBlockheadNames(playerUuid)
    if (!blockheads || blockheads.length === 0) {
      sendPrivateMessage(playerName, `${playerName}: No blockheads found. Try rejoining.`)
      return
    }

    if (blockheads.length === 1) {
      const bh = blockheads[0]
      const coords = ctx.lastCoords.get(bh.blockheadId)
      const coordStr = coords ? `last seen at (${coords.x}, ${coords.y})` : 'no position yet'
      sendPrivateMessage(playerName, `${playerName}: You have one blockhead (${bh.name}) — tracked automatically. ${coordStr}`)
      return
    }

    const trackedId = playerTrackedBlockhead.get(playerName)
    let msg = `${playerName}: Your blockheads:\n`
    for (let i = 0; i < blockheads.length; i++) {
      const bh = blockheads[i]
      const coords = ctx.lastCoords.get(bh.blockheadId)
      const coordStr = coords ? `(${coords.x}, ${coords.y})` : 'no position yet'
      const isTracked = bh.blockheadId === trackedId
      msg += `  ${i + 1}. ${bh.name}${isTracked ? ' — TRACKED' : ''} — ${coordStr}\n`
    }
    if (!trackedId) {
      msg += `No blockhead selected. Type /track 1-${blockheads.length} to choose one for quests and coords.`
    } else {
      msg += `Type /track 1-${blockheads.length} to change.`
    }
    sendPrivateMessage(playerName, msg.trim())
  })

  // /track <n> — select a blockhead to track
  ex.world.onMessage.sub(async ({ player, message }: { player: any; message: string }) => {
    if (!message.startsWith('/track ')) return
    const playerName = player.name as string
    const nStr = message.slice('/track '.length).trim()
    const n = parseInt(nStr, 10)

    const playerUuid = getPlayerUuid(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your account. Try moving around first.`)
      return
    }

    const blockheads = await BlockheadService.getBlockheadNames(playerUuid)
    if (!blockheads || blockheads.length === 0) {
      sendPrivateMessage(playerName, `${playerName}: No blockheads found. Try rejoining.`)
      return
    }

    if (blockheads.length === 1) {
      sendPrivateMessage(playerName, `${playerName}: You only have one blockhead (${blockheads[0].name}) — it is tracked automatically.`)
      return
    }

    if (isNaN(n) || n < 1 || n > blockheads.length) {
      sendPrivateMessage(playerName, `${playerName}: Please enter a number between 1 and ${blockheads.length}. Type /tracked to see your blockheads.`)
      return
    }

    const chosen = blockheads[n - 1]
    playerTrackedBlockhead.set(playerName, chosen.blockheadId)
    saveTrackedBlockheads()
    sendPrivateMessage(playerName, `${playerName}: Now tracking ${chosen.name}. Your coords and quests will use this blockhead.`)
    console.log(`[Activity Monitor] ${playerName} selected tracked blockhead: ${chosen.name} (${chosen.blockheadId})`)
  })

  // -------------------------------------------------------------------------
  // Player join handler
  // -------------------------------------------------------------------------

  ex.world.onJoin.sub(async (player: any) => {
    const rawName = player.name
    const playerUuid = (player.uuid ?? player.id ?? player.playerId ?? player.userId) as string | undefined
    if (!rawName || !playerUuid) return
    const playerName = normalizePlayerName(rawName, 'upper')
    if (!playerName) return

    // Clear stale mappings for this player before setting new ones
    const oldBlockheads = ctx.playerToBlockheads.get(playerName) ?? ctx.playerToBlockheads.get(rawName)
    if (oldBlockheads) {
      for (const bhId of oldBlockheads) {
        ctx.blockheadToUuid.delete(bhId)
        ctx.lastCoords.delete(bhId)
      }
      ctx.playerToBlockheads.delete(playerName)
      if (rawName !== playerName) ctx.playerToBlockheads.delete(rawName)
    }
    ctx.lastPlayerCoords.delete(playerName)
    if (rawName !== playerName) ctx.lastPlayerCoords.delete(rawName)

    setWithLimit(ctx.playerToUuid, rawName, playerUuid, MAX_PLAYER_CACHE)
    if (rawName !== playerName) {
      setWithLimit(ctx.playerToUuid, playerName, playerUuid, MAX_PLAYER_CACHE)
    }
    setWithLimit(ctx.uuidToPlayer, playerUuid, rawName, MAX_PLAYER_CACHE)
    ctx.onlinePlayers.add(playerName)
    if (rawName !== playerName) {
      ctx.onlinePlayers.add(rawName)
    }
    markPlayerActive(ctx, playerName)

    const pending = ctx.pendingForbiddenByUuid.get(playerUuid)
    if (pending && pending.length > 0) {
      ctx.pendingForbiddenByUuid.delete(playerUuid)
      for (const entry of pending) {
        enforceForbiddenForPlayer(ctx, rawName, entry.itemId, entry.itemName, entry.count, entry.blockheadId, true)
      }
    }

    // CRITICAL: Await blockhead lookup to prevent race condition where PLAYER_MOVE
    // events arrive before mappings are ready, causing coords to freeze
    await listBlockheadsForPlayer(rawName, playerUuid)
  })

  // -------------------------------------------------------------------------
  // Player leave handler
  // -------------------------------------------------------------------------

  ex.world.onLeave.sub((player: any) => {
    const rawName = player.name
    if (!rawName) return
    const playerName = normalizePlayerName(rawName, 'upper')
    if (playerName) ctx.onlinePlayers.delete(playerName)
    if (rawName !== playerName) ctx.onlinePlayers.delete(rawName)
  })

  // -------------------------------------------------------------------------
  // Start monitoring
  // -------------------------------------------------------------------------

  startWatching(ctx, ex.bot)
  setInterval(() => cleanupPendingRemovals(ctx), 60000)
  setInterval(() => cleanupStaleMaps(ctx), 5 * 60 * 1000)
  setInterval(() => cleanupCoordsMaps(ctx), 60 * 60 * 1000)

  // Stagger blockhead refresh to avoid overwhelming daemon with simultaneous requests
  setInterval(() => {
    const now = Date.now()
    const playersToRefresh: Array<{ name: string; uuid: string }> = []

    for (const playerName of ctx.onlinePlayers) {
      const last = ctx.playerLastActivity.get(playerName) ?? 0
      const hasBlockheads = ctx.playerToBlockheads.has(playerName) && ctx.playerToBlockheads.get(playerName)!.size > 0

      if (!hasBlockheads || (now - last <= ACTIVE_PLAYER_WINDOW_MS)) {
        const playerUuid = ctx.playerToUuid.get(playerName)
        if (playerUuid) {
          playersToRefresh.push({ name: playerName, uuid: playerUuid })
        }
      }
    }

    playersToRefresh.forEach(({ name, uuid }, index) => {
      setTimeout(() => {
        listBlockheadsForPlayer(name, uuid)
      }, index * 100)
    })
  }, BLOCKHEAD_REFRESH_INTERVAL_MS)

  // -------------------------------------------------------------------------
  // Cleanup stale map entries
  // -------------------------------------------------------------------------

  const cleanupStaleMaps = (actCtx: typeof ctx) => {
    const now = Date.now()
    const STALE_THRESHOLD = 30 * 60 * 1000

    for (const [player, lastTime] of actCtx.playerLastActivity.entries()) {
      if (!actCtx.onlinePlayers.has(player) && now - lastTime > STALE_THRESHOLD) {
        actCtx.playerLastActivity.delete(player)
      }
    }

    pruneMappingCaches(sharedMappingState, MAX_PLAYER_CACHE)

    if (actCtx.blockheadNameToOwner.size > 500) {
      const entries = Array.from(actCtx.blockheadNameToOwner.entries())
      actCtx.blockheadNameToOwner.clear()
      for (const [k, v] of entries.slice(-500)) {
        actCtx.blockheadNameToOwner.set(k, v)
      }
    }

    if (actCtx.forbiddenCounts.size > 200) {
      const entries = Array.from(actCtx.forbiddenCounts.entries())
      actCtx.forbiddenCounts.clear()
      for (const [k, v] of entries.slice(-200)) {
        actCtx.forbiddenCounts.set(k, v)
      }
    }

    if (actCtx.bannedForForbidden.size > 100) {
      const entries = Array.from(actCtx.bannedForForbidden)
      actCtx.bannedForForbidden.clear()
      for (const entry of entries.slice(-100)) {
        actCtx.bannedForForbidden.add(entry)
      }
    }

    const { FAILED_LOOKUP_COOLDOWN } = require('./activity/activity-context')
    for (const [blockheadId, failTime] of actCtx.failedOwnerLookups.entries()) {
      if (now - failTime > FAILED_LOOKUP_COOLDOWN) {
        actCtx.failedOwnerLookups.delete(blockheadId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Export helpers
  // -------------------------------------------------------------------------

  const getBlockheadsForPlayer = (playerName: string): number[] => {
    const ids = ctx.playerToBlockheads.get(playerName) ?? ctx.playerToBlockheads.get(playerName.toUpperCase())
    if (!ids || ids.size === 0) return []
    return Array.from(ids)
  }

  const getMostRecentBlockheadId = (playerName: string): number | null => {
    const ids = ctx.playerToBlockheads.get(playerName) ?? ctx.playerToBlockheads.get(playerName.toUpperCase())
    if (!ids || ids.size === 0) return null

    // Multi-BH player with an explicit selection — use it
    if (ids.size > 1) {
      const tracked = playerTrackedBlockhead.get(playerName)
      if (tracked && ids.has(tracked)) return tracked
    }

    // Single-BH player or no selection made — fall back to last active
    let bestId: number | null = null
    let bestTime = -1
    for (const id of ids) {
      const coords = ctx.lastCoords.get(id)
      if (!coords) continue
      const t = Date.parse(coords.time)
      if (Number.isNaN(t)) continue
      if (t > bestTime) {
        bestTime = t
        bestId = id
      }
    }
    return bestId
  }

  ex.exports = {
    addAdminAllowlist: (playerName: string) => addPortalChestBuyer(ctx, playerName),
    removeAdminAllowlist: (playerName: string) => removePortalChestBuyer(ctx, playerName),
    getBlockheadsForPlayer,
    getMostRecentBlockheadId,
    getPlayerUuid,
  }

  ex.remove = () => {
    console.log('Activity Monitor stopped')
  }
})
