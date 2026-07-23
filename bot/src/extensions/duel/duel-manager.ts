/**
 * Duel Manager — bot-side orchestration for the C hook duel state machine.
 *
 * Watches server log for [DUEL:PREP] and [DUEL:END] protocol messages from
 * the C hooks. Handles LMDB inventory backup/restore, kit swap, player kicks,
 * token rewards, position restore, and stats tracking.
 *
 * Protocol:
 *   C: [DUEL:PREP] p1uid=X p2uid=Y p1name=NAME1 p2name=NAME2 p1x=X1 p1y=Y1 p2x=X2 p2y=Y2
 *   Bot: kick → backup inventory → clear + give kit → /duel-ready
 *
 *   C: [DUEL:END] winner=X loser=Y winnername=NAME1 losername=NAME2 p1x=X1 p1y=Y1 p2x=X2 p2y=Y2
 *   Bot: kick → restore inventory → teleport → award tokens → /duel-restored
 */

import type { BotContext, ExtensionFactory } from '../../bot-context'
import type { AppConfig } from '../../config'
import { getBankAPI, getActivityMonitorAPI } from '../helpers/extension-api'
import { sendPrivateMessage } from '../../private-message'
import { enqueueShared } from '../../shared-queue'
import {
  backupInventory,
  restoreInventory,
  getInventoryCounts,
  applyQuestItems,
  teleportBlockhead,
} from '../../blockhead-service'

const MessageBot = require('@bhmb/bot').MessageBot

interface DuelPrepData {
  p1uid: string
  p2uid: string
  p1name: string
  p2name: string
  p1x: number
  p1y: number
  p2x: number
  p2y: number
}

interface DuelEndData {
  winner: string
  loser: string
  winnername: string
  losername: string
  p1uid?: string
  p2uid?: string
  p1x: number
  p1y: number
  p2x: number
  p2y: number
}

interface DuelStats {
  wins: number
  losses: number
  draws: number
}

function parseKeyValue(msg: string): Record<string, string> {
  const result: Record<string, string> = {}
  const pairs = msg.match(/(\w+)=(\S+)/g)
  if (pairs) {
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      result[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }
  return result
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const DuelManager: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('duel-manager', (ex: any) => {
    const tokenReward = cfg.hooks.duel.tokenReward
    const kitItems = cfg.hooks.duel.kit

    ex.world.onMessage.sub(async ({ message }: { player: any; message: string }) => {
      if (!message.startsWith('[DUEL:')) return

      if (message.startsWith('[DUEL:PREP]')) {
        const kv = parseKeyValue(message)
        const data: DuelPrepData = {
          p1uid: kv.p1uid,
          p2uid: kv.p2uid,
          p1name: kv.p1name,
          p2name: kv.p2name,
          p1x: parseInt(kv.p1x) || 0,
          p1y: parseInt(kv.p1y) || 0,
          p2x: parseInt(kv.p2x) || 0,
          p2y: parseInt(kv.p2y) || 0,
        }
        console.log(`[DuelManager] PREP received: ${data.p1name} vs ${data.p2name}`)
        await handleDuelPrep(ex, cfg, data)
      } else if (message.startsWith('[DUEL:END]')) {
        const kv = parseKeyValue(message)
        const data: DuelEndData = {
          winner: kv.winner,
          loser: kv.loser,
          winnername: kv.winnername,
          losername: kv.losername,
          p1uid: kv.p1uid,
          p2uid: kv.p2uid,
          p1x: parseInt(kv.p1x) || 0,
          p1y: parseInt(kv.p1y) || 0,
          p2x: parseInt(kv.p2x) || 0,
          p2y: parseInt(kv.p2y) || 0,
        }
        console.log(`[DuelManager] END received: winner=${data.winnername} loser=${data.losername}`)
        await handleDuelEnd(ex, cfg, data)
      }
    })

    async function handleDuelPrep(ex: any, _cfg: AppConfig, data: DuelPrepData) {
      try {
        const activityAPI = getActivityMonitorAPI(ex.bot)
        if (!activityAPI) {
          console.error('[DuelManager] ActivityMonitor API not available')
          return
        }

        const p1uuid = activityAPI.getPlayerUuid(data.p1name)
        const p2uuid = activityAPI.getPlayerUuid(data.p2name)
        const p1bhId = activityAPI.getMostRecentBlockheadId(data.p1name)
        const p2bhId = activityAPI.getMostRecentBlockheadId(data.p2name)

        if (!p1uuid || !p2uuid || !p1bhId || !p2bhId) {
          console.error(`[DuelManager] Could not resolve players: p1uuid=${p1uuid} p2uuid=${p2uuid} p1bh=${p1bhId} p2bh=${p2bhId}`)
          return
        }

        // Kick both players to flush RAM to LMDB
        ex.bot.send(`/kick ${data.p1name}`)
        ex.bot.send(`/kick ${data.p2name}`)
        await delay(500)

        await enqueueShared(async () => {
          // Backup raw inventories (full fidelity)
          const p1backup = await backupInventory(p1bhId, p1uuid)
          const p2backup = await backupInventory(p2bhId, p2uuid)

          if (!p1backup || !p2backup) {
            console.error(`[DuelManager] Failed to backup inventories: p1=${!!p1backup} p2=${!!p2backup}`)
            return
          }

          // Save backups + original positions to storage
          ex.storage.set(`duel_inv_${data.p1uid}`, JSON.stringify({
            backup: p1backup,
            blockheadId: p1bhId,
            uuid: p1uuid,
            name: data.p1name,
            origX: data.p1x,
            origY: data.p1y,
          }))
          ex.storage.set(`duel_inv_${data.p2uid}`, JSON.stringify({
            backup: p2backup,
            blockheadId: p2bhId,
            uuid: p2uuid,
            name: data.p2name,
            origX: data.p2x,
            origY: data.p2y,
          }))

          console.log(`[DuelManager] Inventories backed up for ${data.p1name} and ${data.p2name}`)

          // Get current inventory counts to know what to remove
          const p1inv = await getInventoryCounts(p1bhId, p1uuid)
          const p2inv = await getInventoryCounts(p2bhId, p2uuid)

          // Clear inventories and give kit
          const p1Remove = p1inv ? Object.entries(p1inv).map(([id, count]) => ({ itemId: parseInt(id), count })) : []
          const p2Remove = p2inv ? Object.entries(p2inv).map(([id, count]) => ({ itemId: parseInt(id), count })) : []

          await applyQuestItems(p1bhId, p1Remove, kitItems, p1uuid)
          await applyQuestItems(p2bhId, p2Remove, kitItems, p2uuid)

          console.log(`[DuelManager] Kit applied. Sending duel-ready.`)

          // Signal C hooks that prep is done
          ex.bot.send(`/duel-ready ${data.p1uid} ${data.p2uid}`)
        })
      } catch (err) {
        console.error('[DuelManager] PREP handler error:', err)
      }
    }

    async function handleDuelEnd(ex: any, _cfg: AppConfig, data: DuelEndData) {
      try {
        const isDraw = data.winner === '0' && data.loser === '0'

        // Determine UIDs for both players
        let p1uid: string, p2uid: string
        if (isDraw) {
          p1uid = data.p1uid || ''
          p2uid = data.p2uid || ''
        } else {
          // winner/loser are UIDs — need to determine p1/p2 mapping from saved data
          p1uid = data.winner
          p2uid = data.loser
        }

        // Kick both players to flush state
        if (!isDraw) {
          ex.bot.send(`/kick ${data.winnername}`)
          ex.bot.send(`/kick ${data.losername}`)
        } else {
          // For draw, resolve names from saved data
          const saved1Raw = ex.storage.get(`duel_inv_${p1uid}`, '')
          const saved2Raw = ex.storage.get(`duel_inv_${p2uid}`, '')
          if (saved1Raw) {
            const saved1 = JSON.parse(saved1Raw)
            ex.bot.send(`/kick ${saved1.name}`)
          }
          if (saved2Raw) {
            const saved2 = JSON.parse(saved2Raw)
            ex.bot.send(`/kick ${saved2.name}`)
          }
        }
        await delay(500)

        await enqueueShared(async () => {
          // Restore both players from saved data
          // We need to check all saved duel data since UIDs could be winner or loser
          const uidsToRestore = isDraw ? [p1uid, p2uid] : [data.winner, data.loser]

          for (const uid of uidsToRestore) {
            if (!uid) continue
            const savedRaw = ex.storage.get(`duel_inv_${uid}`, '')
            if (!savedRaw) {
              console.error(`[DuelManager] No saved data for uid=${uid}`)
              continue
            }

            const saved = JSON.parse(savedRaw)

            // Restore raw inventory
            const restored = await restoreInventory(saved.blockheadId, saved.uuid, saved.backup)
            if (!restored) {
              console.error(`[DuelManager] Failed to restore inventory for ${saved.name}`)
            }

            // Teleport back to original position
            await teleportBlockhead(saved.blockheadId, saved.origX, saved.origY, saved.uuid)

            console.log(`[DuelManager] Restored ${saved.name}: inventory + position (${saved.origX},${saved.origY})`)

            // Clean up saved data
            ex.storage.set(`duel_inv_${uid}`, '')
          }

          // Award tokens to winner
          if (!isDraw && data.winnername !== 'DRAW') {
            const bank = getBankAPI(ex.bot)
            if (bank) {
              bank.addCoins(data.winnername, tokenReward, 'Duel victory')
              sendPrivateMessage(data.winnername, `You won the duel! +${tokenReward} tokens`)
              sendPrivateMessage(data.losername, `You lost the duel. Better luck next time!`)
              console.log(`[DuelManager] Awarded ${tokenReward} tokens to ${data.winnername}`)
            }
          } else {
            // Draw — notify both
            const saved1Raw = ex.storage.get(`duel_inv_${p1uid}`, '')
            const saved2Raw = ex.storage.get(`duel_inv_${p2uid}`, '')
            if (saved1Raw) {
              const s = JSON.parse(saved1Raw)
              if (s.name) sendPrivateMessage(s.name, 'Duel ended in a draw!')
            }
            if (saved2Raw) {
              const s = JSON.parse(saved2Raw)
              if (s.name) sendPrivateMessage(s.name, 'Duel ended in a draw!')
            }
          }

          // Update stats
          if (!isDraw) {
            updateStats(ex, data.winnername, 'win')
            updateStats(ex, data.losername, 'loss')
          } else {
            // Resolve names from saved data for draw stats
            for (const uid of [p1uid, p2uid]) {
              const savedRaw = ex.storage.get(`duel_inv_${uid}`, '')
              if (savedRaw) {
                const saved = JSON.parse(savedRaw)
                if (saved.name) updateStats(ex, saved.name, 'draw')
              }
            }
          }

          // Signal C hooks that restore is done
          if (isDraw) {
            ex.bot.send(`/duel-restored ${p1uid} ${p2uid}`)
          } else {
            ex.bot.send(`/duel-restored ${data.winner} ${data.loser}`)
          }

          console.log('[DuelManager] Duel fully resolved.')
        })
      } catch (err) {
        console.error('[DuelManager] END handler error:', err)
      }
    }

    function updateStats(ex: any, playerName: string, result: 'win' | 'loss' | 'draw') {
      const key = `duel_stats_${playerName}`
      const raw = ex.storage.get(key, '{"wins":0,"losses":0,"draws":0}')
      const stats: DuelStats = JSON.parse(raw)
      if (result === 'win') stats.wins++
      else if (result === 'loss') stats.losses++
      else stats.draws++
      ex.storage.set(key, JSON.stringify(stats))
    }

    // /duelstats command
    ex.world.onMessage.sub(({ player, message }: { player: any; message: string }) => {
      if (message.toLowerCase() !== '/duelstats') return
      const key = `duel_stats_${player.name}`
      const raw = ex.storage.get(key, '{"wins":0,"losses":0,"draws":0}')
      const stats: DuelStats = JSON.parse(raw)
      sendPrivateMessage(player.name, `Duel Stats — Wins: ${stats.wins} | Losses: ${stats.losses} | Draws: ${stats.draws}`)
    })
  })
  return 'duel-manager'
}

DuelManager.extensionName = 'duel-manager'
DuelManager.requires = ['virtual-bank', 'activity-monitor'] as const
