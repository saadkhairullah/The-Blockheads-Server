/**
 * Duel System — fully bot-side, no C hook involvement.
 *
 * Flow:
 *   /duel TARGET   → challenger issues challenge (60s timeout)
 *   /accept        → target accepts → kick both → backup inv → give kit → teleport to arena → countdown → FIGHT
 *   /decline       → cancel challenge
 *   kill detected  → declare winner → kick both → restore inv → teleport back → award tokens
 *   timeout (120s) → draw → restore both
 */

import * as fs from 'fs'
import type { BotContext, ExtensionFactory } from '../../bot-context'
import type { AppConfig } from '../../config'
import { getBankAPI, getActivityMonitorAPI } from '../helpers/extension-api'
import { sendPrivateMessage } from '../../private-message'
import { enqueueShared } from '../../shared-queue'
import {
  backupInventory,
  restoreInventory,
  duelClearAndGive,
  teleportBlockhead,
  getInventoryCounts,
} from '../../blockhead-service'
import { addKillCallback } from '../../linux-api'

const MessageBot = require('@bhmb/bot').MessageBot

interface PendingDuel {
  challenger: string
  target: string
  timer: ReturnType<typeof setTimeout>
}

interface ActiveDuel {
  p1: string  // challenger
  p2: string  // target
  p1bhId: number
  p2bhId: number
  p1uuid: string
  p2uuid: string
  p1origX: number
  p1origY: number
  p2origX: number
  p2origY: number
  phase: 'countdown' | 'fighting'
  timer: ReturnType<typeof setTimeout>
}

interface DuelStats {
  wins: number
  losses: number
  draws: number
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const DuelSystem: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('duel-system', (ex: any) => {
    const duelCfg = (cfg.hooks as any)?.duel ?? {}
    const tokenReward: number = duelCfg.tokenReward ?? 100
    const kitItems: { itemId: number; count: number }[] = duelCfg.kit ?? []
    const pendingTimeout: number = (duelCfg.pendingTimeout ?? 60) * 1000
    const fightTimeout: number = (duelCfg.timeout ?? 120) * 1000
    const countdown: number = duelCfg.countdown ?? 10
  const postKickFlushDelayMs: number = duelCfg.postKickFlushDelayMs ?? 1500
  const postPrepVerifyDelayMs: number = duelCfg.postPrepVerifyDelayMs ?? 700
  const strictInventoryVerify: boolean = duelCfg.strictInventoryVerify ?? false

    // Arena position: use duel arena if set, else game arena
    const arenaX: number = duelCfg.arena?.x || (cfg.game as any)?.arena?.x || 0
    const arenaY: number = duelCfg.arena?.y || (cfg.game as any)?.arena?.y || 0

  const pending = new Map<string, PendingDuel>()  // key = target name (lowercase)
    let active: ActiveDuel | null = null

    // -------------------------------------------------------------------------
    // Kill detection
    // -------------------------------------------------------------------------
    addKillCallback((killer: string, victim: string) => {
      if (!active || active.phase !== 'fighting') return
      const p1 = active.p1
      const p2 = active.p2
      const isP1Kill = killer === p1 && victim === p2
      const isP2Kill = killer === p2 && victim === p1
      if (!isP1Kill && !isP2Kill) return
      const winner = isP1Kill ? p1 : p2
      const loser = isP1Kill ? p2 : p1
      clearTimeout(active.timer)
      const snap = active
      active = null
      enqueueShared(() => resolveDuel(snap, winner, loser, false))
    })

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------
    ex.world.onMessage.sub(async ({ player, message }: { player: any; message: string }) => {
      const raw = message.trim()
      const lower = raw.toLowerCase()
      const playerName: string = player.name
      const playerKey = playerName.toLowerCase()

      // --- /duel TARGET ---
      if (lower.startsWith('/duel ')) {
        const target = raw.slice(6).trim()
        const targetKey = target.toLowerCase()
        if (!target) { sendPrivateMessage(playerName, 'Usage: /duel <playerName>'); return }
        if (target.toLowerCase() === playerName.toLowerCase()) {
          sendPrivateMessage(playerName, 'You cannot duel yourself.')
          return
        }
        if (active) {
          sendPrivateMessage(playerName, 'A duel is already in progress.')
          return
        }
        if (pending.has(targetKey) || pending.has(playerKey)) {
          sendPrivateMessage(playerName, 'A duel challenge is already pending.')
          return
        }

        const timer = setTimeout(() => {
          pending.delete(targetKey)
          sendPrivateMessage(playerName, `Your challenge to ${target} expired.`)
          sendPrivateMessage(target, `The duel challenge from ${playerName} expired.`)
        }, pendingTimeout)

        pending.set(targetKey, { challenger: playerName, target, timer })
        sendPrivateMessage(playerName, `Challenge sent to ${target}. They have ${pendingTimeout / 1000}s to /accept or /decline.`)
        sendPrivateMessage(target, `${playerName} challenges you to a duel! Type /accept or /decline. (${pendingTimeout / 1000}s)`)
        ex.bot.send(`${playerName} challenges ${target} to a duel! Type /accept or /decline.`)
        return
      }

      // --- /accept ---
      if (lower === '/accept') {
        const challenge = pending.get(playerKey)
        if (!challenge) {
          console.warn(`[DuelSystem] /accept with no pending challenge for ${playerName}. Pending keys: ${Array.from(pending.keys()).join(', ')}`)
          sendPrivateMessage(playerName, 'No duel challenge to accept.')
          return
        }
        if (active) { sendPrivateMessage(playerName, 'A duel is already in progress.'); return }

        clearTimeout(challenge.timer)
        pending.delete(playerKey)

        const challenger = challenge.challenger
        const target = playerName

        enqueueShared(() => startDuel(challenger, target))
        return
      }

      // --- /decline ---
      if (lower === '/decline') {
        const challenge = pending.get(playerKey)
        if (!challenge) { sendPrivateMessage(playerName, 'No duel challenge to decline.'); return }
        clearTimeout(challenge.timer)
        pending.delete(playerKey)
        sendPrivateMessage(challenge.challenger, `${playerName} declined your duel challenge.`)
        sendPrivateMessage(playerName, 'You declined the duel challenge.')
        return
      }

      // --- /duelstats ---
      if (lower === '/duelstats') {
        const key = `duel_stats_${playerName}`
        const raw2 = ex.storage.get(key, '{"wins":0,"losses":0,"draws":0}')
        const stats: DuelStats = JSON.parse(raw2)
        sendPrivateMessage(playerName, `Duel Stats — Wins: ${stats.wins} | Losses: ${stats.losses} | Draws: ${stats.draws}`)
        return
      }
    })

    // -------------------------------------------------------------------------
    // Duel start
    // -------------------------------------------------------------------------
    const hasExpectedKit = (inv: Record<number, number> | null): boolean => {
      if (!kitItems.length) return true
      if (!inv) return false
      return kitItems.every(k => {
        const have = inv[k.itemId] ?? 0
        return have >= k.count
      })
    }

    const prepareInventoryWithVerify = async (
      playerName: string,
      bhId: number,
      uuid: string,
      clothingIds: number[]
    ): Promise<{ ok: boolean; error?: string }> => {
      // One normal attempt + one repair attempt if verification fails.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prep = await duelClearAndGive(bhId, clothingIds, kitItems, uuid)
        if (!prep.success) {
          return { ok: false, error: prep.error ?? 'duel_clear_and_give_failed' }
        }

        // Allow any delayed save flushes to settle before verifying persisted LMDB state.
        await delay(postPrepVerifyDelayMs)

        const inv = await getInventoryCounts(bhId, uuid)
        if (hasExpectedKit(inv)) {
          if (attempt > 1) {
            console.warn(`[DuelSystem] Inventory repair succeeded for ${playerName} on attempt ${attempt}`)
          }
          return { ok: true }
        }

        console.warn(`[DuelSystem] Inventory verify failed for ${playerName} (attempt ${attempt}). Retrying prep...`)
      }

      return { ok: false, error: 'inventory_verify_failed_after_retry' }
    }

    async function startDuel(p1: string, p2: string) {
      const t0 = Date.now()
      const activityAPI = getActivityMonitorAPI(ex.bot)
      if (!activityAPI) {
        ex.bot.send('[Duel] System unavailable (activity monitor not ready).')
        return
      }

      const p1uuid = activityAPI.getPlayerUuid(p1)
      const p2uuid = activityAPI.getPlayerUuid(p2)
      const p1bhId = activityAPI.getMostRecentBlockheadId(p1)
      const p2bhId = activityAPI.getMostRecentBlockheadId(p2)
      const p1coords = activityAPI.getLastCoords(p1)
      const p2coords = activityAPI.getLastCoords(p2)

      if (!p1uuid || !p2uuid || !p1bhId || !p2bhId || !p1coords || !p2coords) {
        ex.bot.send('[Duel] Could not find both players (must be online and have moved).')
        sendPrivateMessage(p1, 'Duel failed: could not locate your blockhead.')
        sendPrivateMessage(p2, 'Duel failed: could not locate your blockhead.')
        return
      }

      if (!arenaX && !arenaY) {
        ex.bot.send('[Duel] No arena position configured.')
        return
      }

      ex.bot.send(`${p1} accepted ${p2}'s duel challenge! Preparing arena...`)

      // Kick both and wait for actual disconnect events before touching LMDB.
      // Game server saves player state on disconnect — we must wait for that to finish.
      // NOTE: @bhmb/bot's SimpleEvent.sub() returns undefined (NOT an unsubscribe fn).
      // Must use ex.world.onLeave.unsub(handler) with a named handler reference.
      const waitForLeave = (name: string): Promise<boolean> => {
        return new Promise(resolve => {
          let timer: ReturnType<typeof setTimeout> | null = null
          const handler = (player: any) => {
            if (player.name === name) {
              if (timer) clearTimeout(timer)
              ex.world.onLeave.unsub(handler)
              resolve(true)
            }
          }
          timer = setTimeout(() => {
            ex.world.onLeave.unsub(handler)
            resolve(false)
          }, 8000)
          ex.world.onLeave.sub(handler)
        })
      }

      const p1left = waitForLeave(p1)
      const p2left = waitForLeave(p2)
      ex.bot.send(`/kick ${p1}`)
      ex.bot.send(`/kick ${p2}`)
      const [p1ok, p2ok] = await Promise.all([p1left, p2left])
      console.log(`[DuelSystem] leave wait: p1=${p1ok} p2=${p2ok} elapsed=${Date.now() - t0}ms`)
      // If a timeout occurred the player was still kicked (TCP already dropped).
      // LMDB writes are safe after postKickFlushDelayMs — don't cancel the duel.

  // Give the game server enough time to flush disconnect state to LMDB.
  await delay(postKickFlushDelayMs)

      // Backup inventories (parallel)
      const [p1backup, p2backup] = await Promise.all([
        backupInventory(p1bhId, p1uuid),
        backupInventory(p2bhId, p2uuid)
      ])
      console.log(`[DuelSystem] backup done elapsed=${Date.now() - t0}ms`)

      if (!p1backup || !p2backup) {
        ex.bot.send('[Duel] Failed to back up inventories. Duel cancelled.')
        return
      }

      ex.storage.set(`duel_backup_${p1}`, JSON.stringify({ backup: p1backup, bhId: p1bhId, uuid: p1uuid, x: p1coords.x, y: p1coords.y }))
      ex.storage.set(`duel_backup_${p2}`, JSON.stringify({ backup: p2backup, bhId: p2bhId, uuid: p2uuid, x: p2coords.x, y: p2coords.y }))

      // Clear inventories and give duel kit atomically.
      // Clothing items (IDs 140-143: sunrise hat, sunset skirt, north pole hat, south pole boots)
      // are excluded — backup/restore handles full restoration after the duel (raw bytes, no data loss).
      const CLOTHING_IDS = [140, 141, 142, 143]
      const [r1, r2] = await Promise.all([
        prepareInventoryWithVerify(p1, p1bhId, p1uuid, CLOTHING_IDS),
        prepareInventoryWithVerify(p2, p2bhId, p2uuid, CLOTHING_IDS)
      ])
      console.log(`[DuelSystem] prep done r1=${r1.ok} r2=${r2.ok} elapsed=${Date.now() - t0}ms`)

      if (!r1.ok || !r2.ok) {
        const detail = `${r1.error ?? 'ok'} | ${r2.error ?? 'ok'}`
        if (strictInventoryVerify) {
          ex.bot.send('[Duel] Failed to prepare inventories. Duel cancelled.')
          console.error('[DuelSystem] duelClearAndGive failed (strict mode):', detail)
          return
        }
        console.warn('[DuelSystem] Inventory prep verification failed (non-strict mode), continuing to teleport:', detail)
        ex.bot.send('[Duel] Inventory verify was inconclusive; continuing duel setup.')
      }

      // Teleport both to arena (parallel)
      await Promise.all([
        teleportBlockhead(p1bhId, arenaX, arenaY, p1uuid),
        teleportBlockhead(p2bhId, arenaX, arenaY, p2uuid)
      ])
      console.log(`[DuelSystem] teleport done elapsed=${Date.now() - t0}ms`)

      // Set fight timeout (draw)
      const fightTimer = setTimeout(() => {
        if (!active) return
        const snap = active
        active = null
        enqueueShared(() => resolveDuel(snap, null, null, true))
      }, fightTimeout + countdown * 1000)

      active = {
        p1, p2, p1bhId, p2bhId, p1uuid, p2uuid,
        p1origX: p1coords.x, p1origY: p1coords.y,
        p2origX: p2coords.x, p2origY: p2coords.y,
        phase: 'countdown',
        timer: fightTimer,
      }

      // Countdown
      ex.bot.send(`DUEL: ${p1} vs ${p2} — Fight starts in ${countdown} seconds!`)
      await delay(countdown * 1000)
      if (!active) return  // was cancelled during countdown
      active.phase = 'fighting'
      ex.bot.send(`FIGHT! ${p1} vs ${p2}!`)
    }

    // -------------------------------------------------------------------------
    // Duel resolution
    // -------------------------------------------------------------------------
    async function resolveDuel(snap: ActiveDuel, winner: string | null, loser: string | null, isDraw: boolean) {
      // Kick both and wait for actual disconnects before restoring LMDB.
      // SimpleEvent.sub() returns undefined — use unsub(handler) with a named handler.
      const waitForLeave = (name: string): Promise<boolean> => {
        return new Promise(resolve => {
          let timer: ReturnType<typeof setTimeout> | null = null
          const handler = (player: any) => {
            if (player.name === name) {
              if (timer) clearTimeout(timer)
              ex.world.onLeave.unsub(handler)
              resolve(true)
            }
          }
          timer = setTimeout(() => {
            ex.world.onLeave.unsub(handler)
            resolve(false)
          }, 8000)
          ex.world.onLeave.sub(handler)
        })
      }

      const p1left = waitForLeave(snap.p1)
      const p2left = waitForLeave(snap.p2)
      ex.bot.send(`/kick ${snap.p1}`)
      ex.bot.send(`/kick ${snap.p2}`)
      await Promise.all([p1left, p2left])
      await delay(500)

      // Restore both players (parallel)
      await Promise.all([snap.p1, snap.p2].map(async (name) => {
        const savedRaw = ex.storage.get(`duel_backup_${name}`, '')
        if (!savedRaw) { console.error(`[DuelSystem] No backup for ${name}`); return }
        const saved = JSON.parse(savedRaw)
        const ok = await restoreInventory(saved.bhId, saved.uuid, saved.backup)
        if (!ok) console.error(`[DuelSystem] restoreInventory failed for ${name}`)
        await teleportBlockhead(saved.bhId, saved.x, saved.y, saved.uuid)
        ex.storage.set(`duel_backup_${name}`, '')
      }))

      // Reapply purchased buffs from buff-shop
      await delay(2000)  // wait for players to reconnect
      reapplyBuffs(snap.p1)
      reapplyBuffs(snap.p2)

      if (isDraw) {
        ex.bot.send(`The duel between ${snap.p1} and ${snap.p2} ended in a DRAW!`)
        updateStats(snap.p1, 'draw')
        updateStats(snap.p2, 'draw')
      } else if (winner && loser) {
        ex.bot.send(`${winner} wins the duel against ${loser}!`)
        const bank = getBankAPI(ex.bot)
        if (bank) {
          bank.addCoins(winner, tokenReward, 'Duel victory')
          sendPrivateMessage(winner, `You won! +${tokenReward} tokens.`)
          sendPrivateMessage(loser, 'You lost the duel. Better luck next time!')
        }
        updateStats(winner, 'win')
        updateStats(loser, 'loss')
      }
    }

    function reapplyBuffs(playerName: string) {
      const buffsPath = require('path').join(cfg.paths.dataDir, 'player-buffs.json')
      try {
        const all = JSON.parse(fs.readFileSync(buffsPath, 'utf8'))
        const b = all[playerName]
        if (!b) return
        if (b.defense > 0) fs.appendFileSync(cfg.paths.inputPipe, `/defense ${playerName} ${b.defense}\n`)
        if (b.strength > 0) {
          const mult = (1 + b.strength * 0.05).toFixed(2)
          fs.appendFileSync(cfg.paths.inputPipe, `/buff ${playerName} ${mult}\n`)
        }
      } catch { /* no buff file = no buffs */ }
    }

    function updateStats(playerName: string, result: 'win' | 'loss' | 'draw') {
      const key = `duel_stats_${playerName}`
      const raw = ex.storage.get(key, '{"wins":0,"losses":0,"draws":0}')
      const stats: DuelStats = JSON.parse(raw)
      if (result === 'win') stats.wins++
      else if (result === 'loss') stats.losses++
      else stats.draws++
      ex.storage.set(key, JSON.stringify(stats))
    }
  })

  return 'duel-system'
}

DuelSystem.extensionName = 'duel-system'
DuelSystem.requires = ['activity-monitor'] as const
