# Architecture

## System Overview

```
┌───────────┐         ┌────────────────┐         ┌───────────────────┐
│  Players  │◄──UDP──►│  Proxy (Java)  │◄──UDP──►│ Blockheads Server │
└───────────┘         └───────┬────────┘         └───────────────────┘
                              │
                    writes events.jsonl
                              │
                              ▼
                     ┌────────────────┐
                     │   Bot (Node)   │
                     │                │
                     │  - Quests      │
                     │  - Shop        │
                     │  - Teleport    │
                     │  - Jobs        │
                     │  - Bank        │
                     │  - Activity    │
                     └───────┬────────┘
                             │
                   JSON over stdin/stdout
                             │
                             ▼
                    ┌─────────────────┐
                    │  Daemon (Python) │
                    │  (persistent)    │
                    └───────┬─────────┘
                            │
                      LMDB read/write
                            │
                            ▼
                    ┌─────────────────┐
                    │   World Save    │
                    │   (LMDB files)  │
                    └─────────────────┘
```

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
- `blockhead-service.ts` — Python daemon IPC (manages LMDB operations)
- `linux-api.ts` — Watches `blockheads.log` for join/leave/chat events
- `private-message.ts` — Writes messages to JSONL for the proxy to deliver
- `shared-queue.ts` — FIFO task serialization to prevent race conditions

### Daemon (Python, `tools/`)

A persistent Python process that keeps the LMDB world save open for fast operations.

**Why a daemon?** Each Python invocation takes ~200ms to open LMDB. The daemon keeps it open and responds in ~1-5ms per operation. It also batches writes — 10 separate saves become 1 batched save.

**Protocol:** JSON over stdin/stdout. One JSON object per line.

**Read operations:**
- `list-blockheads` — Get blockhead IDs for a player UUID
- `inventory-counts` — Get item counts for a blockhead
- `get-blockhead-position` — Get X/Y coordinates
- `get-full-index` — Full player→blockheads mapping

**Write operations (deferred save):**
- `give-item` — Add item to blockhead inventory
- `take-item` — Remove item from blockhead inventory
- `teleport-blockhead` — Set blockhead X/Y position
- `apply-quest-items` — Atomic remove + give (for quest completion)

**Control:**
- `save` / `save-if-dirty` — Force LMDB flush
- `reload` — Re-read from disk
- `ping` / `status` — Health checks

## Data Flow: Key Operations

### Quest Completion

```
1. Player picks up item → Proxy detects ITEM_PICKUP → writes event to events.jsonl
2. Bot's quest-system reads event → checks inventory via daemon
3. Daemon returns inventory counts → bot checks against quest requirements
4. All requirements met → bot calls daemon apply-quest-items
5. Daemon removes consumed items + gives rewards (deferred save)
6. Bot kicks player (clears game server's RAM cache)
7. Daemon auto-saves within 10 seconds
8. Player reconnects → sees new inventory state from LMDB
```

### Teleport (/wild, /tpa, /spawn)

```
1. Player types /wild in chat → Proxy forwards to bot via command_events.jsonl
2. Bot checks balance, cooldown → calls wild_locations.py for coordinates
3. Bot kicks player FIRST (critical: clears game server's position cache)
4. Bot calls daemon teleport-blockhead (writes new X/Y to LMDB)
5. Daemon saves (fast, <100ms, completes before player can reconnect)
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
- Daemon's `list-blockheads` command (UUID → blockhead IDs)
- Proxy's `BlockheadsData` packet (blockhead ID → player name)
- Proxy's `ClientInformation` packet (player name → UUID)

### Cache Coherency

The game server, bot, and daemon all cache player data differently:

| Cache | Scope | Cleared By |
|-------|-------|------------|
| Game server RAM | Position, inventory (per-player) | Player disconnect (kick) |
| Bot mappings | Player↔blockhead maps | `sharedMappingState` refresh |
| Daemon GameSave | Full LMDB snapshot | `reload` command |
| Daemon targeted ops | Individual LMDB keys | Auto-synced after write |

**Rule:** For LMDB writes to take effect, the player must be offline (kicked) when the write happens, OR the player must reconnect after the write.

### Concurrency Control

- `MAX_CONCURRENT_REQUESTS = 4` in `blockhead-service.ts` — Limits simultaneous daemon requests to prevent stdout buffer overflow
- `shared-queue.ts` — FIFO task queue for serializing operations that must not interleave (shop purchases, quest rewards)
- Daemon batches writes with auto-save every 10 seconds

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

## IPC Protocol (Daemon)

The daemon reads JSON commands from stdin and writes JSON responses to stdout, one per line. Responses are matched to requests in FIFO order.

**Startup:** Daemon sends `{"ready": true, "autoSaveInterval": 10}` when initialized.

**Request format:**
```json
{"op": "give-item", "blockheadId": 123, "itemId": 88, "count": 1}
```

**Response format:**
```json
{"ok": true}
```

**Error format:**
```json
{"ok": false, "error": "Blockhead not found"}
```

**Batch operations:**
```json
{"op": "batch", "commands": [
  {"op": "give-item", "blockheadId": 123, "itemId": 88, "count": 1},
  {"op": "take-item", "blockheadId": 123, "itemId": 34, "count": 1}
]}
```
