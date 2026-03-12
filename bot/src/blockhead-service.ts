/**
 * Communicates with the WorldManager UDS daemon (tools/uds_daemon.py).
 *
 * The daemon keeps LMDB open persistently — each operation is ~1-5ms
 * vs ~100-400ms for the old Python spawn approach.
 *
 * Start the daemon before the bot:
 *   python3 tools/uds_daemon.py <save_path>
 */

import { getWMClient } from './wm-client'
import { config } from './config'

// In-memory cache: skip LMDB lookup when we already know the mapping
const playerToBlockheads = new Map<string, Set<number>>()
const blockheadToPlayer = new Map<number, string>()

const wm = () => getWMClient()

/**
 * Get all blockhead IDs for a player UUID.
 */
export const getBlockheadsForPlayer = async (playerUuid: string): Promise<number[]> => {
  const cached = playerToBlockheads.get(playerUuid)
  if (cached) return Array.from(cached)

  try {
    const resp = await wm().send('list_blockheads', { playerUuid })
    const ids: number[] = (resp.blockheadIds as number[]) || []

    playerToBlockheads.set(playerUuid, new Set(ids))
    for (const id of ids) blockheadToPlayer.set(id, playerUuid)

    return ids
  } catch (err) {
    console.error('[BlockheadService] getBlockheadsForPlayer failed:', err)
    return []
  }
}

/**
 * Get blockhead IDs and in-game character names for a player UUID.
 */
export const getBlockheadNames = async (playerUuid: string): Promise<{ blockheadId: number, name: string }[]> => {
  try {
    const resp = await wm().send('list_blockheads_with_names', { playerUuid })
    return (resp.blockheads as { blockheadId: number, name: string }[]) || []
  } catch (err) {
    console.error('[BlockheadService] getBlockheadNames failed:', err)
    return []
  }
}

/**
 * Get inventory counts for a specific blockhead.
 */
export const getInventoryCounts = async (blockheadId: number, playerUuid: string): Promise<Record<number, number> | null> => {
  try {
    const resp = await wm().send('blockhead_inventory_counts', { blockheadId, playerUuid })
    return (resp.items as Record<number, number>) ?? null
  } catch (err) {
    console.error('[BlockheadService] getInventoryCounts failed:', err)
    return null
  }
}

/**
 * Get combined inventory counts for all blockheads of a player.
 */
export const getPlayerInventoryCounts = async (playerUuid: string): Promise<Record<number, number>> => {
  try {
    const resp = await wm().send('inventory_counts', { playerUuid })
    return (resp.items as Record<number, number>) || {}
  } catch (err) {
    console.error('[BlockheadService] getPlayerInventoryCounts failed:', err)
    return {}
  }
}

/**
 * Give item to a blockhead.
 */
export const giveItem = async (
  blockheadId: number,
  itemId: number,
  count = 1,
  playerUuid?: string,
  basketOnly = false
): Promise<{ ok: boolean, error?: string }> => {
  try {
    const resp = await wm().send('give_item', { blockheadId, itemId, count, playerUuid, basketOnly })
    return { ok: resp.ok === true, error: resp.error as string | undefined }
  } catch (err) {
    console.error('[BlockheadService] giveItem failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Take item from a blockhead.
 */
export const takeItem = async (
  blockheadId: number,
  itemId: number,
  count = 1,
  playerUuid?: string
): Promise<{ success: boolean, taken?: number, error?: string }> => {
  try {
    const resp = await wm().send('take_item', { blockheadId, itemId, count, playerUuid })
    return { success: resp.success === true, taken: resp.taken as number | undefined, error: resp.error as string | undefined }
  } catch (err) {
    console.error('[BlockheadService] takeItem failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Remove consumed items and give reward items atomically (quest completion).
 */
export const applyQuestItems = async (
  blockheadId: number,
  removeItems: { itemId: number, count: number }[],
  giveItems: { itemId: number, count: number }[],
  playerUuid?: string
): Promise<{ success: boolean, error?: string }> => {
  try {
    const resp = await wm().send('apply_quest_items', { blockheadId, removeItems, giveItems, playerUuid })
    return { success: resp.success === true, error: resp.error as string | undefined }
  } catch (err) {
    console.error('[BlockheadService] applyQuestItems failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Teleport a blockhead to specific coordinates.
 */
export const teleportBlockhead = async (
  blockheadId: number,
  x: number,
  y: number,
  playerUuid?: string
): Promise<{ ok: boolean, error?: string }> => {
  try {
    const resp = await wm().send('teleport_blockhead', { blockheadId, x, y, playerUuid })
    return { ok: resp.ok === true, error: resp.error as string | undefined }
  } catch (err) {
    console.error('[BlockheadService] teleportBlockhead failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Get a blockhead's current position from LMDB.
 */
export const getBlockheadPosition = async (
  blockheadId: number,
  playerUuid: string
): Promise<{ ok: boolean, x?: number, y?: number, error?: string }> => {
  try {
    const resp = await wm().send('get_blockhead_position', { blockheadId, playerUuid })
    return { ok: resp.ok === true, x: resp.x as number | undefined, y: resp.y as number | undefined, error: resp.error as string | undefined }
  } catch (err) {
    console.error('[BlockheadService] getBlockheadPosition failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Find a random wild teleport location (tree not near any protection sign).
 * Parameters are read from config.json — edit economy/game.spawn there to change them.
 */
export const findWildLocation = async (): Promise<{ success: boolean, x?: number, y?: number, error?: string }> => {
  try {
    const resp = await wm().send('find_wild_location', {
      minY: config.economy.wildMinY,
      maxY: config.economy.wildMaxY,
      spawnX: config.game.spawn.x,
      minSpawnDistance: config.economy.wildMinSpawnDistance,
    })
    return {
      success: resp.success === true,
      x: resp.x as number | undefined,
      y: resp.y as number | undefined,
      error: resp.error as string | undefined,
    }
  } catch (err) {
    console.error('[BlockheadService] findWildLocation failed:', err)
    return { success: false, error: String(err) }
  }
}

/**
 * Fast owner lookup for a blockhead using candidate player UUIDs.
 */
export const findOwnerForBlockheadFast = async (blockheadId: number, candidateUuids: string[]): Promise<string | null> => {
  try {
    if (!candidateUuids || candidateUuids.length === 0) return null

    const resp = await wm().send('find_owner', { blockheadId, candidateUuids })
    const playerUuid = resp.playerUuid as string | null

    if (playerUuid) {
      blockheadToPlayer.set(blockheadId, playerUuid)
      return playerUuid
    }
    return null
  } catch (err) {
    console.error('[BlockheadService] findOwnerForBlockheadFast failed:', err)
    return null
  }
}
