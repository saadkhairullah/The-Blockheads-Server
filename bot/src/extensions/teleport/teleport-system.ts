import { MessageBot } from '@bhmb/bot'
import { join } from 'path'
import type { AppConfig } from '../../config'
import type { BotContext, ExtensionFactory } from '../../bot-context'
import { enqueueShared } from '../../shared-queue'
import * as BlockheadService from '../../blockhead-service'
import { sendPrivateMessage } from '../../private-message'
import { isAdmin as isAdminHelper } from '../helpers/isAdmin'
import { getBankAPI as _getBankAPI, getActivityMonitorAPI as _getActivityMonitorAPI } from '../helpers/extension-api'

export const TeleportSystem: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('teleport-system', (ex) => {
  console.log('Teleport System extension loaded!')

  const shutdownFlagPath = join(cfg.paths.dataDir, '.bot-shutdown-pending')

  const getBankAPI = () => _getBankAPI(ex.bot)
  const getActivityMonitorAPI = () => _getActivityMonitorAPI(ex.bot)

  const isShuttingDown = (): boolean => {
    try {
      const { existsSync } = require('fs')
      return existsSync(shutdownFlagPath)
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Homes storage
  // -------------------------------------------------------------------------
  const homesPath = join(cfg.paths.dataDir, 'player-homes.json')
  const homeLocations = new Map<string, { x: number; y: number }>()

  try {
    const { readFileSync } = require('fs')
    const raw = readFileSync(homesPath, 'utf8')
    for (const [name, coords] of Object.entries(JSON.parse(raw))) {
      homeLocations.set(name, coords as { x: number; y: number })
    }
    console.log(`[/home] Loaded ${homeLocations.size} homes`)
  } catch {
    // No homes file yet — start empty
  }

  const saveHomes = () => {
    const { writeFile } = require('fs/promises')
    const obj: Record<string, { x: number; y: number }> = {}
    for (const [name, coords] of homeLocations) obj[name] = coords
    writeFile(homesPath, JSON.stringify(obj, null, 2)).catch((err: Error) => {
      console.error('[/home] Failed to save homes:', err.message)
    })
  }

  // -------------------------------------------------------------------------
  // Blockhead selection system
  // -------------------------------------------------------------------------
  interface PendingSelection {
    command: 'wild' | 'tp' | 'tpa' | 'spawn' | 'home' | 'sethome'
    blockheads: { id: number, name: string }[]
    playerName: string
    playerUuid: string
    timestamp: number
    // Command-specific data
    wildResult?: { x: number, y: number }
    tpCoords?: { x: number, y: number }
    tpaRequest?: TpaRequest
  }

  const pendingSelections = new Map<string, PendingSelection>() // lowercase playerName -> selection
  const SELECTION_EXPIRE_MS = 60 * 1000 // 60 seconds

  const getBlockheadsOrPrompt = async (
    playerName: string,
    playerUuid: string,
    command: 'wild' | 'tp' | 'tpa' | 'spawn' | 'home' | 'sethome',
    extraData: Partial<PendingSelection> = {}
  ): Promise<{ blockheadId: number } | 'prompted' | null> => {
    const blockheads = await BlockheadService.getBlockheadNames(playerUuid)
    if (!blockheads || blockheads.length === 0) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your blockheads. Please rejoin the server.`)
      return null
    }

    if (blockheads.length === 1) {
      return { blockheadId: blockheads[0].blockheadId }
    }

    // Multiple blockheads — prompt for selection
    const bhList = blockheads.map((bh, i) => `/${i + 1} - ${bh.name}`).join('\n')
    sendPrivateMessage(playerName, `${playerName}: Choose which blockhead to teleport:\n${bhList}`)

    pendingSelections.set(playerName.toLowerCase(), {
      command,
      blockheads: blockheads.map(bh => ({ id: bh.blockheadId, name: bh.name })),
      playerName,
      playerUuid,
      timestamp: Date.now(),
      ...extraData,
    })

    return 'prompted'
  }

  // Shared teleport execution
  const executeTeleport = async (
    playerName: string,
    blockheadId: number,
    x: number,
    y: number,
    playerUuid: string,
    logPrefix: string
  ): Promise<{ ok: boolean, error?: string }> => {
    sendPrivateMessage(playerName, `${playerName}: Teleporting! Reconnect in 3 seconds.`)
    ex.bot.send(`/kick ${playerName}`)
    await new Promise(resolve => setTimeout(resolve, 200))

    const teleportResult = await enqueueShared(async () => {
      return await BlockheadService.teleportBlockhead(blockheadId, x, y, playerUuid)
    })

    if (!teleportResult.ok) {
      console.warn(`[${logPrefix}] Teleport write failed for ${playerName}: ${teleportResult.error}`)
    } else {
      console.log(`[${logPrefix}] ${playerName} teleported to (${x}, ${y})`)
    }

    return teleportResult
  }

  // -------------------------------------------------------------------------
  // /wild command - teleport to random wilderness location
  // -------------------------------------------------------------------------
  const wildCooldowns = new Map<string, number>() // playerName -> timestamp
  const WILD_COOLDOWN_MS = cfg.economy.wildCooldownMs
  const WILD_COST = cfg.economy.wildCost

  const findWildLocation = (): Promise<{ success: boolean, x?: number, y?: number, error?: string }> => {
    return BlockheadService.findWildLocation(cfg)
  }

  const executeWild = async (playerName: string, blockheadId: number, playerUuid: string, wildResult: { x: number, y: number }) => {
    const bankAPI = getBankAPI()
    if (!bankAPI || !bankAPI.removeCoins(playerName, WILD_COST, `/wild teleport to (${wildResult.x}, ${wildResult.y})`)) {
      sendPrivateMessage(playerName, `${playerName}: Failed to deduct tokens. Please try again.`)
      return
    }

    wildCooldowns.set(playerName, Date.now())

    const result = await executeTeleport(playerName, blockheadId, wildResult.x, wildResult.y, playerUuid, '/wild')
    if (!result.ok) {
      bankAPI.addCoins(playerName, WILD_COST, `/wild refund - teleport failed`)
      wildCooldowns.delete(playerName)
    }
  }

  ex.world.onMessage.sub(async ({ player, message }) => {
    if (message !== '/wild') return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: /wild temporarily disabled - bot restarting soon.`)
      return
    }

    const playerName = player.name

    // Check cooldown
    const lastUse = wildCooldowns.get(playerName) ?? 0
    const now = Date.now()
    if (now - lastUse < WILD_COOLDOWN_MS) {
      const remainingMs = WILD_COOLDOWN_MS - (now - lastUse)
      const remainingMins = Math.ceil(remainingMs / 60000)
      sendPrivateMessage(playerName, `${playerName}: /wild is on cooldown. ${remainingMins} minutes remaining.`)
      return
    }

    // Check balance
    const bankAPI = getBankAPI()
    if (!bankAPI || typeof bankAPI.hasCoins !== 'function' || typeof bankAPI.removeCoins !== 'function') {
      sendPrivateMessage(playerName, `${playerName}: Banking system unavailable.`)
      return
    }

    if (!bankAPI.hasCoins(playerName, WILD_COST)) {
      const balance = typeof bankAPI.getBalance === 'function' ? bankAPI.getBalance(playerName) : null
      const balanceStr = balance !== null ? ` (balance: ${balance})` : ''
      sendPrivateMessage(playerName, `${playerName}: Not enough tokens. /wild costs ${WILD_COST} tokens${balanceStr}`)
      return
    }

    // Get player UUID
    const activityAPI = getActivityMonitorAPI()
    const playerUuid = activityAPI?.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    // Find wild location first
    sendPrivateMessage(playerName, `${playerName}: Finding a wild location...`)
    try {
      const wildResult = await findWildLocation()
      if (!wildResult.success || wildResult.x === undefined || wildResult.y === undefined) {
        sendPrivateMessage(playerName, `${playerName}: Could not find a wild location. ${wildResult.error ?? 'Try again later.'}`)
        return
      }

      // Get blockheads — prompt if multiple
      const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'wild', {
        wildResult: { x: wildResult.x, y: wildResult.y },
      })

      if (result === null) return // error already sent
      if (result === 'prompted') return // waiting for /1, /2, etc.

      // Single blockhead — execute immediately
      await executeWild(playerName, result.blockheadId, playerUuid, { x: wildResult.x, y: wildResult.y })
    } catch (err) {
      console.error(`[/wild] Error:`, err)
      sendPrivateMessage(playerName, `${playerName}: An error occurred. Please try again.`)
    }
  })

  // -------------------------------------------------------------------------
  // /tpa command - request to teleport to another player
  // -------------------------------------------------------------------------
  interface TpaRequest {
    fromPlayer: string
    fromBlockheadId: number
    fromUuid: string
    timestamp: number
  }
  const tpaRequests = new Map<string, TpaRequest>() // targetPlayer -> request
  const tpaCooldowns = new Map<string, number>() // playerName -> timestamp
  const TPA_COOLDOWN_MS = cfg.economy.tpaCooldownMs
  const TPA_COST = cfg.economy.tpaCost
  const TPA_EXPIRE_MS = cfg.economy.tpaExpireMs

  // Clean up expired TPA requests and pending selections
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [target, request] of tpaRequests.entries()) {
      if (now - request.timestamp > TPA_EXPIRE_MS) {
        tpaRequests.delete(target)
      }
    }
    for (const [player, selection] of pendingSelections.entries()) {
      if (now - selection.timestamp > SELECTION_EXPIRE_MS) {
        pendingSelections.delete(player)
      }
    }
  }, 30000)

  ex.world.onMessage.sub(async ({ player, message }) => {
    if (!message.startsWith('/tpa ')) return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: /tpa temporarily disabled - bot restarting soon.`)
      return
    }

    const targetName = message.slice('/tpa '.length).trim()
    const playerName = player.name

    if (!targetName) {
      sendPrivateMessage(playerName, `${playerName}: Usage: /tpa <playername>`)
      return
    }

    if (targetName.toLowerCase() === playerName.toLowerCase()) {
      sendPrivateMessage(playerName, `${playerName}: You can't teleport to yourself.`)
      return
    }

    // Check cooldown
    const lastUse = tpaCooldowns.get(playerName) ?? 0
    const now = Date.now()
    if (now - lastUse < TPA_COOLDOWN_MS) {
      const remainingMs = TPA_COOLDOWN_MS - (now - lastUse)
      const remainingSecs = Math.ceil(remainingMs / 1000)
      sendPrivateMessage(playerName, `${playerName}: /tpa is on cooldown. ${remainingSecs} seconds remaining.`)
      return
    }

    // Check if target is online
    const targetPlayer = ex.world.getPlayer(targetName)
    if (!targetPlayer) {
      sendPrivateMessage(playerName, `${playerName}: Player "${targetName}" is not online.`)
      return
    }

    const actualTargetName = targetPlayer.name

    // Check balance
    const bankAPI = getBankAPI()
    if (!bankAPI) {
      sendPrivateMessage(playerName, `${playerName}: Bank system unavailable.`)
      return
    }

    if (!bankAPI.hasCoins(playerName, TPA_COST)) {
      const balance = typeof bankAPI.getBalance === 'function' ? bankAPI.getBalance(playerName) : null
      const balanceStr = balance !== null ? ` (balance: ${balance})` : ''
      sendPrivateMessage(playerName, `${playerName}: Not enough tokens. /tpa costs ${TPA_COST} tokens${balanceStr}`)
      return
    }

    // Get player UUID
    const activityAPI = getActivityMonitorAPI()
    if (!activityAPI) {
      sendPrivateMessage(playerName, `${playerName}: Activity monitor unavailable.`)
      return
    }

    const playerUuid = activityAPI.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    // Check if target already has a pending request
    const existingRequest = tpaRequests.get(actualTargetName.toLowerCase())
    if (existingRequest && Date.now() - existingRequest.timestamp < TPA_EXPIRE_MS) {
      sendPrivateMessage(playerName, `${playerName}: ${actualTargetName} already has a pending teleport request.`)
      return
    }

    // Get blockheads — prompt if multiple
    const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'tpa', {
      tpaRequest: {
        fromPlayer: playerName,
        fromBlockheadId: 0, // filled in after selection
        fromUuid: playerUuid,
        timestamp: now,
      },
    })

    if (result === null) return
    if (result === 'prompted') {
      // Store target info in the pending selection so we can complete the tpa after selection
      const pending = pendingSelections.get(playerName.toLowerCase())
      if (pending && pending.tpaRequest) {
        ;(pending as any).tpaTargetName = actualTargetName
      }
      return
    }

    // Single blockhead — store tpa request immediately
    tpaRequests.set(actualTargetName.toLowerCase(), {
      fromPlayer: playerName,
      fromBlockheadId: result.blockheadId,
      fromUuid: playerUuid,
      timestamp: now,
    })

    sendPrivateMessage(playerName, `${playerName}: Teleport request sent to ${actualTargetName}. Expires in 60 seconds.`)
    sendPrivateMessage(actualTargetName, `${actualTargetName}: ${playerName} wants to teleport to you. Type /tpaccept ${playerName} or /tpdeny ${playerName} (expires in 60s)`)
    console.log(`[/tpa] ${playerName} requested to teleport to ${actualTargetName}`)
  })

  // -------------------------------------------------------------------------
  // /tpaccept command
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (!message.startsWith('/tpaccept ')) return

    const fromName = message.slice('/tpaccept '.length).trim()
    const targetName = player.name

    if (!fromName) {
      sendPrivateMessage(targetName, `${targetName}: Usage: /tpaccept <playername>`)
      return
    }

    const request = tpaRequests.get(targetName.toLowerCase())
    if (!request || request.fromPlayer.toLowerCase() !== fromName.toLowerCase()) {
      sendPrivateMessage(targetName, `${targetName}: No pending teleport request from ${fromName}.`)
      return
    }

    if (Date.now() - request.timestamp > TPA_EXPIRE_MS) {
      tpaRequests.delete(targetName.toLowerCase())
      sendPrivateMessage(targetName, `${targetName}: That teleport request has expired.`)
      sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Your teleport request to ${targetName} has expired.`)
      return
    }

    // Remove the request
    tpaRequests.delete(targetName.toLowerCase())

    const bankAPI = getBankAPI()
    const activityAPI = getActivityMonitorAPI()

    if (!bankAPI || !activityAPI) {
      sendPrivateMessage(targetName, `${targetName}: System unavailable. Please try again.`)
      sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Teleport failed - system unavailable. Please try again.`)
      return
    }

    // Deduct tokens from the requesting player
    if (!bankAPI.removeCoins(request.fromPlayer, TPA_COST, `/tpa to ${targetName}`)) {
      sendPrivateMessage(targetName, `${targetName}: ${request.fromPlayer} doesn't have enough tokens.`)
      sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Teleport failed - not enough tokens.`)
      return
    }

    // Set cooldown for the requesting player
    tpaCooldowns.set(request.fromPlayer, Date.now())

    // Get target's blockhead position
    const targetBlockheadId = activityAPI.getMostRecentBlockheadId?.(targetName)
    const targetUuid = activityAPI.getPlayerUuid?.(targetName)

    if (!targetBlockheadId || !targetUuid) {
      bankAPI.addCoins(request.fromPlayer, TPA_COST, `/tpa refund - target blockhead not found`)
      tpaCooldowns.delete(request.fromPlayer)
      sendPrivateMessage(targetName, `${targetName}: Could not find your blockhead location.`)
      sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Teleport failed. Tokens refunded.`)
      return
    }

    sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: ${targetName} accepted your teleport request. Teleporting...`)
    sendPrivateMessage(targetName, `${targetName}: Accepted teleport request from ${request.fromPlayer}.`)

    try {
      // Get target's current position
      const targetPos = await BlockheadService.getBlockheadPosition(targetBlockheadId, targetUuid)
      if (!targetPos.ok || targetPos.x === undefined || targetPos.y === undefined) {
        bankAPI.addCoins(request.fromPlayer, TPA_COST, `/tpa refund - could not get target position`)
        tpaCooldowns.delete(request.fromPlayer)
        sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Teleport failed - could not get target position. Tokens refunded.`)
        sendPrivateMessage(targetName, `${targetName}: Teleport failed - could not determine your position.`)
        return
      }

      const result = await executeTeleport(request.fromPlayer, request.fromBlockheadId, targetPos.x, targetPos.y, request.fromUuid, '/tpa')
      if (!result.ok) {
        bankAPI.addCoins(request.fromPlayer, TPA_COST, `/tpa refund - teleport failed`)
        tpaCooldowns.delete(request.fromPlayer)
        sendPrivateMessage(targetName, `${targetName}: Teleport of ${request.fromPlayer} to you failed.`)
      }
    } catch (err) {
      console.error(`[/tpa] Error:`, err)
      bankAPI.addCoins(request.fromPlayer, TPA_COST, `/tpa refund - error`)
      tpaCooldowns.delete(request.fromPlayer)
      sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: Teleport failed due to an error. Tokens refunded.`)
      sendPrivateMessage(targetName, `${targetName}: Teleport of ${request.fromPlayer} to you failed due to an error.`)
    }
  })

  // -------------------------------------------------------------------------
  // /tpdeny command
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(({ player, message }) => {
    if (!message.startsWith('/tpdeny ')) return

    const fromName = message.slice('/tpdeny '.length).trim()
    const targetName = player.name

    if (!fromName) {
      sendPrivateMessage(targetName, `${targetName}: Usage: /tpdeny <playername>`)
      return
    }

    const request = tpaRequests.get(targetName.toLowerCase())
    if (!request || request.fromPlayer.toLowerCase() !== fromName.toLowerCase()) {
      sendPrivateMessage(targetName, `${targetName}: No pending teleport request from ${fromName}.`)
      return
    }

    tpaRequests.delete(targetName.toLowerCase())
    sendPrivateMessage(targetName, `${targetName}: Denied teleport request from ${request.fromPlayer}.`)
    sendPrivateMessage(request.fromPlayer, `${request.fromPlayer}: ${targetName} denied your teleport request.`)
    console.log(`[/tpa] ${targetName} denied teleport request from ${request.fromPlayer}`)
  })

  // -------------------------------------------------------------------------
  // /spawn command - teleport to spawn
  // -------------------------------------------------------------------------
  const SPAWN_X = cfg.game.spawn.x
  const SPAWN_Y = cfg.game.spawn.y

  ex.world.onMessage.sub(async ({ player, message }) => {
    if (message !== '/spawn') return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: /spawn temporarily disabled - bot restarting soon.`)
      return
    }

    const playerName = player.name
    const activityAPI = getActivityMonitorAPI()

    if (!activityAPI) {
      sendPrivateMessage(playerName, `${playerName}: Activity monitor unavailable.`)
      return
    }

    const playerUuid = activityAPI.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'spawn', {
      tpCoords: { x: SPAWN_X, y: SPAWN_Y },
    })

    if (result === null) return
    if (result === 'prompted') return

    await executeTeleport(playerName, result.blockheadId, SPAWN_X, SPAWN_Y, playerUuid, '/spawn')
  })

  // -------------------------------------------------------------------------
  // /sethome command - save current location as home
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (message !== '/sethome') return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: /sethome temporarily disabled - bot restarting soon.`)
      return
    }

    const playerName = player.name
    const activityAPI = getActivityMonitorAPI()

    const playerUuid = activityAPI?.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'sethome')
    if (result === null) return
    if (result === 'prompted') return

    const pos = await BlockheadService.getBlockheadPosition(result.blockheadId, playerUuid)
    if (!pos.ok || pos.x === undefined || pos.y === undefined) {
      sendPrivateMessage(playerName, `${playerName}: Could not read your current position. Try moving first.`)
      return
    }

    homeLocations.set(playerName, { x: pos.x, y: pos.y })
    saveHomes()
    sendPrivateMessage(playerName, `${playerName}: Home set at (${pos.x}, ${pos.y}).`)
    console.log(`[/sethome] ${playerName} set home at (${pos.x}, ${pos.y})`)
  })

  // -------------------------------------------------------------------------
  // /home and /delhome commands
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (message !== '/home' && message !== '/delhome') return

    const playerName = player.name

    if (message === '/delhome') {
      if (!homeLocations.has(playerName)) {
        sendPrivateMessage(playerName, `${playerName}: You don't have a home set.`)
        return
      }
      homeLocations.delete(playerName)
      saveHomes()
      sendPrivateMessage(playerName, `${playerName}: Home deleted.`)
      console.log(`[/delhome] ${playerName} deleted their home`)
      return
    }

    if (isShuttingDown()) {
      sendPrivateMessage(playerName, `${playerName}: /home temporarily disabled - bot restarting soon.`)
      return
    }

    const home = homeLocations.get(playerName)

    if (!home) {
      sendPrivateMessage(playerName, `${playerName}: You don't have a home set. Use /sethome to set one.`)
      return
    }

    const activityAPI = getActivityMonitorAPI()
    const playerUuid = activityAPI?.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'home', {
      tpCoords: { x: home.x, y: home.y },
    })

    if (result === null) return
    if (result === 'prompted') return

    await executeTeleport(playerName, result.blockheadId, home.x, home.y, playerUuid, '/home')
  })

  // -------------------------------------------------------------------------
  // /tp command - admin teleport to coordinates
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (!message.startsWith('/tp ')) return

    if (!isAdminHelper(player.name)) {
      sendPrivateMessage(player.name, `${player.name}: You don't have permission to use /tp.`)
      return
    }

    const args = message.slice('/tp '.length).trim().split(/\s+/)
    if (args.length !== 2) {
      sendPrivateMessage(player.name, `${player.name}: Usage: /tp <x> <y>`)
      return
    }

    const x = parseInt(args[0], 10)
    const y = parseInt(args[1], 10)

    if (isNaN(x) || isNaN(y)) {
      sendPrivateMessage(player.name, `${player.name}: Invalid coordinates. Usage: /tp <x> <y>`)
      return
    }

    const playerName = player.name
    const activityAPI = getActivityMonitorAPI()

    if (!activityAPI) {
      sendPrivateMessage(playerName, `${playerName}: Activity monitor unavailable.`)
      return
    }

    const playerUuid = activityAPI.getPlayerUuid?.(playerName)
    if (!playerUuid) {
      sendPrivateMessage(playerName, `${playerName}: Could not find your UUID. Please rejoin the server.`)
      return
    }

    // Get blockheads — prompt if multiple
    const result = await getBlockheadsOrPrompt(playerName, playerUuid, 'tp', {
      tpCoords: { x, y },
    })

    if (result === null) return
    if (result === 'prompted') {
      sendPrivateMessage(playerName, `${playerName}: Select a blockhead to teleport to (${x}, ${y}).`)
      return
    }

    // Single blockhead — execute immediately
    await executeTeleport(playerName, result.blockheadId, x, y, playerUuid, '/tp')
  })

  // -------------------------------------------------------------------------
  // /1 - /5 blockhead selection handler
  // -------------------------------------------------------------------------
  ex.world.onMessage.sub(async ({ player, message }) => {
    const match = message.match(/^\/([1-5])$/)
    if (!match) return

    const index = parseInt(match[1], 10) - 1 // 0-based
    const playerName = player.name
    const pending = pendingSelections.get(playerName.toLowerCase())

    if (!pending) return // no pending selection — silently ignore

    // Check expiry
    if (Date.now() - pending.timestamp > SELECTION_EXPIRE_MS) {
      pendingSelections.delete(playerName.toLowerCase())
      sendPrivateMessage(playerName, `${playerName}: Selection expired. Please run the command again.`)
      return
    }

    // Validate index
    if (index >= pending.blockheads.length) {
      sendPrivateMessage(playerName, `${playerName}: Invalid selection. Choose /1 through /${pending.blockheads.length}.`)
      return
    }

    const selected = pending.blockheads[index]
    pendingSelections.delete(playerName.toLowerCase())

    console.log(`[teleport] ${playerName} selected blockhead ${selected.name} (${selected.id}) for /${pending.command}`)

    try {
      if (pending.command === 'wild' && pending.wildResult) {
        await executeWild(playerName, selected.id, pending.playerUuid, pending.wildResult)

      } else if (pending.command === 'spawn' && pending.tpCoords) {
        await executeTeleport(playerName, selected.id, pending.tpCoords.x, pending.tpCoords.y, pending.playerUuid, '/spawn')

      } else if (pending.command === 'tp' && pending.tpCoords) {
        await executeTeleport(playerName, selected.id, pending.tpCoords.x, pending.tpCoords.y, pending.playerUuid, '/tp')

      } else if (pending.command === 'home' && pending.tpCoords) {
        await executeTeleport(playerName, selected.id, pending.tpCoords.x, pending.tpCoords.y, pending.playerUuid, '/home')

      } else if (pending.command === 'sethome') {
        const pos = await BlockheadService.getBlockheadPosition(selected.id, pending.playerUuid)
        if (!pos.ok || pos.x === undefined || pos.y === undefined) {
          sendPrivateMessage(playerName, `${playerName}: Could not read your current position. Try moving first.`)
          return
        }
        homeLocations.set(playerName, { x: pos.x, y: pos.y })
        saveHomes()
        sendPrivateMessage(playerName, `${playerName}: Home set at (${pos.x}, ${pos.y}).`)
        console.log(`[/sethome] ${playerName} set home at (${pos.x}, ${pos.y}) via blockhead ${selected.name}`)

      } else if (pending.command === 'tpa' && pending.tpaRequest) {
        const tpaTargetName = (pending as any).tpaTargetName as string
        if (!tpaTargetName) {
          sendPrivateMessage(playerName, `${playerName}: TPA error - target not found.`)
          return
        }

        // Now store the actual tpa request with the selected blockhead
        tpaRequests.set(tpaTargetName.toLowerCase(), {
          fromPlayer: playerName,
          fromBlockheadId: selected.id,
          fromUuid: pending.playerUuid,
          timestamp: Date.now(),
        })

        sendPrivateMessage(playerName, `${playerName}: Teleport request sent to ${tpaTargetName}. Expires in 60 seconds.`)
        sendPrivateMessage(tpaTargetName, `${tpaTargetName}: ${playerName} wants to teleport to you. Type /tpaccept ${playerName} or /tpdeny ${playerName} (expires in 60s)`)
        console.log(`[/tpa] ${playerName} requested to teleport to ${tpaTargetName} (blockhead: ${selected.name})`)
      }
    } catch (err) {
      console.error(`[teleport] Error executing selection for ${playerName}:`, err)
      sendPrivateMessage(playerName, `${playerName}: An error occurred. Please try again.`)
    }
  })

  ex.remove = () => {
    clearInterval(cleanupTimer)
    console.log('Teleport System stopped')
  }
  })
  return 'teleport-system'
}
TeleportSystem.extensionName = 'teleport-system'
TeleportSystem.requires = ['virtual-bank', 'activity-monitor']
