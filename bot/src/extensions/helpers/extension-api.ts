export function getExtensionAPI<T = any>(bot: any, extensionName: string): T | null {
  try {
    return bot.getExports(extensionName)
  } catch {
    return null
  }
}

export interface BankAPI {
  hasCoins: (player: string, amount: number) => boolean
  removeCoins: (player: string, amount: number, reason: string) => boolean
  addCoins: (player: string, amount: number, reason: string) => void
  getBalance: (player: string) => number
}

export interface ActivityMonitorAPI {
  getBlockheadsForPlayer: (player: string) => number[]
  getMostRecentBlockheadId: (player: string) => number | null
  getPlayerUuid: (player: string) => string | null
  addAdminAllowlist: (player: string) => void
  removeAdminAllowlist: (player: string) => void
}

export interface QuestAPI {
  hasCompletedQuest: (player: string, questId: string) => boolean
}

export const getBankAPI = (bot: any): BankAPI | null =>
  getExtensionAPI<BankAPI>(bot, 'virtual-bank')

export const getActivityMonitorAPI = (bot: any): ActivityMonitorAPI | null =>
  getExtensionAPI<ActivityMonitorAPI>(bot, 'activity-monitor')

export const getQuestAPI = (bot: any): QuestAPI | null =>
  getExtensionAPI<QuestAPI>(bot, 'quest-system')
