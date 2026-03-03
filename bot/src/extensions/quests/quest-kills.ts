import { QuestContext, ARENA_CENTER_X, ARENA_CENTER_Y, ARENA_RADIUS, LOG_BOT_DEBUG, ACTIVE_BLOCKHEAD_WINDOW_MS } from './quest-context'
import { getPlayerProgress, getCurrentQuest } from './quest-persistence'
import { sendPrivateMessage } from '../../private-message'

/**
 * Check if a player's most recent known position is inside the arena.
 * Uses the same lastCoords map as travel quest detection.
 */
const isInArena = (ctx: QuestContext, playerName: string): boolean => {
  const blockheads = ctx.playerToBlockheads.get(playerName)
  if (!blockheads || blockheads.size === 0) return false

  for (const bhId of blockheads) {
    const coords = ctx.lastCoords.get(bhId)
    if (!coords) continue
    if (Date.now() - coords.time > ACTIVE_BLOCKHEAD_WINDOW_MS) continue

    const dist = Math.sqrt((coords.x - ARENA_CENTER_X) ** 2 + (coords.y - ARENA_CENTER_Y) ** 2)
    if (dist <= ARENA_RADIUS) return true
  }
  return false
}

/**
 * Called whenever the server log reports a confirmed kill.
 * killer = the player who landed the last hit.
 * victim = the player whose blockhead died.
 *
 * Rules:
 *  - Victim must have been in the arena (by last known coords)
 *  - No self-kills
 *  - Killer must be online and have an active kill quest
 */
export const processKillEvent = (ctx: QuestContext, killer: string, victim: string) => {
  if (killer === victim) return

  if (!ctx.onlinePlayers.has(killer)) {
    if (LOG_BOT_DEBUG) console.log(`[Kill Quests] Killer ${killer} is not online, ignoring`)
    return
  }

  // Arena check on victim position
  if (!isInArena(ctx, victim)) {
    if (LOG_BOT_DEBUG) console.log(`[Kill Quests] Kill outside arena: ${killer} killed ${victim} — not counted`)
    return
  }

  console.log(`[Kill Quests] Arena kill: ${killer} killed ${victim}`)

  const quest = getCurrentQuest(ctx, killer)
  if (!quest) return

  const killReq = quest.requirements.find(r => r.type === 'kill')
  if (!killReq) return

  const needed = killReq.killCount ?? 1
  const progress = getPlayerProgress(ctx, killer)
  if (!progress.killProgress) progress.killProgress = {}

  const current = progress.killProgress[quest.id] ?? 0
  if (current >= needed) return  // Already satisfied, waiting for quest check

  progress.killProgress[quest.id] = current + 1
  ctx.saveQuestProgress()

  const newCount = progress.killProgress[quest.id]
  sendPrivateMessage(killer, `${killer}: Arena kill! [${newCount}/${needed}] for quest "${quest.title}"`)

  if (newCount >= needed) {
    ctx.checkQuestCompletion(killer)
  }
}
