// @ts-ignore — CURRENT_QUEST_VERSION, LAST_OLD_QUEST_ID, FIRST_NEW_QUEST_ID will be used in upcoming kill quest update
import { QuestContext, Quest, QuestRequirement, QuestReward, LOG_QUEST_CACHE, LOG_BOT_DEBUG, ACTIVE_BLOCKHEAD_WINDOW_MS, SHUTDOWN_FLAG_PATH, CURRENT_QUEST_VERSION, LAST_OLD_QUEST_ID, FIRST_NEW_QUEST_ID } from './quest-context'
import { sendPrivateMessage } from '../../private-message'
import * as BlockheadService from '../../blockhead-service'
import { getBankAPI as _getBankAPI, getActivityMonitorAPI as _getActivityMonitorAPI } from '../helpers/extension-api'
import { getCurrentQuest, getPlayerProgress, markQuestCompleted, addToPendingRewards } from './quest-persistence'
import { getKnownBlockheadsForPlayer, resolveBlockheadId, ensureBlockheadOwner, findBlockheadsWithItems, getBlockheadForPlayer } from './quest-resolver'

const isShuttingDown = (): boolean => {
  try {
    const { existsSync } = require('fs')
    return existsSync(SHUTDOWN_FLAG_PATH)
  } catch {
    return false
  }
}

export const travelKey = (req: QuestRequirement) => `travel_${req.x ?? 'any'}_${req.y ?? 'any'}`

export const sendDialogue = (playerName: string, dialogue: string | string[]): Promise<void> => {
  const lines = Array.isArray(dialogue) ? dialogue : [dialogue]
  return new Promise(resolve => {
    lines.forEach((line, i) => {
      setTimeout(() => {
        sendPrivateMessage(playerName, `${playerName}: ${line}`)
        if (i === lines.length - 1) resolve()
      }, 2000 + i * 1000)
    })
  })
}

export const isPlayerCurrentlyAtLocation = (ctx: QuestContext, playerName: string, req: QuestRequirement): boolean => {
  const radius = req.radius ?? 10
  const blockheadIds = getKnownBlockheadsForPlayer(ctx, playerName)

  for (const bhId of blockheadIds) {
    const coords = ctx.lastCoords.get(bhId)
    if (!coords) continue
    if (Date.now() - coords.time > ACTIVE_BLOCKHEAD_WINDOW_MS) continue

    let matches = false
    if (req.x !== undefined && req.y !== undefined) {
      const dist = Math.sqrt((coords.x - req.x) ** 2 + (coords.y - req.y) ** 2)
      matches = dist <= radius
    } else if (req.x !== undefined) {
      matches = Math.abs(coords.x - req.x) <= radius
    } else if (req.y !== undefined) {
      matches = Math.abs(coords.y - req.y) <= radius
    }

    if (matches) return true
  }
  return false
}

export const checkTravelProgress = (ctx: QuestContext, playerName: string, x: number, y: number) => {
  const quest = getCurrentQuest(ctx, playerName)
  if (!quest) return

  const progress = getPlayerProgress(ctx, playerName)

  for (const req of quest.requirements) {
    if (req.type !== 'travel') continue
    if (req.x === undefined && req.y === undefined) continue

    const key = travelKey(req)
    if (progress.travelCompleted[key]) continue

    const radius = req.radius ?? 10
    let matches = false
    if (req.x !== undefined && req.y !== undefined) {
      const dist = Math.sqrt((x - req.x) ** 2 + (y - req.y) ** 2)
      matches = dist <= radius
    } else if (req.x !== undefined) {
      matches = Math.abs(x - req.x) <= radius
    } else if (req.y !== undefined) {
      matches = Math.abs(y - req.y) <= radius
    }

    if (matches) {
      progress.travelCompleted[key] = true
      if (LOG_BOT_DEBUG) console.log(`[Quest System] ${playerName} reached location (${req.x ?? 'any'}, ${req.y ?? 'any'})`)
      ctx.saveQuestProgress()
      ctx.checkQuestCompletion(playerName)
    }
  }
}

export const checkQuestCompletion = (ctx: QuestContext, playerName: string) => {
  if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletion CALLED for ${playerName}`)
  checkQuestCompletionAsync(ctx, playerName).catch(err => {
    console.error('[Quest System] Quest completion check failed:', err)
  })
}

const checkQuestCompletionAsync = async (ctx: QuestContext, playerName: string) => {
  const quest = getCurrentQuest(ctx, playerName)
  if (!quest) {
    if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): No current quest`)
    return
  }

  if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Checking quest ${quest.id} "${quest.title}"`)

  const failureKey = `${playerName}:${quest.id}`
  const lastFailure = ctx.recentRewardFailures.get(failureKey)
  if (lastFailure && (Date.now() - lastFailure) < 30000) {
    if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Skipping - recent failure cooldown`)
    return
  }

  const progress = getPlayerProgress(ctx, playerName)

  for (const req of quest.requirements) {
    if (req.type === 'collect') {
      const needed = req.count ?? 1
      const ids = req.anyItemIds && req.anyItemIds.length > 0 ? req.anyItemIds : (req.itemId ? [req.itemId] : [])
      const current = ids.reduce((sum, id) => sum + ctx.getInventoryCount(playerName, id), 0)
      const label = req.consume ? 'Consume' : 'Collect'
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): ${label} check - need ${needed}x items [${ids.join(',')}], have ${current}`)
      if (current < needed) {
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): ${label} requirement NOT met`)
        return
      }
    } else if (req.type === 'travel') {
      const key = travelKey(req)
      const alreadyReached = !!progress.travelCompleted[key]
      const currentlyAtLocation = alreadyReached || ctx.isPlayerCurrentlyAtLocation(playerName, req)
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Travel check - key=${key}, alreadyReached=${alreadyReached}, currentlyAt=${currentlyAtLocation}`)
      if (!currentlyAtLocation) {
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Travel requirement NOT met (not currently at location)`)
        return
      }
      // Persist the visit so future checks pass even after the player moves away
      if (!alreadyReached) {
        progress.travelCompleted[key] = true
      }
    } else if (req.type === 'kill') {
      const needed = req.killCount ?? 1
      const killProgress = getPlayerProgress(ctx, playerName)
      const current = killProgress.killProgress?.[quest.id] ?? 0
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Kill check - need ${needed}, have ${current}`)
      if (current < needed) {
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): Kill requirement NOT met`)
        return
      }
    }
  }

  if (LOG_QUEST_CACHE) console.log(`[Quest Debug] checkQuestCompletionAsync(${playerName}): ALL requirements met! Completing quest ${quest.id}`)
  completeQuest(ctx, playerName, quest)
}

export const formatReward = (reward: QuestReward) => {
  if (reward.type === 'tokens') {
    return `${reward.count} Tokens`
  }
  return `${reward.count}x ${reward.itemName ?? 'item'}`
}

export const executeGiveCommand = (ctx: QuestContext, playerName: string, itemId: number, count: number): boolean => {
  const actAPI = _getActivityMonitorAPI(ctx.bot)
  const blockheadId = actAPI && typeof actAPI.getMostRecentBlockheadId === 'function'
    ? actAPI.getMostRecentBlockheadId(playerName)
    : null
  const cmd = blockheadId !== null
    ? `/give-id ${blockheadId} ${itemId} ${count}`
    : `/give ${playerName} ${itemId} ${count}`
  if (LOG_BOT_DEBUG) console.log(`[Quest System] Executing: ${cmd}`)
  ctx.bot.send(cmd)
  return true
}

const applyQuestItemsByBlockhead = async (blockheadId: number, removeItems: Array<{ itemId: number; count: number }>, giveItems: Array<{ itemId: number; count: number }>, playerUuid?: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const result = await BlockheadService.applyQuestItems(blockheadId, removeItems, giveItems, playerUuid)
    return { ok: result.success, error: result.error }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

const completeQuest = async (ctx: QuestContext, playerName: string, quest: Quest) => {
  if (isShuttingDown()) {
    console.log(`[Quest System] Shutdown pending - blocking quest completion for ${playerName}`)
    return
  }

  const completionKey = `${playerName}:${quest.id}`
  if (ctx.completionInFlight.has(completionKey)) {
    return
  }
  ctx.completionInFlight.add(completionKey)

  try {
  const progress = getPlayerProgress(ctx, playerName)

  if (progress.completedQuests.includes(quest.id)) {
    // Already completed — advance to next quest without giving rewards again
    if (quest.nextQuestId) {
      progress.currentQuestId = quest.nextQuestId
      console.log(`[Quest System] ${playerName} re-encountered completed quest "${quest.title}", advancing to ${quest.nextQuestId} (no rewards)`)
    } else {
      progress.currentQuestId = ''
      console.log(`[Quest System] ${playerName} re-encountered completed quest "${quest.title}" (final quest, clearing currentQuestId)`)
    }
    progress.travelCompleted = {}
    ctx.saveQuestProgress()
    ctx.bot.send(`${playerName} completed quest: "${quest.title}"! (REPEAT)`)
    return
  }

  const bankAPI = _getBankAPI(ctx.bot)
  const itemRewards = quest.rewards.filter(r => (r.type ?? 'item') === 'item')
  const tokenRewards = quest.rewards.filter(r => r.type === 'tokens')
  const deliverRequirements = quest.requirements.filter(r => r.type === 'collect' && r.consume)
  const removeItems = deliverRequirements
    .map(req => ({ itemId: req.itemId ?? -1, count: req.count ?? 1 }))
    .filter(entry => entry.itemId > 0 && entry.count > 0)
  const giveItems = itemRewards
    .map(reward => ({ itemId: reward.itemId ?? -1, count: reward.count, itemName: reward.itemName }))
    .filter(entry => entry.itemId > 0 && entry.count > 0)
  // hasDelivery = true forces the LMDB kick-first path.
  // Triggered by consume requirements OR by the lmdbDelivery flag on the quest.
  const hasDelivery = deliverRequirements.length > 0 || quest.lmdbDelivery === true

  if (hasDelivery) {
    const itemIdsToFind = removeItems.map(r => r.itemId)
    const blockheadsWithItems = await findBlockheadsWithItems(ctx, playerName, itemIdsToFind)
    if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): blockheads with items: [${blockheadsWithItems.join(',')}]`)

    let blockheadId: number | null = null
    const lastActive = ctx.playerToLastBlockhead.get(playerName)
    if (typeof lastActive === 'number' && blockheadsWithItems.includes(lastActive)) {
      blockheadId = lastActive
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): using lastActive blockhead=${blockheadId} (has items)`)
    } else if (blockheadsWithItems.length > 0) {
      blockheadId = blockheadsWithItems[0]
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): using first blockhead with items=${blockheadId}`)
    } else {
      if (typeof lastActive === 'number') {
        blockheadId = lastActive
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): fallback to lastActive=${blockheadId} (no items found)`)
      } else {
        blockheadId = getBlockheadForPlayer(ctx, playerName)
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): getBlockheadForPlayer returned=${blockheadId}`)
      }
    }

    // If there are items to consume but none were found in LMDB, the items are
    // still in game server RAM (not yet flushed to disk). Bail without kicking —
    // the server saves every ~67s and the next inventory poll will retry.
    if (removeItems.length > 0 && blockheadsWithItems.length === 0) {
      if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): consume items not in LMDB yet, deferring until next poll`)
      return
    }

    if (blockheadId === null) {
      return
    }

    const owner = await ensureBlockheadOwner(ctx, blockheadId, ctx.playerToUuid.get(playerName))
    if (!owner) {
      const fKey = `${playerName}:${quest.id}`
      sendPrivateMessage(playerName, `${playerName}: Delivery failed because your blockhead owner is not known yet. Please relog/move and try again.`)
      ctx.recentRewardFailures.set(fKey, Date.now())
      return
    }

    ctx.bot.send(`/kick ${playerName}`)
    // Wait for server to process kick and flush RAM cache to LMDB
    await new Promise(resolve => setTimeout(resolve, 200))

    const failureKey = `${playerName}:${quest.id}`
    let result = await applyQuestItemsByBlockhead(blockheadId!, removeItems, giveItems, ctx.playerToUuid.get(playerName))

    if (!result.ok && blockheadsWithItems.length > 1) {
      for (const altId of blockheadsWithItems) {
        if (altId === blockheadId) continue
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): trying alternate blockhead=${altId}`)
        result = await applyQuestItemsByBlockhead(altId, removeItems, giveItems, ctx.playerToUuid.get(playerName))
        if (result.ok) {
          blockheadId = altId
          break
        }
      }
    }

    if (!result.ok && (result.error === 'player_uuid_not_found' || result.error === 'inventory_not_found')) {
      const refreshedId = await resolveBlockheadId(ctx, playerName)
      if (refreshedId !== null) {
        if (LOG_QUEST_CACHE) console.log(`[Quest Debug] completeQuest(${playerName}): retrying with refreshed blockhead=${refreshedId}`)
        result = await applyQuestItemsByBlockhead(refreshedId, removeItems, giveItems, ctx.playerToUuid.get(playerName))
        if (result.ok) blockheadId = refreshedId
      }
    }

    if (!result.ok) {
      if (result.error === 'insufficient_items') {
        console.warn(`[Quest System] Delivery failed for ${playerName} after kick - insufficient items. Quest remains incomplete.`)
        ctx.recentRewardFailures.set(failureKey, Date.now())
        return
      }
      const reason = result.error ? ` (${result.error})` : ''
      console.warn(`[Quest System] Delivery failed for ${playerName} after kick${reason}. Quest remains incomplete.`)
      ctx.recentRewardFailures.set(failureKey, Date.now())
      return
    }

    markQuestCompleted(ctx, playerName, quest)

    if (quest.dialogue) {
      const lines = Array.isArray(quest.dialogue) ? quest.dialogue : [quest.dialogue]
      ctx.pendingKickDialogue.set(playerName, lines)
    }

    const rewardDescriptions = quest.rewards.map(r => formatReward(r)).join(', ')
    ctx.bot.send(`${playerName} completed quest: "${quest.title}"!\nRewards: ${rewardDescriptions}`)

    if (tokenRewards.length > 0 && bankAPI && typeof bankAPI.addCoins === 'function') {
      for (const reward of tokenRewards) {
        bankAPI.addCoins(playerName, reward.count, `Quest reward: ${quest.title}`)
      }
    }

    ctx.saveQuestProgress()
    return
  }

  // ----- Travel-only quests (no delivery/consumption) -----
  markQuestCompleted(ctx, playerName, quest)

  if (quest.dialogue) {
    await sendDialogue(playerName, quest.dialogue)
  }

  const rewardDescriptions = quest.rewards.map(r => formatReward(r)).join(', ')
  ctx.bot.send(`${playerName} completed quest: "${quest.title}"!\nRewards: ${rewardDescriptions}`)

  if (tokenRewards.length > 0) {
    if (!bankAPI || typeof bankAPI.addCoins !== 'function') {
      console.warn(`[Quest System] Bank API missing; token rewards skipped for ${playerName}`)
    } else {
      for (const reward of tokenRewards) {
        bankAPI.addCoins(playerName, reward.count, `Quest reward: ${quest.title}`)
      }
    }
  }

  if (giveItems.length > 0) {
    setTimeout(() => {
      // Don't give items to an offline player — defer to /claim
      if (!ctx.onlinePlayers.has(playerName)) {
        addToPendingRewards(ctx, playerName, giveItems, `Quest: ${quest.title}`)
        console.log(`[Quest System] ${playerName} offline at reward delivery — deferred to /claim`)
        return
      }

      const delivered: typeof giveItems = []
      const failed: typeof giveItems = []

      for (const item of giveItems) {
        const success = executeGiveCommand(ctx, playerName, item.itemId, item.count)
        if (success) {
          delivered.push(item)
        } else {
          failed.push(item)
        }
      }

      if (delivered.length > 0) {
        const itemDesc = delivered.map(i => `${i.count}x ${i.itemName ?? `item ${i.itemId}`}`).join(', ')
        sendPrivateMessage(playerName, `${playerName}: Rewards delivered: ${itemDesc}`)
      }

      if (failed.length > 0) {
        addToPendingRewards(ctx, playerName, failed, `Quest: ${quest.title}`)
        sendPrivateMessage(playerName, `${playerName}: Some rewards failed. Type /claim after rejoining to receive them.`)
      }
    }, 1500)
  }

  ctx.saveQuestProgress()

  } catch (err) {
    console.error(`[Quest System] completeQuest error for ${playerName} quest ${quest.id}:`, err)
  } finally {
    ctx.completionInFlight.delete(completionKey)
  }
}
