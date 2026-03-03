# Blockheads Server Tools

A comprehensive server management toolkit for [The Blockheads](https://theblockheads.net/) Linux servers. Includes an extensible bot with quests, shops, teleportation, jobs, and PvP arena tracking — a UDP packet interceptor/proxy for real-time event monitoring — and Python tools for direct world save manipulation via LMDB.

## Architecture Overview

```
┌─────────────┐      UDP        ┌──────────────┐
│   Players   │ ◄─────────────► │  Proxy (Java)│
└─────────────┘                 └──────┬───────┘
                                       │ events.jsonl
                                       ▼
                                ┌──────────────┐
                                │   Bot (Node)  │
                                └──────┬───────┘
                                       │ JSON stdin/stdout
                                       ▼
                                ┌──────────────┐
                                │ Daemon (Python)│
                                └──────┬───────┘
                                       │ LMDB
                                       ▼
                                ┌──────────────┐
                                │  World Save   │
                                └──────────────┘
```

**Proxy** intercepts all game traffic, extracts events (movement, inventory changes, item pickups), and writes them to a JSONL file. **Bot** watches that file and reacts — running quests, shops, teleports, and enforcing rules. **Daemon** keeps the world's LMDB database open for fast reads/writes (give items, teleport players, check inventories).

## Prerequisites

- **Linux** (The Blockheads server is Linux-only)
- **Node.js 18+** (for the bot)
- **Python 3.8+** with `lmdb` package (for world save tools)
- **Java 21+** (for the proxy)
- **The Blockheads server** running on the same machine

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/blockheads-server-tools.git
cd blockheads-server-tools

# Create your config from the template
cp config/config.example.json config/config.json
# Edit config/config.json with your server details
```

### 2. Install bot dependencies

```bash
cd bot
npm install    # Also applies the @bhmb/server patch automatically
npm run build  # Compile TypeScript
cd ..
```

### 3. Install Python dependencies

```bash
cd tools
pip install -r requirements.txt
cd ..
```

### 4. Build the proxy

```bash
cd proxy
./gradlew :interceptor:build
cd ..
```

### 5. Start everything

```bash
# Terminal 1: Start the proxy (intercepts game traffic)
cd proxy
java -jar interceptor/build/libs/interceptor.jar \
  -P 15153 -S 15151 \
  -DbH.privateMessagesFile=../data/private_messages.jsonl \
  -Dbh.commandEventsFile=../data/command_events.jsonl

# Terminal 2: Start the bot
cd bot
npm run mac
```

Or use PM2 for production:

```bash
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js
```

## Configuration

All configuration lives in `config/config.json`. Every field can be overridden with environment variables.

### Server credentials

| Field | Env Var | Description |
|-------|---------|-------------|
| `server.user` | `BH_SERVER_USER` | Server admin username |
| `server.pass` | `BH_SERVER_PASS` | Server admin password |
| `server.worldName` | `BH_WORLD_NAME` | Display name for the world |
| `server.worldId` | `BH_WORLD_ID` | World UUID (from the saves directory) |

### Paths

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `paths.worldSave` | `BH_WORLD_SAVE_PATH` | — | Path to world LMDB save directory |
| `paths.python` | `BH_PYTHON_PATH` | `python3` | Python interpreter |
| `paths.worldManager` | `BH_WORLD_MANAGER_PATH` | `./tools/world_manager.py` | World manager script |
| `paths.inventoryReader` | `BH_INVENTORY_READER_PATH` | `./tools/inventory_reader.py` | Inventory reader script |
| `paths.wildLocations` | `BH_WILD_LOCATIONS_PATH` | `./tools/wild_locations.py` | Wild teleport location finder |
| `paths.eventLog` | `BH_EVENT_LOG_PATH` | `./proxy/interceptor/blockheads_events.jsonl` | Event log from proxy |
| `paths.privateMessages` | `BH_PRIVATE_MSG_PATH` | `./data/private_messages.jsonl` | Private message queue |
| `paths.dataDir` | `BH_DATA_DIR` | `./data` | Runtime data directory |

### Game settings

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `game.spawn.x` | `BH_SPAWN_X` | `0` | Spawn X coordinate |
| `game.spawn.y` | `BH_SPAWN_Y` | `0` | Spawn Y coordinate |
| `game.arena.x` | `BH_ARENA_X` | `0` | PvP arena center X |
| `game.arena.y` | `BH_ARENA_Y` | `0` | PvP arena center Y |
| `game.arena.radius` | `BH_ARENA_RADIUS` | `50` | PvP arena radius (blocks) |
| `game.forbiddenItemIds` | — | `[1074, 206, 300]` | Item IDs flagged for monitoring |

### Economy

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `economy.wildCost` | `BH_WILD_COST` | `25` | Token cost for /wild |
| `economy.wildCooldownMs` | `BH_WILD_COOLDOWN_MS` | `300000` | /wild cooldown (5 min) |
| `economy.tpaCost` | `BH_TPA_COST` | `0` | Token cost for /tpa |
| `economy.dailyReward` | `BH_DAILY_REWARD` | `200` | Daily login reward tokens |

### Shop items

Define shop items in `config.json` under `shop`:

```json
{
  "shop": [
    { "key": "diamond", "name": "Diamond", "itemId": 88, "price": 400, "count": 1 },
    { "key": "infinite_food", "name": "Infinite Food", "itemId": 59, "price": 2000, "count": 9999, "preferBasket": true }
  ]
}
```

### Jobs

Define jobs in `config.json` under `jobs`:

```json
{
  "jobs": [
    { "key": "PUBLIC_BUILDER", "name": "Public Builder", "dailyPay": 200 }
  ]
}
```

## Customizing Quests

Edit `bot/src/extensions/quests/quest-data.ts` to define your server's quest chain. The file includes documented examples of all three quest types:

- **travel** — Player reaches specific coordinates
- **collect** — Player has items in inventory (optionally consumed on completion)
- **kill** — Player gets PvP kills in the arena

Quests form a linked list via `nextQuestId`. See `quest-types.ts` for all available fields.

Item IDs can be looked up in `tools/itemType.py`.

## Player Commands

| Command | Description |
|---------|-------------|
| `/quest` | Show current quest progress |
| `/shop` | List shop items and prices |
| `/buy <item>` | Purchase a shop item |
| `/unknown` | Buy a random mystery item |
| `/wild` | Teleport to random wilderness |
| `/spawn` | Teleport to spawn |
| `/tpa <player>` | Request teleport to another player |
| `/tpaccept <player>` | Accept a teleport request |
| `/tpdeny <player>` | Deny a teleport request |
| `/balance` | Check token balance |
| `/daily` | Claim daily reward (unlocks after quest completion) |
| `/jobs` | View available jobs |
| `/apply <job> <discord>` | Apply for a job |
| `/rep <message>` | Submit a job report |
| `/coords` | Show your current coordinates |
| `/whisper <player> <msg>` | Send a private message |
| `/help` | List all commands |

## Admin Commands

| Command | Description |
|---------|-------------|
| `/tp <x> <y>` | Teleport to coordinates |
| `/give <player> <itemId> [count]` | Give items to a player |
| `/hire <player> <job>` | Hire a player |
| `/fire <player> [reason]` | Fire a player |
| `/setpay <player> <amount>` | Change employee pay |

## Proxy Configuration

The proxy accepts these JVM system properties:

| Property | Default | Description |
|----------|---------|-------------|
| `bh.blockedIpsFile` | `blocked_ips.txt` | IP blocklist file |
| `bh.privateMessagesFile` | `private_messages.jsonl` | Private message queue |
| `bh.commandEventsFile` | `command_events.jsonl` | Command events log |
| `bh.udsEventSocket` | `/tmp/bh-events.sock` | Unix domain socket path |
| `bh.clientInfoLog` | `client_info.jsonl` | Client info log |

## Troubleshooting

**Bot won't start / "Missing config file"**
- Ensure `config/config.json` exists (copy from `config/config.example.json`)
- Check that all required paths are correct

**Teleport doesn't work**
- The game server caches player positions in RAM. The bot kicks the player before writing to LMDB so changes take effect on reconnect.
- Check that `paths.worldSave` points to the correct LMDB save directory.

**Quests not tracking inventory**
- The daemon must be running (started automatically by the bot)
- Check that `paths.worldManager` and `paths.python` are correct

**Events not detected**
- Ensure the proxy is running and `paths.eventLog` points to the proxy's output file
- The proxy writes to `blockheads_events.jsonl` in its working directory

**Bot freezes / 100% CPU**
- The `@bhmb/server` patch fixes a known infinite loop bug. Run `npm install` to re-apply patches.
- Check `data/node-stack-dump.txt` (send `kill -USR2 <pid>` to generate)

## Acknowledgements

This project builds on work by several authors:

- **Bot framework** — [Console-Loader](https://github.com/Blockheads-Messagebot/Console-Loader) by Bibliofile / Blockheads-Messagebot (MIT License)
- **Proxy** — [blockheads](https://github.com/juanmuscaria/blockheads) by juanmuscaria (MPL-2.0 License)
- **World save tools** — [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844

## License

- Top-level and bot code: [MIT](LICENSE)
- Proxy: [MPL-2.0](proxy/LICENSE)
- Tools: Based on [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844 (no upstream license specified — attribution provided, will comply with any license terms if established)
