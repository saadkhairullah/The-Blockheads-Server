/**
 * Quest types:
 * - 'collect': Player must have X of an item in inventory (checked via LMDB)
 * - 'travel': Player must reach specific coordinates (checked via packets)
 */
export interface QuestRequirement {
  type: 'collect' | 'travel' | 'kill'
  itemId?: number       // For collect quests
  itemName?: string     // Display name for the item
  count?: number        // How many to have in inventory
  x?: number            // For travel quests
  y?: number
  radius?: number       // How close they need to get (default 10)
  hideCoords?: boolean  // If true, do not show exact coords in quest text
  anyItemIds?: number[] // For collect: any of these item IDs can satisfy the count
  consume?: boolean     // Remove items on completion (collect quests only)
  killCount?: number    // For kill quests: how many arena kills needed
}

export interface QuestReward {
  itemId?: number
  itemName?: string
  count: number
  type?: 'item' | 'tokens'
}

export interface Quest {
  id: string
  title: string
  description: string
  requirements: QuestRequirement[]
  rewards: QuestReward[]
  nextQuestId?: string  // Quest to unlock after completion
  dialogue?: string | string[]  // Message(s) sent privately to player after completion, 1s apart
  lmdbDelivery?: boolean  // Force LMDB kick-first path for item rewards (even without consume reqs)
}
