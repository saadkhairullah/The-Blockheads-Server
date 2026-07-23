/**
 * Buff Shop — purchasable persistent defense and strength upgrades.
 *
 * Defense: 200 tokens/point, max 99%, displayed with /defenses
 * Strength: 100 tokens/upgrade (+0.05x each), max 5x (80 upgrades), displayed with /strengths
 *
 * Buffs persist across server restarts (stored in data/player-buffs.json)
 * and are reapplied automatically on player join.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { BotContext, ExtensionFactory } from '../bot-context'
import type { AppConfig } from '../config'
import { sendPrivateMessage } from '../private-message'
import { playerManager } from '../player-manager'

const MessageBot = require('@bhmb/bot').MessageBot

const DEFENSE_COST = 200        // tokens per 1% defense
const DEFENSE_MAX = 99          // max defense %
const STRENGTH_COST = 100       // tokens per upgrade
const STRENGTH_PER_UPGRADE = 0.05  // multiplier increase per upgrade
const STRENGTH_MAX_UPGRADES = 80   // 1 + 80 * 0.05 = 5.0x max

interface PlayerBuffs {
  defense: number   // 0–99 (%)
  strength: number  // 0–80 (upgrades)
}

type BuffStore = Record<string, PlayerBuffs>

function loadBuffs(filePath: string): BuffStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveBuffs(filePath: string, store: BuffStore): void {
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2))
}

function getPlayerBuffs(store: BuffStore, playerName: string): PlayerBuffs {
  return store[playerName] ?? { defense: 0, strength: 0 }
}

function applyBuffs(inputPipe: string, playerName: string, buffs: PlayerBuffs): void {
  if (buffs.defense > 0) {
    fs.appendFileSync(inputPipe, `/defense ${playerName} ${buffs.defense}\n`)
  }
  if (buffs.strength > 0) {
    const mult = (1 + buffs.strength * STRENGTH_PER_UPGRADE).toFixed(2)
    fs.appendFileSync(inputPipe, `/buff ${playerName} ${mult}\n`)
  }
}

export const BuffShop: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('buff-shop', (ex: any) => {
    const buffsPath = path.join(cfg.paths.dataDir, 'player-buffs.json')

    // Track recent joins to avoid double-applying with PLAYER_MOVE handler
    const recentJoinNames = new Map<string, number>()

    // Reapply buffs on join — single attempt after 5s (blockhead loads within this window)
    ex.world.onJoin.sub((player: any) => {
      const playerName: string = player.name
      recentJoinNames.set(playerName, Date.now())
      setTimeout(() => {
        try {
          const store = loadBuffs(buffsPath)
          const buffs = getPlayerBuffs(store, playerName)
          if (buffs.defense > 0 || buffs.strength > 0) {
            applyBuffs(cfg.paths.inputPipe, playerName, buffs)
          }
        } catch (err) {
          console.error('[BuffShop] Error reapplying buffs on join:', err)
        }
      }, 5000)
    })

    // Apply buffs when a new blockhead ID is first seen (new slot created while already online)
    const { eventDispatcher } = require('../event-dispatcher')
    const seenBlockheadIds = new Set<number>()

    eventDispatcher.subscribe('PLAYER_MOVE', (event: any) => {
      const bhId: number = event.blockheadId
      if (!bhId || seenBlockheadIds.has(bhId)) return
      seenBlockheadIds.add(bhId)

      const player = playerManager.getByBlockheadId(bhId)
      if (!player) return

      // Skip if join handler already fired recently — it handles the reapply
      const joinTime = recentJoinNames.get(player.name)
      if (joinTime && Date.now() - joinTime < 15000) return

      setTimeout(() => {
        try {
          const store = loadBuffs(buffsPath)
          const buffs = getPlayerBuffs(store, player.name)
          if (buffs.defense > 0 || buffs.strength > 0) {
            applyBuffs(cfg.paths.inputPipe, player.name, buffs)
          }
        } catch (err) {
          console.error('[BuffShop] Error applying buffs for new blockhead:', err)
        }
      }, 2000)
    })

    ex.world.onMessage.sub(({ player, message }: { player: any; message: string }) => {
      const lower = message.trim().toLowerCase()
      const playerName: string = player.name

      // --- /defenses ---
      if (lower === '/defenses') {
        const store = loadBuffs(buffsPath)
        const buffs = getPlayerBuffs(store, playerName)
        const remaining = DEFENSE_MAX - buffs.defense
        sendPrivateMessage(playerName,
          `Defense: ${buffs.defense}% (max ${DEFENSE_MAX}%) | ` +
          `${remaining > 0 ? `Next upgrade: ${DEFENSE_COST} tokens (+1%)` : 'MAXED OUT'}`)
        return
      }

      // --- /strengths ---
      if (lower === '/strengths') {
        const store = loadBuffs(buffsPath)
        const buffs = getPlayerBuffs(store, playerName)
        const mult = (1 + buffs.strength * STRENGTH_PER_UPGRADE).toFixed(2)
        const remaining = STRENGTH_MAX_UPGRADES - buffs.strength
        sendPrivateMessage(playerName,
          `Strength: ${mult}x attack (max 5.00x) | ` +
          `${remaining > 0 ? `Next upgrade: ${STRENGTH_COST} tokens (+${STRENGTH_PER_UPGRADE}x)` : 'MAXED OUT'}`)
        return
      }

      // --- /buydefense ---
      if (lower === '/buydefense') {
        const store = loadBuffs(buffsPath)
        const buffs = getPlayerBuffs(store, playerName)

        if (buffs.defense >= DEFENSE_MAX) {
          sendPrivateMessage(playerName, `Defense is already maxed at ${DEFENSE_MAX}%.`)
          return
        }

        const bankAPI = require('./helpers/extension-api').getBankAPI(ex.bot)
        if (!bankAPI) {
          sendPrivateMessage(playerName, 'Economy unavailable. Try again.')
          return
        }
        if (!bankAPI.hasCoins(playerName, DEFENSE_COST)) {
          sendPrivateMessage(playerName, `You need ${DEFENSE_COST} tokens for +1% defense (you have ${bankAPI.getBalance(playerName)}).`)
          return
        }

        bankAPI.removeCoins(playerName, DEFENSE_COST, 'Defense upgrade')
        buffs.defense++
        store[playerName] = buffs
        saveBuffs(buffsPath, store)

        // Apply immediately
        try {
          fs.appendFileSync(cfg.paths.inputPipe, `/defense ${playerName} ${buffs.defense}\n`)
        } catch (err) {
          console.error('[BuffShop] Pipe error applying defense:', err)
        }

        sendPrivateMessage(playerName,
          `Defense upgraded to ${buffs.defense}% (${DEFENSE_MAX - buffs.defense} upgrades remaining).`)
        return
      }

      // --- /buystrength ---
      if (lower === '/buystrength') {
        const store = loadBuffs(buffsPath)
        const buffs = getPlayerBuffs(store, playerName)

        if (buffs.strength >= STRENGTH_MAX_UPGRADES) {
          sendPrivateMessage(playerName, 'Strength is already maxed at 5.00x.')
          return
        }

        const bankAPI = require('./helpers/extension-api').getBankAPI(ex.bot)
        if (!bankAPI) {
          sendPrivateMessage(playerName, 'Economy unavailable. Try again.')
          return
        }
        if (!bankAPI.hasCoins(playerName, STRENGTH_COST)) {
          sendPrivateMessage(playerName, `You need ${STRENGTH_COST} tokens for +${STRENGTH_PER_UPGRADE}x strength (you have ${bankAPI.getBalance(playerName)}).`)
          return
        }

        bankAPI.removeCoins(playerName, STRENGTH_COST, 'Strength upgrade')
        buffs.strength++
        store[playerName] = buffs
        saveBuffs(buffsPath, store)

        const mult = (1 + buffs.strength * STRENGTH_PER_UPGRADE).toFixed(2)
        try {
          fs.appendFileSync(cfg.paths.inputPipe, `/buff ${playerName} ${mult}\n`)
        } catch (err) {
          console.error('[BuffShop] Pipe error applying strength:', err)
        }

        sendPrivateMessage(playerName,
          `Strength upgraded to ${mult}x (${STRENGTH_MAX_UPGRADES - buffs.strength} upgrades remaining).`)
        return
      }
    })
  })

  return 'buff-shop'
}

BuffShop.extensionName = 'buff-shop'
BuffShop.requires = [] as const
