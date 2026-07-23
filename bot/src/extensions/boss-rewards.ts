import { MessageBot } from '@bhmb/bot'
import * as fs from 'fs'
import * as path from 'path'
import type { AppConfig } from '../config'
import type { BotContext, ExtensionFactory } from '../bot-context'
import { getBankAPI } from './helpers/extension-api'
import { playerManager } from '../player-manager'

const BOSS_KILL_REWARD = 500

export const BossRewards: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('boss-rewards', (ex) => {
    const killsFile = path.join(cfg.paths.dataDir, 'boss-kills.jsonl')
    let fileOffset = 0

    // Seek to end on startup so we don't replay old kills
    try {
      if (fs.existsSync(killsFile)) {
        fileOffset = fs.statSync(killsFile).size
      }
    } catch { /* file doesn't exist yet */ }

    function drainKills() {
      try {
        if (!fs.existsSync(killsFile)) return
        const size = fs.statSync(killsFile).size
        if (size <= fileOffset) return

        const buf = Buffer.alloc(size - fileOffset)
        const fd = fs.openSync(killsFile, 'r')
        fs.readSync(fd, buf, 0, buf.length, fileOffset)
        fs.closeSync(fd)
        fileOffset = size

        const lines = buf.toString('utf-8').split('\n').filter(l => l.trim())
        for (const line of lines) {
          try {
            const { blockheadId } = JSON.parse(line)
            const player = playerManager.getByBlockheadId(blockheadId)
            const playerName = player?.name
            if (!playerName) {
              console.warn(`[BossRewards] Could not resolve blockheadId ${blockheadId} to a player`)
              continue
            }
            const bank = getBankAPI(ex.bot)
            if (bank) {
              bank.addCoins(playerName, BOSS_KILL_REWARD, 'Boss kill reward')
              ex.bot.send(`${playerName} slew the boss and earned ${BOSS_KILL_REWARD} tokens!`)
              console.log(`[BossRewards] Awarded ${BOSS_KILL_REWARD} tokens to ${playerName}`)
            }
          } catch (e) {
            console.error('[BossRewards] Failed to process kill line:', line, e)
          }
        }
      } catch (e) {
        console.error('[BossRewards] drainKills error:', e)
      }
    }

    fs.watch(path.dirname(killsFile), (_event, filename) => {
      if (filename === 'boss-kills.jsonl') drainKills()
    })
  })
  return 'boss-rewards'
}

BossRewards.extensionName = 'boss-rewards'
BossRewards.requires = []
