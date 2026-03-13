/**
 * Player and Blockhead — per-player state, single source of truth.
 *
 * Replaces the scattered Maps in sharedMappingState, ActivityContext,
 * and QuestContext (playerToBlockheads, blockheadToPlayer, lastCoords, etc.).
 *
 * One Player owns N Blockheads (up to 5 per world). Each Blockhead tracks
 * its own position. Player-level helpers aggregate across all blockheads.
 */

export class Blockhead {
  /** In-game character name (e.g. "BlueSky"). Null until seen in an event. */
  name: string | null = null
  /** Last known position — overwritten on every PLAYER_MOVE. No history kept. */
  lastCoords: { x: number; y: number; time: number } | null = null

  constructor(public readonly id: number) {}
}

export class Player {
  uuid: string
  isOnline = false
  lastActivity = 0

  /**
   * All known blockheads for this player, keyed by blockheadId.
   * A player can have up to 5 blockheads in a world.
   */
  readonly blockheads = new Map<number, Blockhead>()

  /** The blockhead that most recently generated an event for this player. */
  lastBlockheadId: number | null = null

  /** User-selected blockhead for multi-BH players (set via /track command). */
  trackedBlockheadId: number | null = null

  /** Blockhead name seen on join before ID is resolved. */
  pendingBlockheadName: string | null = null

  /** Primary blockhead name once resolved. */
  primaryBlockheadName: string | null = null

  /** Dialogue lines queued after a kick — drained on next rejoin after 5s. */
  pendingKickDialogue: string[] | null = null

  constructor(public readonly name: string, uuid: string) {
    this.uuid = uuid
  }

  /**
   * Coords for the most recently active blockhead.
   * For per-blockhead coords use player.blockheads.get(id).lastCoords directly.
   */
  get mostRecentCoords(): { x: number; y: number; time: number } | null {
    // For multi-BH players, prefer explicitly tracked blockhead
    if (this.blockheads.size > 1 && this.trackedBlockheadId != null) {
      const tracked = this.blockheads.get(this.trackedBlockheadId)
      if (tracked?.lastCoords) return tracked.lastCoords
    }
    if (this.lastBlockheadId != null) {
      return this.blockheads.get(this.lastBlockheadId)?.lastCoords ?? null
    }
    for (const bh of this.blockheads.values()) {
      if (bh.lastCoords) return bh.lastCoords
    }
    return null
  }

  /** All blockhead IDs as a Set — for code that expects the old Set<number> shape. */
  get blockheadIds(): Set<number> {
    return new Set(this.blockheads.keys())
  }
}
