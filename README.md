# Blockheads Server Tools

A full server management framework for [The Blockheads](https://theblockheads.net/) Linux servers. Includes a TypeScript bot with quests, shops, teleportation, jobs, and PvP arena tracking — a Java packet interceptor/proxy for real-time event streaming — and Python tools for direct world save manipulation via LMDB.

The bot is designed as a **framework**. You can run the included deployment as-is, or build a hosting service on top that manages multiple worlds, each with their own config, extensions, and quest chains — without a rebuild per world.

---

## How It Works

```
Players (UDP)
    │
    ▼
┌──────────────────────────────┐
│  Java Proxy  (proxy/)        │  Intercepts all game traffic.
│                              │  Decodes packets, enforces bans,
│  - ENet relay                │  emits structured events via UDS.
│  - packet decode             │  Routes private messages to clients.
│  - security enforcement      │
│  - UDS event stream          │
└──────────┬───────────────────┘
           │  Unix Domain Socket (events)
           ▼
┌──────────────────────────────┐
│  Node.js Bot  (bot/)         │  Processes game events. Runs
│                              │  extensions (quests, shop, bank,
│  - event-dispatcher          │  teleport, jobs). Sends commands
│  - linux-api (log watcher)   │  back to the server via input pipe.
│  - extensions                │
└──────────┬───────────────────┘
           │  Unix Domain Socket (LMDB ops)
           ▼
┌──────────────────────────────┐
│  Python Daemon  (tools/)     │  Keeps the world LMDB database
│                              │  open persistently. Handles all
│  - uds_daemon.py             │  read/write ops (give items,
│  - gameSave.py               │  teleport, read inventory).
└──────────┬───────────────────┘
           │
           ▼
  World Save (LMDB)
```

The proxy sits in front of the game server. Players connect to the proxy port (default 15153) and it relays traffic to the actual server (15151) while intercepting packets. The bot watches the proxy's event stream and the server's log file, responding to player actions in real time. World save operations (giving items, teleporting, reading inventory) go through a persistent Python daemon that keeps the LMDB database open for fast access — typically 1–5ms per operation.

---

## Prerequisites

- **Linux** — the Blockheads server binary is Linux-only
- **64-bit Python 3.8+** — LMDB reserves 6GB of virtual address space; 32-bit will crash
- **Node.js 18+**
- **Java 21** — the proxy uses preview features; exactly Java 21 required
- **The Blockheads server binary** running on the same machine

---

## Quick Start (Single Server)

### 1. Clone and configure

```bash
git clone https://github.com/saadkhairullah/blockheads-server-tools.git
cd blockheads-server-tools

cp config/config.example.json config/config.json
```

Open `config/config.json` and fill in:

| Field | Description |
|-------|-------------|
| `server.user` | Your in-game username (used as owner) |
| `server.pass` | Server admin password |
| `server.worldId` | The UUID directory name inside your saves folder |
| `paths.worldSave` | Full path to that UUID directory (trailing slash recommended) |

The saves directory is typically `~/GNUstep/Library/ApplicationSupport/TheBlockheads/saves/` on Linux.

### 2. Add yourself as admin

Add your in-game username (uppercase) to `<paths.worldSave>/adminlist.txt`, one name per line. Admin commands won't work until this is done.

### 3. Install dependencies

```bash
# Bot
cd bot && npm install && npm run build && cd ..

# Python tools
cd tools && pip install -r requirements.txt && cd ..

# Java proxy (no build step needed — Gradle runs it directly)
# For production, run: cd proxy && ./gradlew :interceptor:installDist && cd ..
```

### 4. Compile the item injection library

The bot gives items to players via an `LD_PRELOAD` hook that adds `/give` and `/give-id` commands to the server's stdin:

```bash
sudo apt install gobjc gnustep-devel
gcc -shared -fPIC -o blockheads_give.so blockheads_give.c -lobjc -ldl -lpthread
```

### 5. Start the server

```bash
nohup bash -c '
  tail -f /worlds/my-world/data/blockheads_input | LD_PRELOAD=/opt/bhs/blockheads_give.so /path/to/blockheads_server171 -o abc-1234-your-uuid-here -s 67 -m 32 --owner YourUsername --no-exit 2>&1 | tee /worlds/my-world/data/blockheads.log' &
```

- `tail -f blockheads_input` — how the bot sends kick/chat commands to the server
- `tee blockheads.log` — how the bot detects joins, leaves, and chat
- The paths must match `paths.inputPipe` and `paths.serverLog` in your config

### 6. Start the proxy and bot

```bash
# Proxy
proxy/interceptor/build/install/interceptor/bin/interceptor \
  -P 15153 -S 15151 \
  --event-socket /tmp/bh-events.sock \
  --command-socket /tmp/bh-commands.sock

# Bot
cd bot && npm run mac
```

Or use PM2 for production:

```bash
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js
```

---

## Building a Hosting Service

### Per-World Process Topology

Every world needs four running processes. They are completely independent between worlds — nothing is shared.

```
World A                                   World B
───────────────────────────────────────   ───────────────────────────────────────
blockheads_server171 -o <uuid-a>          blockheads_server171 -o <uuid-b>
  UDP :15151  stdin: /worlds/a/input        UDP :15161  stdin: /worlds/b/input

Java Proxy  -P 15153 -S 15151             Java Proxy  -P 15163 -S 15161
  UDS events:   /tmp/bh-events-a.sock        UDS events:   /tmp/bh-events-b.sock
  UDS commands: /tmp/bh-commands-a.sock      UDS commands: /tmp/bh-commands-b.sock

Python Daemon  (auto-spawned by bot)      Python Daemon  (auto-spawned by bot)
  LMDB: /worlds/a/save/                    LMDB: /worlds/b/save/
  UDS: /tmp/bh-wm-a.sock                   UDS: /tmp/bh-wm-b.sock

Node.js Bot  (one process per world)      Node.js Bot  (one process per world)
  config: /worlds/a/config.json             config: /worlds/b/config.json
```

**The Python daemon** is spawned automatically by `BlockheadsBot.start()`. You don't manage it — it comes up and goes down with the bot, and auto-restarts if it crashes. You only need to make sure `paths.wmSock` is unique per world.

**The Java proxy** must be launched separately as its own process per world. Each proxy binds to its own UDP port pair and its own UDS event socket.

**The Node.js bot** must currently run as one process per world. The event dispatcher (`uds-client.ts` + `event-dispatcher.ts`) uses a module-level singleton that connects to one proxy's UDS socket. If you ran two `BlockheadsBot` instances in the same process, they'd both receive events from the same proxy — the wrong one for one of them. Use one Node.js process per world, managed by PM2 or systemd.

> **Note:** Removing the event dispatcher singleton so multiple `BlockheadsBot` instances can coexist in one process is the remaining architectural work. The config, extensions, and LMDB daemon layers are already fully isolated.

### Port and Socket Naming Convention

A clean convention for N worlds on one machine:

| World | Game port | Proxy port | LMDB socket | Event socket | Command socket |
|-------|-----------|------------|-------------|--------------|----------------|
| world-1 | 15151 | 15153 | `/tmp/bh-wm-1.sock` | `/tmp/bh-events-1.sock` | `/tmp/bh-commands-1.sock` |
| world-2 | 15161 | 15163 | `/tmp/bh-wm-2.sock` | `/tmp/bh-events-2.sock` | `/tmp/bh-commands-2.sock` |
| world-3 | 15171 | 15173 | `/tmp/bh-wm-3.sock` | `/tmp/bh-events-3.sock` | `/tmp/bh-commands-3.sock` |

Game ports and proxy ports must not conflict. The LMDB socket and event socket just need unique file paths.

### Per-World Config

Each world gets its own `config.json`. The fields that **must** differ per world:

```json
{
  "server": {
    "worldId": "abc-123",
    "worldName": "My World",
    "user": "owner_username",
    "pass": "admin_password"
  },
  "paths": {
    "worldSave": "/worlds/abc-123/save/",
    "dataDir":   "/worlds/abc-123/data/",
    "questData": "/worlds/abc-123/quests.json",
    "serverLog": "/worlds/abc-123/data/blockheads.log",
    "inputPipe": "/worlds/abc-123/data/blockheads_input",
    "proxyCommandSock": "/tmp/bh-commands-abc123.sock",
    "wmSock": "/tmp/bh-wm-abc123.sock"
  }
}
```

### Starting a World (PM2 Example)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'bot-world-1',
      script: 'build/mac.js',
      cwd: '/opt/blockheads/bot',
      env: { BH_CONFIG_PATH: '/worlds/world-1/config.json' }
    },
    {
      name: 'proxy-world-1',
      script: '/opt/blockheads/proxy/interceptor/build/install/interceptor/bin/interceptor',
      args: '-P 15153 -S 15151 --event-socket /tmp/bh-events-1.sock --command-socket /tmp/bh-commands-1.sock',
    },
    // world-2, world-3, ...
  ]
}
```

Each world's game server process must also be started separately with the correct `-o <worldId>` and `stdin` pipe.

### The BlockheadsBot API

```typescript
import { BlockheadsBot, loadConfig } from './bot/src'
import { VirtualBank, TeleportSystem } from './bot/src'

const bot = new BlockheadsBot(loadConfig('/worlds/world-123/config.json'))
  .use(VirtualBank)
  .use(TeleportSystem)
  .use(MyCustomExtension)
  .start()
```

`loadConfig(path)` creates an isolated `AppConfig` from any config file. Extensions and the LMDB daemon are fully isolated between bot instances — the only current shared resource is the UDS event client (see above).

### Writing a Custom Extension

An extension is a function that registers behavior with `@bhmb/bot` and returns its name. It receives a `BotContext` (for sending commands to the server) and `AppConfig` (for all config values):

```typescript
import type { ExtensionFactory, BotContext } from './bot/src'
import type { AppConfig } from './bot/src'
import { MessageBot } from '@bhmb/bot'

export const MyExtension: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('my-extension', (ex) => {

    ex.world.onMessage.sub(({ player, message }) => {
      if (message === '/hello') {
        // Send a server command (chat, kick, give, etc.)
        ex.bot.send(`/whisper ${player.name} Hello from world ${cfg.server.worldName}!`)
      }
    })

    ex.world.onJoin.sub((player) => {
      console.log(`${player.name} joined ${cfg.server.worldName}`)
    })

  })
  return 'my-extension'
}

// Declare dependencies — validated before any extensions load
MyExtension.extensionName = 'my-extension'
MyExtension.requires = ['virtual-bank']  // must be registered first
```

If any declared dependency is not registered, `bot.start()` throws before loading anything:

```
Error: Extension "my-extension" requires "virtual-bank" but it is not registered.
Registered: [activity-monitor]
```

### Dependency Validation

Every built-in extension declares its dependencies:

| Extension | Requires |
|-----------|----------|
| `VirtualBank` | _(none)_ |
| `ActivityMonitor` | _(none)_ |
| `QuestSystem` | `activity-monitor` |
| `ShopSystem` | `virtual-bank`, `activity-monitor` |
| `TeleportSystem` | `virtual-bank`, `activity-monitor` |
| `JobSystem` | `virtual-bank` |

### Environment Variable Overrides

Every config field has an environment variable override, useful for container deployments where you don't want to write config files:

| Env var | Config field |
|---------|-------------|
| `BH_SERVER_USER` | `server.user` |
| `BH_SERVER_PASS` | `server.pass` |
| `BH_WORLD_ID` | `server.worldId` |
| `BH_WORLD_SAVE_PATH` | `paths.worldSave` |
| `BH_DATA_DIR` | `paths.dataDir` |
| `BH_WM_SOCK` | `paths.wmSock` |
| `BH_QUEST_DATA_PATH` | `paths.questData` |
| `BH_SPAWN_X` / `BH_SPAWN_Y` | `game.spawn.x/y` |
| `BH_ARENA_X` / `BH_ARENA_Y` / `BH_ARENA_RADIUS` | `game.arena.*` |
| `BH_WILD_COST` | `economy.wildCost` |
| `BH_TPA_COST` | `economy.tpaCost` |
| `BH_DAILY_REWARD` | `economy.dailyReward` |

### Inter-Extension APIs

Extensions communicate with each other through `@bhmb/bot`'s typed export mechanism. The built-in extensions expose:

```typescript
import { getBankAPI, getActivityMonitorAPI, getQuestAPI } from './helpers/extension-api'

// Inside your extension's registerExtension callback:
const bank = getBankAPI(ex.bot)
bank?.addCoins('PlayerName', 100, 'bonus reward')
bank?.removeCoins('PlayerName', 25, 'teleport fee')
bank?.getBalance('PlayerName')    // → number
bank?.hasCoins('PlayerName', 50)  // → boolean

const activity = getActivityMonitorAPI(ex.bot)
activity?.getPlayerUuid('PlayerName')              // → string | null
activity?.getMostRecentBlockheadId('PlayerName')   // → number | null
activity?.getBlockheadsForPlayer('PlayerName')     // → number[]
activity?.addAdminAllowlist('PlayerName')          // whitelist for forbidden items
activity?.removeAdminAllowlist('PlayerName')

const quests = getQuestAPI(ex.bot)
quests?.hasCompletedQuest('PlayerName', '5')       // → boolean
```

---

## Quests

Quests are defined in `config/quest-data.json` (or whatever path `paths.questData` points to). No rebuild is needed — just edit the file and restart the bot.

For a hosting service, each world can have a completely different `quest-data.json` — just point `paths.questData` in that world's config to a different file.

### Quest Chain Structure

Quests form a linked list. Each quest has a `nextQuestId` pointing to the next one. A player starts on quest `"1"` (or whatever the first quest in the file is), completes it, then advances to `nextQuestId`.

```json
[
  {
    "id": "1",
    "title": "Welcome to Town",
    "description": "Head to the town center to get started.",
    "requirements": [...],
    "rewards": [...],
    "nextQuestId": "2"
  },
  {
    "id": "2",
    ...
  }
]
```

The last quest in the chain has no `nextQuestId`. Completing it unlocks `/daily`.

### Quest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique identifier. Can be any string: `"1"`, `"shop-intro"`, `"8.1"` |
| `title` | `string` | yes | Short display name shown to the player |
| `description` | `string` | yes | One-line quest description shown with `/quest` |
| `requirements` | `array` | yes | List of conditions that must ALL be met (see below) |
| `rewards` | `array` | yes | What the player receives on completion (see below) |
| `nextQuestId` | `string` | no | ID of the next quest. Omit on the final quest. |
| `dialogue` | `string \| string[]` | no | Private message(s) sent to the player after completion, 1 second apart |
| `lmdbDelivery` | `boolean` | no | Force the kick-first LMDB delivery path for item rewards (see below) |

### Requirement Types

All requirements in the array must be satisfied simultaneously for the quest to complete.

#### `travel` — reach a location

```json
{ "type": "travel", "x": 1500, "y": 550, "radius": 15 }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `x` | `number` | — | Target X coordinate. Omit to match any X (e.g. "reach this depth") |
| `y` | `number` | — | Target Y coordinate |
| `radius` | `number` | `10` | How close the player must get (blocks) |
| `hideCoords` | `boolean` | `false` | If true, the `/quest` command won't show the exact coordinates — useful for exploration quests where finding the location is part of the challenge |

Travel is checked in real time from `PLAYER_MOVE` events — no polling needed. The player's progress updates the moment they reach the location.

#### `collect` — have items in inventory

```json
{ "type": "collect", "itemId": 34, "itemName": "Stone Pickaxe", "count": 1 }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `itemId` | `number` | — | The item ID to check for. See `tools/itemType.py` for the full list. |
| `itemName` | `string` | — | Display name shown to the player in `/quest` output |
| `count` | `number` | — | How many the player needs in their inventory |
| `anyItemIds` | `number[]` | — | Alternative to `itemId`: any item from this list satisfies the requirement. Useful for "bring any sword" quests. |
| `consume` | `boolean` | `false` | If true, items are removed from the player's inventory when the quest completes. Triggers the kick-first LMDB delivery path automatically. |

Inventory is polled every 15 seconds. There is a short delay between a player picking up an item and the quest system detecting it.

#### `kill` — get arena kills

```json
{ "type": "kill", "killCount": 3 }
```

| Field | Type | Description |
|-------|------|-------------|
| `killCount` | `number` | How many kills inside the configured arena the player needs |

The arena is defined by `game.arena` in the config (`x`, `y`, `radius`). Only kills within that radius count. Kill progress persists across sessions (stored in `quest-progress.json`).

### Reward Types

#### Item reward

```json
{ "itemId": 88, "itemName": "Diamond", "count": 1 }
```

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | Item to give |
| `itemName` | `string` | Display name (shown in completion message) |
| `count` | `number` | Quantity |

By default, items are delivered via the server's `/give` stdin command. If the quest has any `consume: true` requirements, or if `lmdbDelivery: true` is set on the quest, delivery uses the kick-first LMDB path instead (more reliable for large stacks).

#### Token reward

```json
{ "type": "tokens", "count": 200 }
```

Credited directly to the player's virtual bank balance.

### Delivery: `/give` vs LMDB kick-first

There are two ways items can be delivered on quest completion:

**`/give` path (default):** The bot writes `/give-id <blockheadId> <itemId> <count>` to the server's stdin pipe. The server delivers the item directly into the player's inventory without disconnecting them. Fast and seamless.

**LMDB kick-first path** (used when `lmdbDelivery: true` or any requirement has `consume: true`): The bot kicks the player, writes to the LMDB database directly (removing consumed items, adding reward items), then the player reconnects and sees the changes. This is necessary because the game server caches inventory state in RAM — writing to LMDB while a player is online has no effect until they reconnect. The kick forces the reconnect. The save completes in under 100ms, well before the player can reconnect.

Use `lmdbDelivery: true` when:
- Any requirement uses `consume: true` (the bot needs to atomically remove and add items)
- You want to guarantee delivery even if `/give` fails (e.g. full inventory)
- Delivering large stacks that overflow a single `/give` call

### Quest Versioning

When you add new quests and want existing players who finished the old chain to be migrated to the new content, bump the version constants in `bot/src/extensions/quests/quest-context.ts`:

```typescript
export const CURRENT_QUEST_VERSION = 3       // bump this
export const LAST_OLD_QUEST_ID = '10'        // last quest in the old chain
export const FIRST_NEW_QUEST_ID = '11'       // first quest in the new chain
```

On their next `/quest` command or join, players whose `questVersion` is lower than `CURRENT_QUEST_VERSION` AND who have completed `LAST_OLD_QUEST_ID` are automatically moved to `FIRST_NEW_QUEST_ID`. Players who haven't finished the old chain yet are unaffected.

Players who re-encounter a quest they already completed are shown a `(REPEAT)` public announcement, advance past it automatically, and receive no rewards.

---

## Configuration Reference

All fields can be overridden with environment variables. Relative paths in the config file are resolved relative to the repo root.

### `server`

| Field | Env Var | Description |
|-------|---------|-------------|
| `user` | `BH_SERVER_USER` | Admin username |
| `pass` | `BH_SERVER_PASS` | Admin password |
| `worldName` | `BH_WORLD_NAME` | Display name for the world |
| `worldId` | `BH_WORLD_ID` | UUID of the world save directory |

### `paths`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `worldSave` | `BH_WORLD_SAVE_PATH` | — | Path to the world's LMDB save directory |
| `python` | `BH_PYTHON_PATH` | `python3` | Python interpreter |
| `dataDir` | `BH_DATA_DIR` | `./data` | Directory for all runtime JSON/JSONL files |
| `wmSock` | `BH_WM_SOCK` | `/tmp/bh-wm.sock` | UDS socket for Python daemon. **Must be unique per world.** |
| `questData` | `BH_QUEST_DATA_PATH` | `./config/quest-data.json` | Quest chain JSON file |
| `serverLog` | `BH_SERVER_LOG_PATH` | `./data/blockheads.log` | Server log file (watched for joins/chat) |
| `inputPipe` | `BH_INPUT_PIPE_PATH` | `./data/blockheads_input` | Server stdin pipe (bot writes kick/chat here) |
| `proxyCommandSock` | `BH_COMMAND_SOCKET` | `/tmp/bh-commands.sock` | UDS socket the bot connects to for sending private messages to players. **Must be unique per world.** |

### `game`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `spawn.x` / `spawn.y` | `BH_SPAWN_X` / `BH_SPAWN_Y` | `0, 0` | Spawn point for `/spawn` |
| `arena.x` / `arena.y` | `BH_ARENA_X` / `BH_ARENA_Y` | `0, 0` | Arena center for kill tracking |
| `arena.radius` | `BH_ARENA_RADIUS` | `50` | Arena radius in blocks |
| `forbiddenItemIds` | — | `[1074, 206, 300]` | Item IDs that trigger automatic removal |

### `economy`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `wildCost` | `BH_WILD_COST` | `25` | Token cost per `/wild` |
| `wildCooldownMs` | `BH_WILD_COOLDOWN_MS` | `300000` | Cooldown between `/wild` uses (ms) |
| `wildMinY` / `wildMaxY` | `BH_WILD_MIN_Y` / `BH_WILD_MAX_Y` | `521, 600` | Y range for wild spawn search |
| `wildMinSpawnDistance` | `BH_WILD_MIN_SPAWN_DISTANCE` | `5000` | Minimum blocks from spawn for `/wild` |
| `tpaCost` | `BH_TPA_COST` | `0` | Token cost per `/tpa` |
| `tpaCooldownMs` | `BH_TPA_COOLDOWN_MS` | `60000` | Cooldown between `/tpa` uses (ms) |
| `tpaExpireMs` | `BH_TPA_EXPIRE_MS` | `90000` | How long a `/tpa` request stays open (ms) |
| `dailyReward` | `BH_DAILY_REWARD` | `200` | Tokens granted by `/daily` |

### `shop`

Array of shop items:

```json
"shop": [
  { "key": "diamond", "name": "Diamond", "itemId": 88, "price": 400, "count": 1 },
  { "key": "infinite_food", "name": "Infinite Food", "itemId": 59, "price": 2000, "count": 9999, "preferBasket": true }
]
```

`preferBasket: true` tells the bot to put the item in a basket first, then give the basket (avoids stack size limits for large counts).

### `jobs`

Array of job types:

```json
"jobs": [
  { "key": "PUBLIC_BUILDER", "name": "Public Builder", "dailyPay": 200 }
]
```

---

## Player Commands

| Command | Description |
|---------|-------------|
| `/quest` | Show current quest and progress |
| `/shop` | List shop items and prices |
| `/buy <item>` | Purchase a shop item |
| `/unknown` | Buy a random mystery item for 50 tokens |
| `/wild` | Teleport to a random wilderness location |
| `/spawn` | Teleport to spawn |
| `/tpa <player>` | Request teleport to another player |
| `/tpaccept <player>` | Accept a teleport request |
| `/tpdeny <player>` | Deny a teleport request |
| `/balance` (`/bal`) | Check your token balance |
| `/pay <player> <amount>` | Send tokens to another player |
| `/cf <amount>` | Coin flip — double or nothing (max 1,000) |
| `/transactions` (`/history`) | View recent transactions |
| `/baltop` (`/leaderboard`) | Top token balances |
| `/daily` | Claim daily reward (requires completing the quest chain) |
| `/tracked` | See which blockhead is being tracked for quests/coords |
| `/track <n>` | Choose which blockhead to track (for multi-blockhead players) |
| `/jobs` | View available jobs |
| `/apply <job> <discord>` | Apply for a job |
| `/rep <message>` | Submit a job report |
| `/home` | Teleport to your saved home location |
| `/sethome` | Save your current location as home |
| `/delhome` | Delete your saved home |
| `/coords` | Show your current coordinates |
| `/whisper <player> <msg>` | Send a private message |
| `/cmds` | List all commands |

## Admin Commands

| Command | Description |
|---------|-------------|
| `/tp <x> <y>` | Teleport to coordinates |
| `/give <player> <itemId> [count]` | Give items to a player |
| `/hire <player> <job>` | Hire a player into a job |
| `/fire <player> [reason]` | Fire a player from their job |
| `/setpay <player> <amount>` | Change an employee's daily pay |
| `/deposit <player> <amount>` | Add tokens to a player's balance |
| `/withdraw <player> <amount>` | Remove tokens from a player's balance |
| `/questreset <player>` | Reset a player's quest progress |
| `/seasonreset` | Reset all player quest progress (new season) |

---

## Proxy Configuration

The proxy is configured via CLI flags (or environment variable overrides):

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--event-socket` | `BH_EVENT_SOCKET` | `/tmp/bh-events.sock` | UDS socket the proxy emits game events on (bot reads this) |
| `--command-socket` | `BH_COMMAND_SOCKET` | `/tmp/bh-commands.sock` | UDS socket the proxy listens on for bot→proxy commands (private messages) |
| `-P` | — | `15153` | UDP port the proxy listens on (players connect here) |
| `-S` | — | `15151` | UDP port of the actual game server |

---

## Debug Flags

| Env Var | Description |
|---------|-------------|
| `BH_LOG_BOT_DEBUG=1` | Verbose per-operation logs |
| `BH_LOG_ACTIVITY_EVENTS=1` | Log every game event received |
| `BH_LOG_BLOCKHEAD_MAP=1` | Log blockhead→player mapping operations |
| `BH_LOG_QUEST_CACHE=1` | Verbose quest requirement checking |
| `BH_INVENTORY_INACTIVITY_MS=<ms>` | How long since a player's last action before their inventory cache is considered stale (default 120000) |

To generate a Node.js stack dump at any time:

```bash
kill -USR2 <node_pid>
# Output written to data/node-stack-dump.txt
```

---

## Troubleshooting

**Bot won't start / "No config.json found"**
Copy `config/config.example.json` to `config/config.json` and fill in `server.worldId` and `paths.worldSave`.

**Teleport puts player back where they were**
The game server caches positions in RAM. The bot kicks the player before writing to LMDB so the change takes effect on reconnect. If it's still not working, check that `paths.worldSave` points to the correct directory.

**Quests not detecting item pickups**
Inventory is polled every 15 seconds. If it never updates, check that `paths.python` points to a 64-bit Python 3 binary and that the `lmdb` package is installed: `python3 -c "import lmdb; print('ok')"`.

**LMDB error on open**
You must use 64-bit Python. Run `python3 -c "import struct; print(struct.calcsize('P') * 8)"` — it must print `64`.

**Events not detected / no joins/leaves**
Ensure the proxy is running. The bot connects to the UDS event socket on startup; check both proxy and bot logs for socket errors. The `--event-socket` value passed to the proxy must match what the bot connects to (configurable via `BH_EVENT_SOCKET` env var; default `/tmp/bh-events.sock`).

**Admin commands not working**
Your username (uppercase) must be in `<paths.worldSave>/adminlist.txt`. The bot reads and watches this file live — no restart needed after editing it.

**100% CPU / bot freezes**
Send `kill -USR2 <pid>` to dump the stack to `data/node-stack-dump.txt`.

**Proxy won't start**
Java 21 is required. Use the generated launcher script (`proxy/interceptor/build/install/interceptor/bin/interceptor`) rather than `java -jar` — it includes all required `--enable-preview` flags automatically.

---

## Acknowledgements

- **Bot framework** — [Console-Loader](https://github.com/Blockheads-Messagebot/Console-Loader) by Bibliofile / Blockheads-Messagebot (MIT)
- **Proxy** — [blockheads](https://github.com/juanmuscaria/blockheads) by juanmuscaria (MPL-2.0)
- **World save tools** — [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844

## License

- Top-level and bot code: [MIT](LICENSE)
- Proxy: [MPL-2.0](proxy/LICENSE)
- Tools: Based on [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844
