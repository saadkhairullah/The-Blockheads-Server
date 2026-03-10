/**
 * This file allows communication between the bot process and the python LMDB tool
 * Blockhead service: per-operation Python spawns via execFileAsync.
 *
 * Each call spawns world_manager.py or inventory_reader.py for the specific
 * operation needed. LMDB is opened fresh per spawn — no stale data risk.
 *
 * Latency: ~80-150ms per spawn (Python startup). Acceptable because:
 * - Inventory polling: 15s interval — 80ms is invisible
 * - Give/take/teleport: player is kicked first (~3s before reconnect)
 * - Position/blockhead lookups: called once per TPA/join event
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { config } from './config'

const execFileAsync = promisify(execFile)

// In-memory cache: skip LMDB spawn when we already know the mapping
const playerToBlockheads = new Map<string, Set<number>>()
const blockheadToPlayer = new Map<number, string>()

const runScript = (script: string, args: string[]): ReturnType<typeof execFileAsync> => {
  return execFileAsync(config.paths.python, [script, '--save-path', config.paths.worldSave, ...args], {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

const wm = (args: string[]) => runScript(config.paths.worldManager, args)
const ir = (args: string[]) => runScript(config.paths.inventoryReader, args)

/**
 * Get all blockhead IDs for a player UUID.
 */
export const getBlockheadsForPlayer = async (playerUuid: string): Promise<number[]> => {
  const cached = playerToBlockheads.get(playerUuid)
  if (cached) return Array.from(cached)

  try {
    const { stdout } = await ir(['--list-blockheads', '--player-uuid', playerUuid])
    const result = JSON.parse(stdout.toString().trim())
    const ids: number[] = result.blockheadIds || []

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
 * Reads the {uuid}_blockheads LMDB key (separate from inventory keys).
 */
export const getBlockheadNames = async (playerUuid: string): Promise<{ blockheadId: number, name: string }[]> => {
  try {
    const { stdout } = await wm(['--list-blockheads-with-names', '--player-uuid', playerUuid])
    const result = JSON.parse(stdout.toString().trim())
    return result.blockheads || []
  } catch (err) {
    console.error('[BlockheadService] getBlockheadNames failed:', err)
    return []
  }
}

/**
 * Get inventory counts for a specific blockhead.
 * playerUuid is required for direct key lookup (O(log n) vs O(n) scan).
 */
export const getInventoryCounts = async (blockheadId: number, playerUuid: string): Promise<Record<number, number> | null> => {
  try {
    const { stdout } = await ir([
      '--blockhead-inventory-counts',
      '--blockhead-id', String(blockheadId),
      '--player-uuid', playerUuid,
    ])
    const result = JSON.parse(stdout.toString().trim())
    return result.items ?? null
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
    const { stdout } = await ir(['--inventory-counts', '--player-uuid', playerUuid])
    const result = JSON.parse(stdout.toString().trim())
    return result.items || {}
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
    const args = [
      '--give-item',
      '--blockhead-id', String(blockheadId),
      '--item-id', String(itemId),
      '--count', String(count),
    ]
    if (playerUuid) args.push('--player-uuid', playerUuid)
    if (basketOnly) args.push('--basket-only')
    const { stdout } = await wm(args)
    const result = JSON.parse(stdout.toString().trim())
    return { ok: result.ok === true, error: result.error }
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
    const args = [
      '--take-item',
      '--blockhead-id', String(blockheadId),
      '--item-id', String(itemId),
      '--count', String(count),
    ]
    if (playerUuid) args.push('--player-uuid', playerUuid)
    const { stdout } = await wm(args)
    const result = JSON.parse(stdout.toString().trim())
    return { success: result.success === true, taken: result.taken, error: result.error }
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
    const args = [
      '--apply-quest-items',
      '--blockhead-id', String(blockheadId),
      '--remove-items-json', JSON.stringify(removeItems),
      '--give-items-json', JSON.stringify(giveItems),
    ]
    if (playerUuid) args.push('--player-uuid', playerUuid)
    const { stdout } = await wm(args)
    const result = JSON.parse(stdout.toString().trim())
    return { success: result.success === true, error: result.error }
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
    const args = [
      '--teleport-blockhead',
      '--blockhead-id', String(blockheadId),
      '--x', String(x),
      '--y', String(y),
    ]
    if (playerUuid) args.push('--player-uuid', playerUuid)
    const { stdout } = await wm(args)
    const result = JSON.parse(stdout.toString().trim())
    return { ok: result.ok === true, error: result.error }
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
    const { stdout } = await wm([
      '--get-blockhead-position',
      '--blockhead-id', String(blockheadId),
      '--player-uuid', playerUuid,
    ])
    const result = JSON.parse(stdout.toString().trim())
    return { ok: result.ok === true, x: result.x, y: result.y, error: result.error }
  } catch (err) {
    console.error('[BlockheadService] getBlockheadPosition failed:', err)
    return { ok: false, error: String(err) }
  }
}

/**
 * Fast owner lookup for a blockhead using candidate player UUIDs.
 * Uses direct LMDB key existence checks without full scans.
 */
export const findOwnerForBlockheadFast = async (blockheadId: number, candidateUuids: string[]): Promise<string | null> => {
  try {
    if (!candidateUuids || candidateUuids.length === 0) return null

    const lookupScript = path.join(path.dirname(config.paths.worldManager), 'fast_owner_lookup.py')
    const { stdout } = await execFileAsync(config.paths.python, [
      lookupScript,
      '--save-path', config.paths.worldSave,
      '--blockhead-id', String(blockheadId),
      '--candidate-uuids-json', JSON.stringify(candidateUuids),
    ], { timeout: 8000, maxBuffer: 1024 * 1024 })

    const output = stdout.toString().trim().split('\n').pop() ?? ''
    const response = output ? JSON.parse(output) : {}

    if (response?.playerUuid) {
      blockheadToPlayer.set(blockheadId, response.playerUuid)
      return response.playerUuid
    }
    return null
  } catch (err) {
    console.error('[BlockheadService] findOwnerForBlockheadFast failed:', err)
    return null
  }
}
