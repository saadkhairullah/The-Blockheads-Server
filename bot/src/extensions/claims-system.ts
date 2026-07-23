import { MessageBot } from '@bhmb/bot'
import * as fs from 'fs'
import * as path from 'path'
import type { AppConfig } from '../config'
import type { BotContext, ExtensionFactory } from '../bot-context'
import { sendPrivateMessage } from '../private-message'
import { getBankAPI, getActivityMonitorAPI } from './helpers/extension-api'
import { isAdmin } from './helpers/isAdmin'

const MAX_RADIUS = 61
const MIN_CLAIM_DISTANCE = 122

interface ClaimRecord {
  x: number
  y: number
  radius: number
  owner: string
}

export const ClaimsSystem: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('claims-system', (ex) => {
    const economy = cfg.economy as any
    const CLAIM_PRICE: number = economy.claimPrice ?? 500
    const DEFAULT_RADIUS: number = economy.claimDefaultRadius ?? 10
    const claimsFile = path.join(cfg.paths.dataDir, 'claims.json')

    let claims: ClaimRecord[] = []

    function loadClaims() {
      try {
        if (fs.existsSync(claimsFile)) {
          claims = JSON.parse(fs.readFileSync(claimsFile, 'utf-8'))
        }
      } catch { claims = [] }
    }

    function saveClaims() {
      try { fs.writeFileSync(claimsFile, JSON.stringify(claims, null, 2)) } catch (e) {
        console.error('[Claims] Failed to save claims.json:', e)
      }
    }

    function dist(x1: number, y1: number, x2: number, y2: number) {
      return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)
    }

    // Returns the conflicting claim if the new claim center is within MIN_CLAIM_DISTANCE of an existing one
    function findNearby(x: number, y: number): ClaimRecord | undefined {
      return claims.find(c => dist(x, y, c.x, c.y) < MIN_CLAIM_DISTANCE)
    }

    loadClaims()

    ex.world.onMessage.sub(async ({ player, message }) => {
      const raw = message.trim()
      const lower = raw.toLowerCase()
      const playerName = player.name

      // Admin /unclaim — keep cache in sync (hook-commands.ts handles the stdin pipe)
      if (lower === '/unclaim' && isAdmin(playerName)) {
        const activityAPI = getActivityMonitorAPI(ex.bot)
        const coords = activityAPI?.getLastCoords(playerName)
        if (coords) {
          // Remove the claim whose center is closest to the admin's position
          let minDist = Infinity
          let minIdx = -1
          claims.forEach((c, i) => {
            const d = dist(coords.x, coords.y, c.x, c.y)
            if (d < minDist) { minDist = d; minIdx = i }
          })
          if (minIdx >= 0) {
            const removed = claims.splice(minIdx, 1)[0]
            saveClaims()
            console.log(`[Claims] Cache: removed claim for ${removed.owner} at (${removed.x},${removed.y}) (admin unclaim by ${playerName})`)
          }
        }
        return
      }

      if (!lower.startsWith('/claim')) return
      // /claim-at is admin-only, handled by the C hook (forwarded by proxy)
      if (lower.startsWith('/claim-at')) return

      // Parse: /claim [radius]
      const parts = raw.split(/\s+/)
      let radius = DEFAULT_RADIUS
      if (parts.length >= 2) {
        const r = parseInt(parts[1], 10)
        if (isNaN(r) || r < 1 || r > MAX_RADIUS) {
          sendPrivateMessage(playerName, `Usage: /claim [1-${MAX_RADIUS}] — costs ${CLAIM_PRICE} tokens per claim`)
          return
        }
        radius = r
      }

      // Get live coords from activity monitor
      const activityAPI = getActivityMonitorAPI(ex.bot)
      const coords = activityAPI?.getLastCoords(playerName)
      if (!coords) {
        sendPrivateMessage(playerName, 'Could not determine your position. Move around and try again.')
        return
      }

      // Proximity check — reject if within 122 blocks of an existing claim
      const conflict = findNearby(coords.x, coords.y)
      if (conflict) {
        sendPrivateMessage(playerName,
          `Cannot place claim here — too close to ${conflict.owner}'s claim at (${conflict.x}, ${conflict.y}). Must be at least ${MIN_CLAIM_DISTANCE} blocks away.`)
        return
      }

      // Check and charge tokens (optional — free if economy not loaded)
      const bankAPI = getBankAPI(ex.bot)
      if (bankAPI) {
        if (!bankAPI.hasCoins(playerName, CLAIM_PRICE)) {
          const bal = bankAPI.getBalance(playerName)
          sendPrivateMessage(playerName, `You need ${CLAIM_PRICE} tokens to place a claim (you have ${bal}).`)
          return
        }
        bankAPI.removeCoins(playerName, CLAIM_PRICE, 'Land claim')
      }

      // Send /claim-at to server stdin
      const cmd = `/claim-at ${coords.x} ${coords.y} ${playerName} ${radius}\n`
      try {
        fs.appendFileSync(cfg.paths.inputPipe, cmd)
        claims.push({ x: coords.x, y: coords.y, radius, owner: playerName })
        saveClaims()
        const chargeMsg = bankAPI ? ` ${CLAIM_PRICE} tokens charged.` : ''
        sendPrivateMessage(playerName, `Claim placed at (${coords.x}, ${coords.y}) radius=${radius}.${chargeMsg}`)
      } catch (err) {
        if (bankAPI) bankAPI.addCoins(playerName, CLAIM_PRICE, 'Land claim refund (pipe error)')
        sendPrivateMessage(playerName, `Failed to place claim (server pipe error).${bankAPI ? ' Tokens refunded.' : ''}`)
        console.error('[Claims] Failed to write to input pipe:', err)
      }
    })
  })
  return 'claims-system'
}
ClaimsSystem.extensionName = 'claims-system'
ClaimsSystem.requires = ['activity-monitor']
