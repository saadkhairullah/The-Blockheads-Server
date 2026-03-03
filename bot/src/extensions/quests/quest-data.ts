import { Quest } from './quest-types'

// ─────────────────────────────────────────────────────────────────────────────
// QUEST DATA — Define your server's quest chain here.
//
// HOW IT WORKS:
//   - Quests form a linked list via nextQuestId (player completes quest 1, moves to quest 2, etc.)
//   - Each quest has requirements that must ALL be met before it completes.
//   - Rewards are given on completion (items delivered via LMDB or tokens via virtual bank).
//
// QUEST TYPES (set via requirements[].type):
//   'collect'  — Player must have N of an item in their inventory.
//                Fields: itemId, itemName, count, consume (optional: removes items on completion)
//                Alternative: anyItemIds (array) — any of these IDs satisfies the requirement
//   'travel'   — Player must reach specific world coordinates.
//                Fields: x, y, radius (how close they need to get, default 10)
//                Optional: hideCoords (don't show exact coords in quest text)
//                Note: x is optional for y-only travel (e.g. "reach lava layer")
//   'kill'     — Player must get arena kills (PvP, within configured arena radius).
//                Fields: killCount
//
// REWARD TYPES (set via rewards[].type):
//   'tokens'   — Virtual currency. Fields: type: 'tokens', count
//   'item'     — In-game item (default if type omitted). Fields: itemId, itemName, count
//
// OPTIONAL FIELDS ON QUESTS:
//   dialogue    — String or string[] of messages sent privately after completion (1s apart)
//   lmdbDelivery — Force LMDB kick-first delivery for item rewards
//   nextQuestId — ID of the next quest in the chain (omit for final quest)
//
// ITEM IDS: Refer to tools/itemType.py for the full item ID -> name mapping.
//
// EXAMPLE CONFIG: The quests below demonstrate all three quest types.
// Replace them with your own server's storyline and coordinates.
// ─────────────────────────────────────────────────────────────────────────────

export const QUESTS: Quest[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // 1 — Welcome Quest (travel type)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: '1',
    title: 'Welcome to Town',
    description: 'You\'ve just arrived! Head to the town center to get started.',
    requirements: [
      { type: 'travel', x: 0, y: 0, radius: 20 }
    ],
    rewards: [
      { itemId: 12, itemName: 'Basket', count: 1 },
      { itemId: 28, itemName: 'Clay', count: 20 },
      { type: 'tokens', count: 50 }
    ],
    dialogue: 'Welcome! You\'ve found the town center. Here\'s some supplies to get you started.',
    nextQuestId: '2'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2 — Gathering Quest (collect type)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: '2',
    title: 'Gather Resources',
    description: 'Craft your first Stone Pickaxe to begin mining.',
    requirements: [
      { type: 'collect', itemId: 34, itemName: 'Stone Pickaxe', count: 1 }
    ],
    rewards: [
      { itemId: 47, itemName: 'Oil Lanterns', count: 10 },
      { type: 'tokens', count: 100 }
    ],
    nextQuestId: '3'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3 — Arena Quest (kill type)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: '3',
    title: 'Arena Champion',
    description: 'Head to the arena and defeat another player in combat.',
    requirements: [
      { type: 'kill', killCount: 1 }
    ],
    rewards: [
      { itemId: 88, itemName: 'Diamond', count: 1 },
      { type: 'tokens', count: 200 }
    ],
    nextQuestId: '4'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4 — Combined Quest (collect + travel + consume)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: '4',
    title: 'Special Delivery',
    description: 'Craft 5 Iron Ingots and bring them to the blacksmith. The ingots will be consumed on delivery.',
    requirements: [
      { type: 'collect', itemId: 65, itemName: 'Iron Ingot', count: 5, consume: true },
      { type: 'travel', x: 100, y: 500, radius: 15 }
    ],
    rewards: [
      { itemId: 68, itemName: 'Iron Sword', count: 1 },
      { type: 'tokens', count: 300 }
    ],
    dialogue: [
      'Blacksmith: "Fine ingots! Let me forge something special for you."',
      'Blacksmith: "Here — an Iron Sword. You\'ve earned it."'
    ],
    lmdbDelivery: true,
    // No nextQuestId — end of the example chain.
    // Completing this quest unlocks /daily (if configured in virtual-bank).
  },
]
