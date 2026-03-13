/**
 * Blockhead mapping helpers — now backed by PlayerManager.
 *
 * All helper functions delegate to the central PlayerManager singleton.
 * sharedMappingState is kept as a thin facade for backward compatibility
 * during the Phase 4 migration; callers are migrated to playerManager directly.
 */

import { ActivityEvent } from '../types/shared-types'
import * as BlockheadService from '../../blockhead-service'
import { playerManager } from '../../player-manager'

// Re-export playerManager so all files can import it from here
export { playerManager }

// ============================================================================
// MappingState type (kept for function signatures during migration)
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
// sharedMappingState — facade backed by playerManager
//
// Reading from these maps still works. Over the course of Phase 4 each caller
// is migrated to use playerManager directly; then this facade is removed.
// ============================================================================

function makeLivePlayerToBlockheads(): Map<string, Set<number>> {
  return new Proxy(new Map<string, Set<number>>(), {
    get(_, prop) {
      if (prop === 'get') return (name: string) => playerManager.get(name)?.blockheadIds ?? undefined
      if (prop === 'has') return (name: string) => playerManager.get(name) !== undefined
      if (prop === 'set') return (name: string, ids: Set<number>) => {
        const p = playerManager.get(name)
        if (p) playerManager.attachBlockheads(p, Array.from(ids))
        return this
      }
      if (prop === 'entries') return () => {
        const entries: [string, Set<number>][] = []
        for (const p of playerManager.all()) entries.push([p.name, p.blockheadIds])
        return entries[Symbol.iterator]()
      }
      if (prop === 'size') return Array.from(playerManager.all()).length
      if (prop === 'delete') return () => false
      if (prop === 'clear') return () => {}
      return undefined
    }
  })
}

export const sharedMappingState = {
  get playerToBlockheads() { return makeLivePlayerToBlockheads() },
  get playerToUuid(): Map<string, string> {
    const m = new Map<string, string>()
    for (const p of playerManager.all()) m.set(p.name, p.uuid)
    return m
  },
  get uuidToPlayer(): Map<string, string> {
    const m = new Map<string, string>()
    for (const p of playerManager.all()) m.set(p.uuid, p.name)
    return m
  },
  get blockheadToPlayer(): Map<number, string> {
    const m = new Map<number, string>()
    for (const p of playerManager.all()) for (const id of p.blockheads.keys()) m.set(id, p.name)
    return m
  },
  get blockheadToUuid(): Map<number, string> {
    const m = new Map<number, string>()
    for (const p of playerManager.all()) for (const id of p.blockheads.keys()) m.set(id, p.uuid)
    return m
  },
  get blockheadToOwnerUuid(): Map<number, string> {
    const m = new Map<number, string>()
    for (const p of playerManager.all()) for (const id of p.blockheads.keys()) m.set(id, p.uuid)
    return m
  },
  get playerTrackedBlockhead(): Map<string, number> {
    const m = new Map<string, number>()
    for (const p of playerManager.all()) if (p.trackedBlockheadId != null) m.set(p.name, p.trackedBlockheadId)
    return m
  },
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

export const attachBlockheadsToUuid = (
  playerUuid: string,
  blockheadIds: number[],
  _state: MappingState
) => {
  const player = playerManager.getByUuid(playerUuid)
  if (player) playerManager.attachBlockheads(player, blockheadIds)
}

export const getBlockheadsForUuid = (playerUuid: string, _state: MappingState): Set<number> | null => {
  return playerManager.getByUuid(playerUuid)?.blockheadIds ?? null
}

export const resolveOwnerFromMappings = (blockheadId: number | undefined, _state: MappingState): string | null => {
  if (blockheadId == null) return null
  return playerManager.getByBlockheadId(blockheadId)?.name ?? null
}

export const resolveOwnerWithRefresh = async (
  blockheadId: number,
  _state: MappingState,
  _onlinePlayers: Iterable<string>,
  refreshPlayer: (playerName: string, playerUuid: string) => Promise<void>
): Promise<string | null> => {
  const existing = playerManager.getByBlockheadId(blockheadId)?.name
  if (existing) return existing

  for (const player of playerManager.online()) {
    await refreshPlayer(player.name, player.uuid)
    const resolved = playerManager.getByBlockheadId(blockheadId)?.name
    if (resolved) return resolved
  }
  return null
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

export const pruneMappingCaches = (_state: MappingState, _maxSize: number) => {
  // No-op: PlayerManager doesn't prune — maps grow only for known players,
  // and setOffline() cleans up blockhead entries on leave.
}

// ============================================================================
// Event helpers — delegate to playerManager
// ============================================================================

export const resolveEventPlayer = (event: ActivityEvent, _state: MappingState): string | null => {
  return playerManager.resolveEventPlayer(event)
}

export const updateMappingsFromEvent = (event: ActivityEvent, _state: MappingState) => {
  playerManager.updateFromEvent(event)
}

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
