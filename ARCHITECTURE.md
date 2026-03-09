# Architecture

## System Overview

```
                              events.jsonl
              ┌───────────────────────────────────────┐
              │                                       ▼
┌──────────┐  │  ┌─────────────────┐  UDP   ┌──────────────────────────┐
│ Players  │◄────►│  Proxy (Java)   │◄──────►│   Blockheads Server      │
└──────────┘  │  │                 │        │                          │
        UDP   │  │  - ENet relay   │        │  writes blockheads.log ──┼──┐
              │  │  - packet decode│        │                          │  │
              │  │  - msg inject ◄─┼──┐     │  reads/writes            │  │
              │  └─────────────────┘  │     │  World Save (LMDB) ◄─────┼──┼──┐
              │                       │     └──────────────────────────┘  │  │
              │           private_messages.jsonl                           │  │
              │                       │    kick/chat via input pipe        │  │
              │                       └──────────────┐                    │  │
              │                                      │                    │  │
              ▼                                      │◄───────────────────┘  │
   ┌──────────────────────────────────────────────┐  │  blockheads.log        │
   │  Bot (Node.js)                               │  │                        │
   │                                              │  │                        │
   │  linux-api.ts      — tails blockheads.log ◄──┘  │                        │
   │  activity-monitor  — processes events.jsonl      │                        │
   │  quest-system      — inventory polling, rewards  │                        │
   │  teleport-system   — /wild /tpa /spawn /tp       │                        │
   │  virtual-bank      — token economy               │                        │
   │  shop-system       — item purchases              │                        │
   │  job-system        — hiring, daily pay           │  spawns per-op         │
   │  whisper           — private messaging           │──────────────┐         │
   └──────────────────────────────────────────────────┘              ▼         │
                                                           ┌──────────────────┐│
                                                           │  Python Tools    ││
                                                           │  world_manager   │◄┘
                                                           │  inventory_reader│ direct LMDB
                                                           └──────────────────┘ read/write
```

The World Save (LMDB) is the game server's own database. The bot's Python tools access it directly — reading inventory and position data, and writing changes (give/take items, teleport). This only works safely because the bot kicks the player first, clearing the game server's in-memory cache before any write.

## Components

### Proxy (Java, `proxy/`)

An ENet UDP proxy that sits between players and the game server. It:

1. **Intercepts all packets** — Decodes game protocol (movement, inventory, chat, etc.)
2. **Logs events** — Writes structured JSON events to `blockheads_events.jsonl`
3. **Enforces security** — Blocks IPs, detects exploits, logs client fingerprints
4. **Delivers private messages** — Watches a JSONL file for messages, injects them into the game's chat stream
5. **Broadcasts via UDS** — Pushes events over a Unix domain socket for real-time consumers

Key classes:
- `BHInterceptor` — Main proxy loop, packet routing
- `EventLogger` — Thread-safe JSONL writer with log rotation (500MB)
- `SecurityHandler` — IP blocking, malformed packet forensics
- `PlayerRegistry` — Tracks blockhead-to-player mappings from packets
- `ChatCommandHandler` — Extracts `/commands` from chat, maps player names
- `PrivateMessageWatcher` — File watcher for outbound private messages

### Bot (Node.js/TypeScript, `bot/`)

The bot watches the game server log and event files, responding to player actions. It's built on the `@bhmb/bot` extension framework.

**Entry point:** `mac.ts` — Initializes the Linux API, loads all extensions, wires event callbacks.

**Extensions:**
- `activity-monitor` — Tracks player coordinates, detects forbidden items, manages player-blockhead mappings
- `quest-system` — Quest progression, inventory polling, reward delivery
- `virtual-bank` — Token economy (balance, daily rewards, transactions)
- `shop-system` — Item purchases using tokens
- `teleport-system` — `/wild`, `/tpa`, `/spawn`, `/tp` commands
- `job-system` — Job applications, hiring, daily pay
- `whisper` — Private messaging between players
- `commands-help` — `/help` command

**Key modules:**
- `config.ts` — Central configuration (loads `config/config.json` with env var overrides)
- `blockhead-service.ts` — Spawns Python per-operation for all LMDB reads/writes
- `linux-api.ts` — Watches `blockheads.log` for join/leave/chat events
- `private-message.ts` — Writes messages to JSONL for the proxy to deliver
- `shared-queue.ts` — FIFO task serialization to prevent race conditions

### Python Tools (`tools/`)

Stateless Python scripts invoked per-operation by the bot. Each spawn opens LMDB, performs the operation, and exits. No persistent process.

**Why per-op spawns instead of a persistent daemon?**
The game server also writes to LMDB (inventory changes, position updates). A persistent daemon holding LMDB open would see stale data after any game server write. Per-op spawns always read fresh from disk.

**Latency:** ~80-150ms Python startup overhead. Acceptable because:
- Inventory polling runs on a 15s interval
- Give/take/teleport operations kick the player first (~3s before reconnect)

**`world_manager.py`** — Write operations and position reads (uses `gameSave`/`lmdb` directly):
- `--give-item` — Add item to blockhead inventory
- `--take-item` — Remove item from blockhead inventory
- `--teleport-blockhead` — Set blockhead X/Y position
- `--apply-quest-items` — Atomic remove + give (for quest completion)
- `--get-blockhead-position` — Read X/Y coordinates
- `--list-blockheads-with-names` — Read blockhead IDs and in-game character names

**`inventory_reader.py`** — Fast read-only inventory access (opens LMDB directly, no GameSave):
- `--list-blockheads` — Get blockhead IDs for a player UUID
- `--blockhead-inventory-counts` — Get item counts for one blockhead
- `--inventory-counts` — Get combined item counts for all blockheads of a player
- `--inventory-counts-batch` — Get all online players' inventories in one spawn

## Data Flow: Key Operations

### Quest Completion

```
1. Player picks up item → Proxy detects ITEM_PICKUP → writes event to events.jsonl
2. Bot's quest-system reads event → checks inventory via inventory_reader.py spawn
3. inventory_reader returns counts → bot checks against quest requirements
4. All requirements met → bot kicks player FIRST (clears game server's RAM cache)
5. Bot calls world_manager.py --apply-quest-items
6. Python opens LMDB, removes consumed items + gives rewards atomically, closes
7. Player reconnects → sees new inventory state from LMDB
```

### Teleport (/wild, /tpa, /spawn)

```
1. Player types /wild in chat → Proxy forwards to bot via command_events.jsonl
2. Bot checks balance, cooldown → calls wild_locations.py for coordinates
3. Bot kicks player FIRST (critical: clears game server's position cache)
4. Bot calls world_manager.py --teleport-blockhead (writes new X/Y to LMDB)
5. Python spawn completes in ~100ms, well before player can reconnect (~3s)
6. Player reconnects → game server reads position from LMDB → player is at new location
```

**Why kick-before-save?** The game server caches player positions in RAM while they're online. Writing to LMDB while the player is connected does nothing — the cache overwrites it. By kicking first, we clear the cache. The save completes before the player can reconnect (~3 seconds minimum).

### Private Messages

```
1. Bot writes { target, message } to private_messages.jsonl
2. Proxy's PrivateMessageWatcher detects new line
3. Proxy looks up target player's clientId via ChatCommandHandler
4. Proxy injects a SERVER: chat message visible only to that client
```

## Key Concepts

### Player vs Blockhead

In The Blockheads, one player account can own up to 5 blockheads (characters) in a world. Most game operations reference blockhead IDs (integers), not player names.

**Mapping chain:** Player Name → Player UUID → Blockhead IDs

The bot maintains bidirectional mappings in `helpers/blockhead-mapping.ts`. These are populated from:
- `inventory_reader.py --list-blockheads` (UUID → blockhead IDs, called on player join)
- Proxy's `BlockheadsData` packet (blockhead ID → player name)
- Proxy's `ClientInformation` packet (player name → UUID)

### Cache Coherency

The game server and bot cache player data differently:

| Cache | Scope | Cleared By |
|-------|-------|------------|
| Game server RAM | Position, inventory (per-player) | Player disconnect (kick) |
| Bot mappings | Player↔blockhead maps | `sharedMappingState` refresh on join |

**Rule:** For LMDB writes to take effect, the player must be offline (kicked) when the write happens, OR the player must reconnect after the write.

### Concurrency Control

- `shared-queue.ts` — FIFO task queue for serializing operations that must not interleave (shop purchases, quest rewards)
- Python spawns are naturally isolated — each gets its own LMDB transaction

## Extension System

Extensions are loaded by `mac.ts` using the `@bhmb/bot` framework:

```typescript
MessageBot.registerExtension('my-extension', (ex) => {
  // ex.bot — send messages to the game server
  // ex.world.onMessage.sub() — listen for chat messages
  // ex.world.onJoin.sub() — listen for player joins
  // ex.world.onLeave.sub() — listen for player leaves
  // ex.storage — persistent key-value storage

  ex.remove = () => {
    // Cleanup when extension is unloaded
  }
})
```

Extensions communicate via the `helpers/extension-api.ts` export system — each extension registers its public API, and other extensions look it up by name.

## world_manager.py CLI Reference

All operations share `--save-path <path>` as a required argument.

```bash
# Read operations (inventory_reader.py — fast, read-only)
python3 inventory_reader.py --save-path <path> --list-blockheads --player-uuid <uuid>
python3 inventory_reader.py --save-path <path> --blockhead-inventory-counts --blockhead-id <id> --player-uuid <uuid>
python3 inventory_reader.py --save-path <path> --inventory-counts --player-uuid <uuid>
python3 inventory_reader.py --save-path <path> --inventory-counts-batch --player-uuids-json '[...]'

# Read operations (world_manager.py)
python3 world_manager.py --save-path <path> --get-blockhead-position --blockhead-id <id> --player-uuid <uuid>
python3 world_manager.py --save-path <path> --list-blockheads-with-names --player-uuid <uuid>

# Write operations (world_manager.py)
python3 world_manager.py --save-path <path> --give-item --blockhead-id <id> --item-id <id> --count <n> [--player-uuid <uuid>] [--basket-only]
python3 world_manager.py --save-path <path> --take-item --blockhead-id <id> --item-id <id> --count <n> [--player-uuid <uuid>]
python3 world_manager.py --save-path <path> --teleport-blockhead --blockhead-id <id> --player-uuid <uuid> --x <n> --y <n>
python3 world_manager.py --save-path <path> --apply-quest-items --blockhead-id <id> --player-uuid <uuid> --remove-items-json '[...]' --give-items-json '[...]'
```

All operations output JSON to stdout and exit 0 on success, 1 on failure.
