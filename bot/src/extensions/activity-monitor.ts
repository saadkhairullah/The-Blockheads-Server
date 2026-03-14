import { MessageBot } from '@bhmb/bot'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { AppConfig } from '../config'
import type { BotContext, ExtensionFactory } from '../bot-context'
import * as BlockheadService from '../blockhead-service'
import { sendPrivateMessage } from '../private-message'
import { attachBlockheadsToPlayer, normalizePlayerName, playerManager } from './helpers/blockhead-mapping'

// Sub-modules
import {
  createActivityContext,
  LOG_BOT_DEBUG, LOG_BLOCKHEAD_MAP,
  BLOCKHEAD_REFRESH_INTERVAL_MS, ACTIVE_PLAYER_WINDOW_MS,
} from './activity/activity-context'
import {
  loadPortalChestBuyers, addPortalChestBuyer, removePortalChestBuyer,
  enforceForbiddenForPlayer, drainPendingForbiddenForBlockhead,
  cleanupPendingRemovals,
} from './activity/forbidden-items'
import { registerCoordsCommand, cleanupCoordsMaps } from './activity/coords-tracker'
import { startWatching } from './activity/activity-events'

export const ActivityMonitor: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('activity-monitor', (ex) => {
  console.log('Activity Monitor extension loaded!')

  const ctx = createActivityContext(ex.bot, cfg)

  // Load portal chest buyers on startup
  loadPortalChestBuyers(ctx)

  // -------------------------------------------------------------------------
  // listBlockheadsForPlayer — fetches from LMDB, attaches to playerManager,
  // retro-associates any coords that arrived before the mapping was ready
  // -------------------------------------------------------------------------

  const listBlockheadsForPlayer = async (playerName: string, playerUuid: string) => {
    try {
      const ids = await BlockheadService.getBlockheadsForPlayer(playerUuid)
      if (!ids || ids.length === 0) return
      attachBlockheadsToPlayer(playerName, playerUuid, ids, {} as any)
      for (const id of ids) {
        drainPendingForbiddenForBlockhead(ctx, id)
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
  // Wire cross-module function references on the context
  // -------------------------------------------------------------------------

  const getPlayerUuid = (playerName: string): string | null => {
    return playerManager.get(playerName)?.uuid ?? playerManager.get(playerName.toUpperCase())?.uuid ?? null
  }

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

  const TRACKED_BH_PATH = join(cfg.paths.dataDir, 'tracked-blockheads.json')

  // Local map of user-selected tracked blockheads (persisted to disk)
  const trackedSelections = new Map<string, number>()

  // Load persisted selections on startup — apply to Player objects as they join
  readFile(TRACKED_BH_PATH, 'utf8').then(data => {
    const parsed = JSON.parse(data) as Record<string, number>
    for (const [name, id] of Object.entries(parsed)) {
      trackedSelections.set(name, id)
    }
    console.log(`[Activity Monitor] Loaded ${trackedSelections.size} tracked blockhead selections`)
  }).catch(() => {
    console.log('[Activity Monitor] No tracked-blockheads.json, starting fresh')
  })

  const saveTrackedBlockheads = () => {
    const obj: Record<string, number> = {}
    for (const [name, id] of trackedSelections.entries()) {
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
      const p = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
      const coords = p?.blockheads.get(bh.blockheadId)?.lastCoords
      const coordStr = coords ? `last seen at (${coords.x}, ${coords.y})` : 'no position yet'
      sendPrivateMessage(playerName, `${playerName}: You have one blockhead (${bh.name}) — tracked automatically. ${coordStr}`)
      return
    }

    const p = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
    const trackedId = p?.trackedBlockheadId
    let msg = `${playerName}: Your blockheads:\n`
    for (let i = 0; i < blockheads.length; i++) {
      const bh = blockheads[i]
      const coords = p?.blockheads.get(bh.blockheadId)?.lastCoords
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
    const p = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
    if (p) p.trackedBlockheadId = chosen.blockheadId
    trackedSelections.set(playerName, chosen.blockheadId)
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

    // Clear stale session data, then mark online
    playerManager.setOffline(playerName)
    if (rawName !== playerName) playerManager.setOffline(rawName)

    playerManager.setOnline(playerName, playerUuid)
    if (rawName !== playerName) {
      const rp = playerManager.getOrCreate(rawName, playerUuid)
      rp.isOnline = true
      rp.lastActivity = Date.now()
    }

    // Apply persisted tracked blockhead selection
    const trackedId = trackedSelections.get(playerName) ?? trackedSelections.get(rawName)
    if (trackedId != null) {
      const p = playerManager.get(playerName)
      if (p) p.trackedBlockheadId = trackedId
    }

    // Drain pending forbidden items (from before join)
    const pending = ctx.pendingForbiddenByUuid.get(playerUuid)
    if (pending && pending.length > 0) {
      ctx.pendingForbiddenByUuid.delete(playerUuid)
      for (const entry of pending) {
        enforceForbiddenForPlayer(ctx, rawName, entry.itemId, entry.itemName, entry.count, entry.blockheadId, true)
      }
    }

    // CRITICAL: Await blockhead lookup so PLAYER_MOVE events don't race ahead of the mapping
    await listBlockheadsForPlayer(rawName, playerUuid)
  })

  // -------------------------------------------------------------------------
  // Player leave handler
  // -------------------------------------------------------------------------

  ex.world.onLeave.sub((player: any) => {
    const rawName = player.name
    if (!rawName) return
    const playerName = normalizePlayerName(rawName, 'upper')
    if (playerName) playerManager.setOffline(playerName)
    if (rawName !== playerName) playerManager.setOffline(rawName)
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

    for (const p of playerManager.online()) {
      const hasBlockheads = p.blockheads.size > 0
      if (!hasBlockheads || (now - p.lastActivity) <= ACTIVE_PLAYER_WINDOW_MS) {
        playersToRefresh.push({ name: p.name, uuid: p.uuid })
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

  const cleanupStaleMaps = (_actCtx: typeof ctx) => {
    const now = Date.now()
    const STALE_THRESHOLD = 30 * 60 * 1000

    if (ctx.forbiddenCounts.size > 200) {
      const entries = Array.from(ctx.forbiddenCounts.entries())
      ctx.forbiddenCounts.clear()
      for (const [k, v] of entries.slice(-200)) {
        ctx.forbiddenCounts.set(k, v)
      }
    }

    if (ctx.bannedForForbidden.size > 100) {
      const entries = Array.from(ctx.bannedForForbidden)
      ctx.bannedForForbidden.clear()
      for (const entry of entries.slice(-100)) {
        ctx.bannedForForbidden.add(entry)
      }
    }

    for (const [blockheadId, failTime] of ctx.failedOwnerLookups.entries()) {
      if (now - failTime > STALE_THRESHOLD) {
        ctx.failedOwnerLookups.delete(blockheadId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Export helpers
  // -------------------------------------------------------------------------

  const getBlockheadsForPlayer = (playerName: string): number[] => {
    const p = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
    return p ? Array.from(p.blockheads.keys()) : []
  }

  const getMostRecentBlockheadId = (playerName: string): number | null => {
    const p = playerManager.get(playerName) ?? playerManager.get(playerName.toUpperCase())
    if (!p || p.blockheads.size === 0) return null

    // User-selected tracking takes priority for multi-BH players
    if (p.blockheads.size > 1 && p.trackedBlockheadId != null && p.blockheads.has(p.trackedBlockheadId)) {
      return p.trackedBlockheadId
    }

    // Fall back to most recently active by coords time, ignoring stale blockheads
    const ACTIVE_WINDOW_MS = 120000
    let bestId: number | null = null
    let bestTime = -1
    for (const [id, bh] of p.blockheads.entries()) {
      if (!bh.lastCoords) continue
      if (Date.now() - bh.lastCoords.time > ACTIVE_WINDOW_MS) continue
      if (bh.lastCoords.time > bestTime) {
        bestTime = bh.lastCoords.time
        bestId = id
      }
    }
    // If no blockhead moved recently, fall back to lastBlockheadId
    return bestId ?? p.lastBlockheadId ?? null
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
  return 'activity-monitor'
}
ActivityMonitor.extensionName = 'activity-monitor'
ActivityMonitor.requires = []
