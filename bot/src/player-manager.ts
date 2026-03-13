/**
 * PlayerManager — central registry for all player and blockhead state.
 *
 * Single source of truth replacing:
 *   sharedMappingState (playerToBlockheads, playerToUuid, uuidToPlayer,
 *                        blockheadToPlayer, blockheadToUuid, blockheadToOwnerUuid)
 *   ActivityContext    (onlinePlayers, playerLastActivity, lastCoords, lastPlayerCoords)
 *   QuestContext       (same maps + playerToLastBlockhead, blockheadNameToId, etc.)
 *
 * Lookups:
 *   get(name)            O(1)
 *   getByUuid(uuid)      O(1)
 *   getByBlockheadId(id) O(1)
 *
 * On leave: all blockhead reverse-index entries cleaned up in one place.
 */

import { ActivityEvent } from './extensions/types/shared-types'
import { Player, Blockhead } from './player'

export class PlayerManager {
  private readonly _byName        = new Map<string, Player>()
  private readonly _byUuid        = new Map<string, Player>()
  private readonly _byBlockheadId = new Map<number, Player>()

  /** Global blockhead name → blockheadId index (blockhead names are server-unique). */
  readonly blockheadNameIndex = new Map<string, number>()

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  get(name: string): Player | undefined {
    return this._byName.get(name)
  }

  getByUuid(uuid: string): Player | undefined {
    return this._byUuid.get(uuid)
  }

  getByBlockheadId(id: number): Player | undefined {
    return this._byBlockheadId.get(id)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Get existing player or create a new one. Does not mark online.
   */
  getOrCreate(name: string, uuid: string): Player {
    let player = this._byName.get(name)
    if (!player) {
      player = new Player(name, uuid)
      this._byName.set(name, player)
    }
    if (uuid && player.uuid !== uuid) {
      player.uuid = uuid
    }
    if (uuid) this._byUuid.set(uuid, player)
    return player
  }

  /**
   * Mark player online, update UUID mapping, set lastActivity.
   * Creates player record if first seen.
   */
  setOnline(name: string, uuid: string): Player {
    const player = this.getOrCreate(name, uuid)
    player.isOnline = true
    player.lastActivity = Date.now()
    return player
  }

  /**
   * Mark player offline and clean up all blockhead reverse-index entries.
   * All cleanup in one place — no more scattered map.delete() calls on leave.
   */
  setOffline(name: string): void {
    const player = this._byName.get(name)
    if (!player) return
    for (const bhId of player.blockheads.keys()) {
      this._byBlockheadId.delete(bhId)
    }
    player.blockheads.clear()
    player.isOnline = false
    player.lastBlockheadId = null
  }

  // ---------------------------------------------------------------------------
  // Blockhead indexing
  // ---------------------------------------------------------------------------

  /**
   * Attach blockhead IDs to a player and register in the reverse index.
   */
  attachBlockheads(player: Player, ids: number[]): void {
    for (const id of ids) {
      if (!player.blockheads.has(id)) {
        player.blockheads.set(id, new Blockhead(id))
      }
      this._byBlockheadId.set(id, player)
    }
  }

  /**
   * Index a single blockhead ID → player (by name). Creates Blockhead if new.
   */
  indexBlockhead(id: number, playerName: string): void {
    const player = this._byName.get(playerName)
    if (!player) return
    if (!player.blockheads.has(id)) {
      player.blockheads.set(id, new Blockhead(id))
    }
    this._byBlockheadId.set(id, player)
  }

  /**
   * Index a single blockhead ID → player (by uuid). Creates Blockhead if new.
   */
  indexBlockheadByUuid(id: number, uuid: string): void {
    const player = this._byUuid.get(uuid)
    if (!player) return
    if (!player.blockheads.has(id)) {
      player.blockheads.set(id, new Blockhead(id))
    }
    this._byBlockheadId.set(id, player)
  }

  // ---------------------------------------------------------------------------
  // Iteration
  // ---------------------------------------------------------------------------

  /** Iterate all known players. */
  *all(): IterableIterator<Player> {
    yield* this._byName.values()
  }

  /** Iterate online players. */
  *online(): IterableIterator<Player> {
    for (const player of this._byName.values()) {
      if (player.isOnline) yield player
    }
  }

  /** Online player names as an array. */
  onlineNames(): string[] {
    const names: string[] = []
    for (const player of this._byName.values()) {
      if (player.isOnline) names.push(player.name)
    }
    return names
  }

  // ---------------------------------------------------------------------------
  // Event helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve player name from an ActivityEvent.
   * Priority: playerAccount → UUID lookup → blockheadId lookup → event.player fallback.
   */
  resolveEventPlayer(event: ActivityEvent): string | null {
    if (event.playerAccount && event.playerAccount !== '?') return event.playerAccount
    if (event.playerUUID) {
      const p = this._byUuid.get(event.playerUUID)
      if (p) return p.name
    }
    if (typeof event.blockheadId === 'number') {
      const p = this._byBlockheadId.get(event.blockheadId)
      if (p) return p.name
    }
    if (event.player && !event.player.startsWith('Blockhead#')) return event.player
    return null
  }

  /**
   * Update mappings from an ActivityEvent (playerAccount + playerUUID + blockheadId).
   */
  updateFromEvent(event: ActivityEvent): void {
    if (typeof event.blockheadId !== 'number') return

    const name = (event.playerAccount && event.playerAccount !== '?')
      ? event.playerAccount
      : (event.player && !event.player.startsWith('Blockhead#') ? event.player : null)

    if (name && event.playerUUID) {
      const player = this.getOrCreate(name, event.playerUUID)
      this.indexBlockhead(event.blockheadId, name)
      if (event.playerUUID) this._byUuid.set(event.playerUUID, player)
    } else if (event.playerUUID) {
      this.indexBlockheadByUuid(event.blockheadId, event.playerUUID)
    } else if (name) {
      this.indexBlockhead(event.blockheadId, name)
    }
  }

  // ---------------------------------------------------------------------------
  // Pruning (safety valve — PlayerManager doesn't actively prune, but callers can)
  // ---------------------------------------------------------------------------

  pruneBlockheadNameIndex(maxSize: number): void {
    if (this.blockheadNameIndex.size <= maxSize) return
    const entries = Array.from(this.blockheadNameIndex.entries())
    this.blockheadNameIndex.clear()
    for (const [k, v] of entries.slice(-maxSize)) {
      this.blockheadNameIndex.set(k, v)
    }
  }
}

export const playerManager = new PlayerManager()
