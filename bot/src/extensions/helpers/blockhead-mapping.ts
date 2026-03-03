export type MappingState = {
  playerToBlockheads: Map<string, Set<number>>
  playerToUuid: Map<string, string>
  uuidToPlayer: Map<string, string>
  blockheadToPlayer?: Map<number, string>
  blockheadToUuid?: Map<number, string>
  blockheadToOwnerUuid?: Map<number, string>
}

export const sharedMappingState = {
  playerToBlockheads: new Map<string, Set<number>>(),
  playerToUuid: new Map<string, string>(),
  uuidToPlayer: new Map<string, string>(),
  blockheadToPlayer: new Map<number, string>(),
  blockheadToUuid: new Map<number, string>(),
  blockheadToOwnerUuid: new Map<number, string>(),
  playerTrackedBlockhead: new Map<string, number>(),
}

type AttachOptions = {
  maxCache?: number
  pruneMap?: <K, V>(map: Map<K, V>, limit: number) => void
}

export const attachBlockheadsToPlayer = (
  playerName: string,
  playerUuid: string,
  blockheadIds: number[],
  state: MappingState,
  options?: AttachOptions
) => {
  const set = new Set<number>(blockheadIds)
  state.playerToBlockheads.set(playerName, set)
  if (options?.maxCache && options.pruneMap) {
    options.pruneMap(state.playerToBlockheads, options.maxCache)
  }
  state.playerToUuid.set(playerName, playerUuid)
  state.uuidToPlayer.set(playerUuid, playerName)

  for (const id of set) {
    if (state.blockheadToPlayer) state.blockheadToPlayer.set(id, playerName)
    if (state.blockheadToUuid) state.blockheadToUuid.set(id, playerUuid)
    if (state.blockheadToOwnerUuid) state.blockheadToOwnerUuid.set(id, playerUuid)
  }
}

export const attachBlockheadsToUuid = (
  playerUuid: string,
  blockheadIds: number[],
  state: MappingState
) => {
  if (state.blockheadToOwnerUuid) {
    for (const id of blockheadIds) {
      state.blockheadToOwnerUuid.set(id, playerUuid)
    }
  }
  if (state.blockheadToUuid) {
    for (const id of blockheadIds) {
      state.blockheadToUuid.set(id, playerUuid)
    }
  }
  if (state.blockheadToPlayer) {
    const knownName = state.uuidToPlayer.get(playerUuid)
    if (knownName) {
      const set = state.playerToBlockheads.get(knownName) ?? new Set<number>()
      for (const id of blockheadIds) {
        state.blockheadToPlayer.set(id, knownName)
        set.add(id)
      }
      state.playerToBlockheads.set(knownName, set)
    }
  }
}

export const getBlockheadsForUuid = (playerUuid: string, state: MappingState): Set<number> | null => {
  const knownName = state.uuidToPlayer.get(playerUuid)
  if (knownName) {
    return state.playerToBlockheads.get(knownName) ?? null
  }
  for (const [name, uuid] of state.playerToUuid.entries()) {
    if (uuid === playerUuid) {
      return state.playerToBlockheads.get(name) ?? null
    }
  }
  return null
}

export const resolveOwnerFromMappings = (blockheadId: number | undefined, state: MappingState): string | null => {
  if (blockheadId == null) return null
  if (state.blockheadToPlayer) {
    const direct = state.blockheadToPlayer.get(blockheadId)
    if (direct) return direct
  }
  for (const [alias, ids] of state.playerToBlockheads.entries()) {
    if (ids.has(blockheadId)) return alias
  }
  return null
}

export const resolveOwnerWithRefresh = async (
  blockheadId: number,
  state: MappingState,
  onlinePlayers: Iterable<string>,
  refreshPlayer: (playerName: string, playerUuid: string) => Promise<void>
): Promise<string | null> => {
  const existing = resolveOwnerFromMappings(blockheadId, state)
  if (existing) return existing

  for (const playerName of onlinePlayers) {
    const playerUuid = state.playerToUuid.get(playerName)
    if (!playerUuid) continue
    await refreshPlayer(playerName, playerUuid)
    const resolved = resolveOwnerFromMappings(blockheadId, state)
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

export const pruneMappingCaches = (state: MappingState, maxSize: number) => {
  const prune = <K, V>(map: Map<K, V> | undefined) => {
    if (!map) return
    if (map.size <= maxSize) return
    const entries = Array.from(map.entries())
    map.clear()
    for (const [k, v] of entries.slice(-maxSize)) {
      map.set(k, v)
    }
  }

  prune(state.playerToBlockheads)
  prune(state.playerToUuid)
  prune(state.uuidToPlayer)
  prune(state.blockheadToPlayer)
  prune(state.blockheadToUuid)
  prune(state.blockheadToOwnerUuid)
}

// ============================================================================
// Event-based mapping helpers (generic, not quest/activity specific)
// ============================================================================

import { ActivityEvent } from '../types/shared-types'
import * as BlockheadService from '../../blockhead-service'

/**
 * Resolve a player name from an ActivityEvent using shared mapping state.
 * Tries: playerAccount → playerUUID lookup → blockheadId lookup → event.player fallback.
 */
export const resolveEventPlayer = (event: ActivityEvent, state: MappingState): string | null => {
  if (event.playerAccount && event.playerAccount !== '?') {
    return event.playerAccount
  }
  if (event.playerUUID) {
    const name = state.uuidToPlayer.get(event.playerUUID)
    if (name) return name
  }
  if (typeof event.blockheadId === 'number') {
    const alias = resolveOwnerFromMappings(event.blockheadId, state)
    if (alias) return alias
    // Fallback: blockheadToUuid -> uuidToPlayer
    if (state.blockheadToUuid) {
      const cachedUuid = state.blockheadToUuid.get(event.blockheadId)
      if (cachedUuid) {
        const name = state.uuidToPlayer.get(cachedUuid)
        if (name) return name
      }
    }
  }
  if (event.player && !event.player.startsWith('Blockhead#')) {
    return event.player
  }
  return null
}

/**
 * Update shared mapping state from an ActivityEvent.
 * Writes to: playerToBlockheads, blockheadToPlayer, playerToUuid, uuidToPlayer,
 * blockheadToOwnerUuid, blockheadToUuid.
 */
export const updateMappingsFromEvent = (event: ActivityEvent, state: MappingState) => {
  if (typeof event.blockheadId !== 'number') return

  // playerAccount + playerUUID → register bidirectional name/uuid
  if (event.playerAccount && event.playerUUID && event.playerAccount !== '?') {
    state.playerToUuid.set(event.playerAccount, event.playerUUID)
    state.uuidToPlayer.set(event.playerUUID, event.playerAccount)
  }

  // blockheadId + playerAccount → register owner
  const ownerName = event.playerAccount ?? (event.player && !event.player.startsWith('Blockhead#') ? event.player : null)
  if (ownerName && ownerName !== '?') {
    if (state.blockheadToPlayer) state.blockheadToPlayer.set(event.blockheadId, ownerName)
    const set = state.playerToBlockheads.get(ownerName) ?? new Set<number>()
    set.add(event.blockheadId)
    state.playerToBlockheads.set(ownerName, set)
    const knownUuid = state.playerToUuid.get(ownerName)
    if (knownUuid && state.blockheadToOwnerUuid) {
      state.blockheadToOwnerUuid.set(event.blockheadId, knownUuid)
    }
  }

  // blockheadId + playerUUID → attach via UUID
  if (event.playerUUID) {
    if (state.blockheadToUuid) state.blockheadToUuid.set(event.blockheadId, event.playerUUID)
    if (state.blockheadToOwnerUuid) state.blockheadToOwnerUuid.set(event.blockheadId, event.playerUUID)
    attachBlockheadsToUuid(event.playerUUID, [event.blockheadId], state)
  }
}

/**
 * Query LMDB for blockheads owned by a player UUID, attach results to shared state.
 * Falls back to cached mappings if daemon fails.
 */
export const listBlockheadsForPlayerByUuid = async (playerUuid: string): Promise<number[]> => {
  let ids: number[] = []
  try {
    ids = await BlockheadService.getBlockheadsForPlayer(playerUuid)
  } catch {
    // Daemon failed
  }
  if (!ids || ids.length === 0) {
    const fallbackSet = getBlockheadsForUuid(playerUuid, sharedMappingState)
    if (fallbackSet && fallbackSet.size > 0) {
      return Array.from(fallbackSet)
    }
  }
  attachBlockheadsToUuid(playerUuid, ids, sharedMappingState)
  return ids
}

/**
 * Query LMDB for blockheads and attach with full player name + UUID mappings.
 */
export const listAndMapBlockheads = async (playerName: string, playerUuid: string): Promise<number[]> => {
  const ids = await listBlockheadsForPlayerByUuid(playerUuid)
  if (ids && ids.length > 0) {
    attachBlockheadsToPlayer(playerName, playerUuid, ids, sharedMappingState)
  }
  return ids
}
