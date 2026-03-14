import { MessageBot } from '@bhmb/bot'
import { join } from 'path'
import { appendFile } from 'fs/promises'
import type { AppConfig, ShopItemConfig } from '../../config'
import type { BotContext, ExtensionFactory } from '../../bot-context'
import { enqueueShared } from '../../shared-queue'
import * as BlockheadService from '../../blockhead-service'
import { sendPrivateMessage } from '../../private-message'
import { getBankAPI as _getBankAPI, getActivityMonitorAPI as _getActivityMonitorAPI } from '../helpers/extension-api'
import { isAdmin as isAdminHelper } from '../helpers/isAdmin'

type ShopItem = ShopItemConfig

const UNKNOWN_PRICE = 50
const UNKNOWN_IDS = [
  11900, 3245, 3203, 3202, 3201, 3200, 2170, 9, 3204, 810, 813, 514, 513,
  512, 256, 172, 171, 131, 129, 128, 125, 123, 118, 116, 114, 113, 108, 211,
  107, 226, 18, 10, 5, 2, 1027, 1035, 106, 45, 1041, 1040, 1039, 1047
]

export const ShopSystem: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  const SHOP_ITEMS: ShopItem[] = cfg.shop
  const unknownItems: ShopItem[] = UNKNOWN_IDS.map((id, i) => ({
    key: `unknown_${i}`, name: 'Unknown Item', itemId: id, price: UNKNOWN_PRICE, count: 1
  }))

  MessageBot.registerExtension('shop-system', (ex) => {
  console.log('Shop System extension loaded!')

  const shopLogPath = join(cfg.paths.dataDir, 'shop-purchases.jsonl')
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

  const findShopItem = (query: string | undefined): ShopItem | null => {
    if (!query) return null
    const normalized = query.trim().toLowerCase()
    const byKey = SHOP_ITEMS.find(item => item.key === normalized)
    if (byKey) return byKey
    const byName = SHOP_ITEMS.find(item => item.name.toLowerCase() === normalized)
    if (byName) return byName
    const numeric = Number(normalized)
    if (!Number.isNaN(numeric)) {
      const byId = SHOP_ITEMS.find(item => item.itemId === numeric)
      if (byId) return byId
    }
    return null
  }

  const formatShopList = () => {
    let output = 'Shop Items:\n'
    output += 'Use /buy <itemKey>\n'
    for (const item of SHOP_ITEMS) {
      output += `- Key: ${item.key} - ${item.price} Tokens, qty ${item.count}\n`
    }
    return output
  }

  const logShopPurchase = async (payload: Record<string, unknown>) => {
    const line = `${JSON.stringify(payload)}\n`
    try {
      await appendFile(shopLogPath, line, 'utf8')
    } catch (err) {
      console.error('[Shop System] Failed to write shop purchase log:', err)
    }
  }

  // Resolve blockhead ID using activity monitor — coords-based only, no LMDB fallback.
  // LMDB fallback is intentionally removed: it returns ids[0] which is often a dead/inactive
  // blockhead, causing items to be delivered to the wrong character.
  const resolveBlockheadId = (playerName: string): number | null => {
    const activityAPI = getActivityMonitorAPI()
    if (!activityAPI || typeof activityAPI.getMostRecentBlockheadId !== 'function') return null
    return activityAPI.getMostRecentBlockheadId(playerName)
  }

  // Shared bank check — returns bankAPI or null (sends error message on failure)
  const requireBank = (playerName: string, price: number, logContext?: Record<string, unknown>): ReturnType<typeof getBankAPI> | null => {
    const bankAPI = getBankAPI()
    if (!bankAPI || typeof bankAPI.removeCoins !== 'function') {
      sendPrivateMessage(playerName, 'Shop is unavailable (bank system not loaded).')
      if (logContext) logShopPurchase({ ...logContext, status: 'rejected', reason: 'bank_unavailable' })
      return null
    }
    if (!bankAPI.hasCoins(playerName, price)) {
      const balance = typeof bankAPI.getBalance === 'function' ? bankAPI.getBalance(playerName) : null
      const balanceText = typeof balance === 'number' ? ` You have ${balance} Tokens.` : ''
      sendPrivateMessage(playerName, `Insufficient tokens.${balanceText}`)
      if (logContext) logShopPurchase({ ...logContext, status: 'rejected', reason: 'insufficient_tokens', balance: typeof balance === 'number' ? balance : undefined })
      return null
    }
    return bankAPI
  }

  // /shop command
  ex.world.onMessage.sub(({ player, message }) => {
    if (message !== '/shop') return
    sendPrivateMessage(player.name, formatShopList())
  })

  // /unknown command — random unknown item for 50 tokens (LMDB delivery)
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (message !== '/unknown') return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: Shop is temporarily disabled - bot restarting soon.`)
      return
    }

    const picked = unknownItems[Math.floor(Math.random() * unknownItems.length)]
    const logCtx = { time: new Date().toISOString(), player: player.name, itemKey: picked.key, itemId: picked.itemId, count: picked.count, price: UNKNOWN_PRICE }

    const bankAPI = requireBank(player.name, UNKNOWN_PRICE, logCtx)
    if (!bankAPI) return

    const blockheadId = resolveBlockheadId(player.name)
    if (blockheadId === null) {
      sendPrivateMessage(player.name, `${player.name}: Cannot find your blockhead. Try moving around first.`)
      logShopPurchase({ ...logCtx, status: 'rejected', reason: 'no_blockhead' })
      return
    }

    if (!bankAPI.removeCoins(player.name, UNKNOWN_PRICE, `Unknown item purchase`)) {
      sendPrivateMessage(player.name, 'Insufficient tokens.')
      logShopPurchase({ ...logCtx, status: 'rejected', reason: 'insufficient_tokens_race' })
      return
    }

    const activityAPI = getActivityMonitorAPI()
    const playerUuid = activityAPI?.getPlayerUuid?.(player.name)

    sendPrivateMessage(player.name, `${player.name}: You received a mysterious item! Reconnect in 3 seconds.`)
    ex.bot.send(`/kick ${player.name}`)

    enqueueShared(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      const result = await BlockheadService.giveItem(blockheadId, picked.itemId, picked.count, playerUuid ?? undefined, true)

      if (!result.ok) {
        bankAPI.addCoins(player.name, UNKNOWN_PRICE, `Unknown item refund`)
        console.warn(`[Shop System] Unknown item giveItem failed for ${player.name}: ${result.error}`)
        logShopPurchase({ ...logCtx, status: 'failed', reason: 'give_failed', blockheadId })
        return
      }

      logShopPurchase({ ...logCtx, status: 'success', blockheadId, delivery: 'lmdb' })
    })
  })


  // /buy command
  ex.world.onMessage.sub(async ({ player, message }) => {
    if (!message.startsWith('/buy')) return

    if (isShuttingDown()) {
      sendPrivateMessage(player.name, `${player.name}: Shop is temporarily disabled - bot restarting soon.`)
      return
    }

    const parts = message.trim().split(/\s+/)
    if (parts.length < 2) {
      sendPrivateMessage(player.name, 'Usage: /buy <itemKey>')
      return
    }

    const item = findShopItem(parts[1])
    if (!item) {
      sendPrivateMessage(player.name, 'Unknown item. Use /shop to see available items.')
      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: parts[1],
        status: 'rejected',
        reason: 'unknown_item'
      })
      return
    }

    const bankAPI = getBankAPI()
    if (!bankAPI || typeof bankAPI.hasCoins !== 'function' || typeof bankAPI.removeCoins !== 'function' || typeof bankAPI.addCoins !== 'function') {
      sendPrivateMessage(player.name, 'Shop is unavailable (bank system not loaded).')
      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: item.key,
        itemId: item.itemId,
        count: item.count,
        price: item.price,
        status: 'rejected',
        reason: 'bank_unavailable'
      })
      return
    }

    const price = item.price
    if (!bankAPI.hasCoins(player.name, price)) {
      const balance = typeof bankAPI.getBalance === 'function' ? bankAPI.getBalance(player.name) : null
      const balanceText = typeof balance === 'number' ? ` You have ${balance} Tokens.` : ''
      sendPrivateMessage(player.name, `Insufficient tokens.${balanceText}`)
      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: item.key,
        itemId: item.itemId,
        count: item.count,
        price: item.price,
        status: 'rejected',
        reason: 'insufficient_tokens',
        balance: typeof balance === 'number' ? balance : undefined
      })
      return
    }

    const activityAPI = getActivityMonitorAPI()
    const needsPortalAllow = item.itemId === 1074

    if (!bankAPI.removeCoins(player.name, price, `Shop purchase: ${item.name}`)) {
      sendPrivateMessage(player.name, 'Insufficient tokens.')
      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: item.key,
        itemId: item.itemId,
        count: item.count,
        price: item.price,
        status: 'rejected',
        reason: 'insufficient_tokens_race'
      })
      return
    }

    if (needsPortalAllow && activityAPI && typeof activityAPI.addAdminAllowlist === 'function') {
      activityAPI.addAdminAllowlist(player.name)
    }

    const requiresResync = item.key === 'infinite_food' || item.key === 'infinite_coffee' 
    const useBasket = requiresResync || item.preferBasket
    const deliveryMode = useBasket ? 'basket' : 'direct'
    const useServerGive = !requiresResync
    let blockheadId: number | null = null

    if (!useServerGive) {
      blockheadId = await resolveBlockheadId(player.name)
      if (blockheadId === null) {
        bankAPI.addCoins(player.name, price, `Shop refund: ${item.name}`)
        if (needsPortalAllow && activityAPI && typeof activityAPI.removeAdminAllowlist === 'function') {
          activityAPI.removeAdminAllowlist(player.name)
        }
        sendPrivateMessage(player.name, `${player.name}: Cannot find your blockhead. Try moving around first.`)
        logShopPurchase({
          time: new Date().toISOString(),
          player: player.name,
          itemKey: item.key,
          itemId: item.itemId,
          count: item.count,
          price: item.price,
          status: 'rejected',
          reason: 'no_blockhead'
        })
        return
      }
    } else {
      // For server /give items, blockheadId is only used in logs
      const actAPI = getActivityMonitorAPI()
      blockheadId = actAPI && typeof actAPI.getMostRecentBlockheadId === 'function'
        ? actAPI.getMostRecentBlockheadId(player.name)
        : null
    }

    if (useServerGive) {
      const cmd = blockheadId !== null
        ? `/give-id ${blockheadId} ${item.itemId} ${item.count}`
        : `/give ${player.name} ${item.itemId} ${item.count}`
      ex.bot.send(cmd)
      sendPrivateMessage(player.name, `${player.name}: Purchased ${item.name} for ${price} Tokens. Delivery sent.`)
      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: item.key,
        itemId: item.itemId,
        count: item.count,
        price: item.price,
        status: 'success',
        blockheadId,
        delivery: 'server_give'
      })
      return
    }

    const resolvedBlockheadId = blockheadId as number
    const playerUuid = activityAPI && typeof activityAPI.getPlayerUuid === 'function'
      ? activityAPI.getPlayerUuid(player.name)
      : undefined

    enqueueShared(async () => {
      // Kick first — clears game server's RAM cache so LMDB write takes effect on reconnect
      ex.bot.send(`/kick ${player.name}`)

      // Targeted LMDB write — always reads fresh from disk, no reload or forceSave needed
      const result = await BlockheadService.giveItem(resolvedBlockheadId, item.itemId, item.count, playerUuid ?? undefined, item.preferBasket === true)

      if (!result.ok) {
        bankAPI.addCoins(player.name, price, `Shop refund: ${item.name}`)
        if (needsPortalAllow && activityAPI && typeof activityAPI.removeAdminAllowlist === 'function') {
          activityAPI.removeAdminAllowlist(player.name)
        }
        console.warn(`[Shop System] giveItem failed for ${player.name}: ${result.error}`)
        logShopPurchase({
          time: new Date().toISOString(),
          player: player.name,
          itemKey: item.key,
          itemId: item.itemId,
          count: item.count,
          price: item.price,
          status: 'failed',
          reason: 'give_failed',
          blockheadId: resolvedBlockheadId,
          delivery: deliveryMode
        })
        return
      }

      logShopPurchase({
        time: new Date().toISOString(),
        player: player.name,
        itemKey: item.key,
        itemId: item.itemId,
        count: item.count,
        price: item.price,
        status: 'success',
        blockheadId: resolvedBlockheadId,
        delivery: deliveryMode
      })
    })
  })

  // /give <player> <itemId> <count> — admin in-game give command
  // Proxy drops this command (doesn't forward to server), bot handles it here.
  ex.world.onMessage.sub(({ player, message }) => {
    if (!message.startsWith('/give ')) return
    if (!isAdminHelper(player.name)) return

    const parts = message.trim().split(/\s+/)
    if (parts.length < 3) {
      sendPrivateMessage(player.name, 'Usage: /give <player> <itemId> [count]')
      return
    }

    const targetName = parts[1]
    const itemId = parseInt(parts[2], 10)
    const count = parts[3] ? parseInt(parts[3], 10) : 1

    if (isNaN(itemId) || itemId <= 0) {
      sendPrivateMessage(player.name, `Invalid item ID: ${parts[2]}`)
      return
    }

    const actAPI = getActivityMonitorAPI()
    const blockheadId = actAPI && typeof actAPI.getMostRecentBlockheadId === 'function'
      ? actAPI.getMostRecentBlockheadId(targetName)
      : null

    if (blockheadId !== null) {
      ex.bot.send(`/give-id ${blockheadId} ${itemId} ${Math.min(count, 999)}`)
      sendPrivateMessage(player.name, `Gave ${count}x item ${itemId} to ${targetName}`)
    } else {
      ex.bot.send(`/give ${targetName} ${itemId} ${Math.min(count, 999)}`)
      sendPrivateMessage(player.name, `Gave ${count}x item ${itemId} to ${targetName} (fallback)`)
    }
  })

  const { registerCategory } = require('./helpers/command-registry')
  registerCategory('shop', {
    name: 'Shop',
    player: [
      { cmd: '/shop', desc: 'View available items for purchase' },
      { cmd: '/buy <item>', desc: 'Purchase an item from the shop' },
      { cmd: '/unknown', desc: 'Buy a random mystery item (50 tokens)' },
    ],
  })

  ex.remove = () => {
    console.log('Shop System stopped')
  }
  })
  return 'shop-system'
}
ShopSystem.extensionName = 'shop-system'
ShopSystem.requires = ['virtual-bank', 'activity-monitor']
