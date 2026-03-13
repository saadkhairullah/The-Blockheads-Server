/**
 * Blockhead mapping helpers — backed by PlayerManager.
 *
 * All helper functions delegate to the central PlayerManager singleton.
 */

import * as BlockheadService from '../../blockhead-service'
import { playerManager } from '../../player-manager'

// Re-export playerManager so all files can import it from here
export { playerManager }

// ============================================================================
// MappingState type (kept for attachBlockheadsToPlayer signature)
// ============================================================================

export type MappingState = {
  playerToBlockheads: Map<string, Set<number>>
  playerToUuid: Map<string, string>
  uuidToPlayer: Map<string, string>
  blockheadToPlayer?: Map<number, string>
  blockheadToUuid?: Map<number, string>
  blockheadToOwnerUuid?: Map<number, string>
}

// ============================================================================
// Helper functions — delegate to playerManager
// ============================================================================

type AttachOptions = {
  maxCache?: number
  pruneMap?: <K, V>(map: Map<K, V>, limit: number) => void
}

export const attachBlockheadsToPlayer = (
  playerName: string,
  playerUuid: string,
  blockheadIds: number[],
  _state: MappingState,
  _options?: AttachOptions
) => {
  const player = playerManager.getOrCreate(playerName, playerUuid)
  playerManager.attachBlockheads(player, blockheadIds)
}

export const normalizePlayerName = (
  playerName: string | undefined | null,
  mode: 'trim' | 'upper' | 'lower' = 'trim'
) => {
  if (!playerName) return ''
  const trimmed = playerName.trim()
  if (mode === 'upper') return trimmed.toUpperCase()
  if (mode === 'lower') return trimmed.toLowerCase()
  return trimmed
}

// ============================================================================
// LMDB helpers
// ============================================================================

export const listBlockheadsForPlayerByUuid = async (playerUuid: string): Promise<number[]> => {
  let ids: number[] = []
  try {
    ids = await BlockheadService.getBlockheadsForPlayer(playerUuid)
  } catch {
    // Daemon failed
  }
  if (!ids || ids.length === 0) {
    const fallback = playerManager.getByUuid(playerUuid)?.blockheadIds
    if (fallback && fallback.size > 0) return Array.from(fallback)
  }
  const player = playerManager.getByUuid(playerUuid)
  if (player && ids.length > 0) playerManager.attachBlockheads(player, ids)
  return ids
}

export const listAndMapBlockheads = async (playerName: string, playerUuid: string): Promise<number[]> => {
  const ids = await listBlockheadsForPlayerByUuid(playerUuid)
  if (ids && ids.length > 0) {
    const player = playerManager.getOrCreate(playerName, playerUuid)
    playerManager.attachBlockheads(player, ids)
  }
  return ids
}
