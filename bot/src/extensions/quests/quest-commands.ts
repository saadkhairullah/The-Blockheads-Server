import { QuestContext } from './quest-context'
import { sendPrivateMessage } from '../../private-message'
import { isAdmin as isAdminHelper } from '../helpers/isAdmin'
import { getCurrentQuest, getPlayerProgress, applySeasonResetForPlayer, applySeasonReset } from './quest-persistence'
import { formatReward, isPlayerCurrentlyAtLocation } from './quest-completion'

export const registerQuestCommands = (ctx: QuestContext) => {
  // /quests command
  ctx.world.onMessage.sub(({ player, message }) => {
    if (message !== '/quests' && message !== '/quest') return

    const playerName = player.name
    const progress = getPlayerProgress(ctx, playerName)
    const quest = getCurrentQuest(ctx, playerName)

    if (!quest) {
      if (progress.completedQuests.length > 0) {
        sendPrivateMessage(playerName, `${playerName}: You have completed all available quests!\nCompleted: ${progress.completedQuests.length} quests`)
      } else {
        sendPrivateMessage(playerName, `${playerName}: No quests available.`)
      }
      return
    }

    const requirementLines: string[] = []
    for (const req of quest.requirements) {
      if (req.type === 'collect') {
        const ids = req.anyItemIds && req.anyItemIds.length > 0 ? req.anyItemIds : (req.itemId ? [req.itemId] : [])
        const current = ids.reduce((sum, id) => sum + ctx.getInventoryCount(playerName, id), 0)
        const needed = req.count ?? 1
        const status = ctx.hasFreshInventory(playerName)
          ? (current >= needed ? '[DONE]' : `[${current}/${needed}]`)
          : '[SYNCING]'
        const suffix = req.consume ? ' (delivery)' : ''
        requirementLines.push(`- Have ${needed}x ${req.itemName}${suffix} ${status}`)
      } else if (req.type === 'travel') {
        const atLocation = isPlayerCurrentlyAtLocation(ctx, playerName, req)
        const status = atLocation ? '[AT LOCATION]' : ''
        const coordsLabel = req.hideCoords ? '(hidden location)' : `(${req.x ?? 'any'}, ${req.y ?? 'any'})`
        requirementLines.push(`- Travel to ${coordsLabel} ${status}`)
      } else if (req.type === 'kill') {
        const needed = req.killCount ?? 1
        const current = progress.killProgress?.[quest.id] ?? 0
        requirementLines.push(`- Arena kills: [${current}/${needed}]`)
      }
    }

    const rewardLines = quest.rewards.map(r => `- ${formatReward(r)}`)

    sendPrivateMessage(playerName, `\n--- ${quest.title} ---\n${quest.description}\nRequirements:\n${requirementLines.join('\n')}\nRewards:\n${rewardLines.join('\n')}`)

  })

  // Admin commands
  ctx.world.onMessage.sub(({ player, message }) => {
    if (message.startsWith('/questreset ') && isAdminHelper(player.name)) {
      const targetName = message.slice('/questreset '.length).trim()
      if (targetName) {
        ctx.playerProgress.delete(targetName)
        ctx.inventoryCache.delete(targetName)
        ctx.saveQuestProgress()
        ctx.bot.send(`Quest progress reset for ${targetName}`)
      }
    }

    if (message === '/questskip' && isAdminHelper(player.name)) {
      const progress = getPlayerProgress(ctx, player.name)
      const quest = getCurrentQuest(ctx, player.name)
      if (quest && quest.nextQuestId) {
        progress.currentQuestId = quest.nextQuestId
        progress.travelCompleted = {}
        ctx.saveQuestProgress()
        ctx.bot.send(`${player.name} skipped to next quest`)
      }
    }

    // /seasonreset <playerName> — reset one player's questline to quest 1.
    // completedQuests is preserved so already-rewarded quests don't pay out again.
    if (message.startsWith('/seasonreset ') && isAdminHelper(player.name)) {
      const targetName = message.slice('/seasonreset '.length).trim()
      if (targetName) {
        const progress = ctx.playerProgress.get(targetName)
        if (!progress) {
          ctx.bot.send(`No quest data found for ${targetName}`)
        } else {
          applySeasonResetForPlayer(ctx, targetName)
          ctx.saveQuestProgress()
          ctx.bot.send(`Season reset applied to ${targetName}. They will restart from quest 1 (completed rewards locked).`)
        }
      }
    }

    // /seasonresetall — reset ALL players' questlines to quest 1.
    // Requires double-confirmation: first type /seasonresetall, then /seasonresetall confirm
    if (message === '/seasonresetall confirm' && isAdminHelper(player.name)) {
      const count = applySeasonReset(ctx)
      ctx.saveQuestProgress()
      ctx.bot.send(`Season reset applied to ${count} player(s). All questlines restarted from quest 1.`)
    } else if (message === '/seasonresetall' && isAdminHelper(player.name)) {
      ctx.bot.send(`WARNING: This will reset ALL players to quest 1 (rewards for completed quests are locked). Type /seasonresetall confirm to proceed.`)
    }
  })
}
