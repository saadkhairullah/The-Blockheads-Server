export interface ActivityEvent {
  time?: string
  timestamp?: string
  type: string
  player: string                // Display name (playerAccount or blockheadName fallback)
  playerAccount?: string        // The player's account/username (reliable for matching with join events)
  blockheadName?: string        // The blockhead's in-game name
  playerUUID?: string           // Player unique identifier from BlockheadsData
  blockheadId?: number
  source?: string
  x?: number
  y?: number
  item?: string
  itemId?: number
  count?: number
  illegal?: boolean
  inventoryChange?: string
  items?: Array<{ item?: string, itemId: number, count: number }>  // For INVENTORY_SNAPSHOT
}
