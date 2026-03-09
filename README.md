# Blockheads Server Tools

A comprehensive server management toolkit for [The Blockheads](https://theblockheads.net/) Linux servers. Includes an extensible bot with quests, shops, teleportation, jobs, and PvP arena tracking — a UDP packet interceptor/proxy for real-time event monitoring — and Python tools for direct world save manipulation via LMDB.

## Architecture Overview

```
                                                     ┌─────────────────────┐
                           ┌─────────────────────────►  Blockheads Server  │
┌──────────┐  ┌────────────────────┐  kick/chat cmds │                     │
│ Players  │◄─►  Proxy (Java)      │────────────────►│  blockheads.log ──┐ │
└──────────┘  │  - ENet relay      │  via input pipe │                   │ │
         UDP  │  - packet decode   │                 │  World Save       │ │
              │  - events.jsonl ──►│─┐               │  (LMDB)      ◄────┼─┼──┐
              │  - msg inject    ◄─┼─┘               └───────────────────┼─┘  │
              └────────────────────┘  private_messages.jsonl             │    │
                                                                         ▼    │
                                                            ┌────────────────────────────┐
                                                            │  Bot (Node.js)             │
                                                            │                            │
                                                            │  linux-api  ◄──────────────┘
                                                            │  activity-monitor          │
                                                            │  quest-system              │
                                                            │  teleport / shop / bank    │
                                                            └────────────┬───────────────┘
                                                                         │ spawns per-op
                                                                         ▼
                                                            ┌────────────────────────┐
                                                            │  Python Tools          │
                                                            │  world_manager.py      │
                                                            │  inventory_reader.py   │
                                                            └────────────┬───────────┘
                                                                         │ direct LMDB
                                                                         │ read/write
                                                                         ▼
                                                            ┌────────────────────────┐
                                                            │   World Save (LMDB)    │
                                                            │   (server's database)  │
                                                            └────────────────────────┘
```

**Proxy** sits in front of the game server, intercepts all UDP traffic, and writes structured events to a JSONL file. **Bot** watches that file and the server log, responding to player actions by running quests, shops, teleports, and enforcing rules. For world save operations (give items, teleport, read inventory), the bot spawns **Python tools** that access the server's LMDB database directly — no persistent daemon.

## Prerequisites

- **Linux** (The Blockheads server binary is Linux-only)
- **64-bit OS and Python** (LMDB maps 8GB of virtual address space; 32-bit will not work)
- **Node.js 18+** (for the bot)
- **Python 3.8+ (64-bit)** with `lmdb` package (for world save tools)
- **Java 21+** (for the proxy — uses preview features, requires exactly Java 21)
- **The Blockheads server** running on the same machine

## How It Fits Together

The Blockheads server listens on a UDP port (default 15151). The proxy sits in front of it: players connect to the proxy port (15153) and the proxy forwards traffic to the server (15151) while intercepting all packets.

```
Players → UDP :15153 → Proxy → UDP :15151 → Blockheads Server
```

You need to either: (a) change the port players connect to from 15151 to 15153, or (b) update your firewall to redirect 15151 → 15153.

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/blockheads-server-tools.git
cd blockheads-server-tools

# Create your config from the template
cp config/config.example.json config/config.json
```

Open `config/config.json` and fill in the required fields:

| Field | How to find it |
|-------|---------------|
| `server.user` | Your in-game username (you'll be set as admin) |
| `server.pass` | Your server's admin password |
| `server.worldId` | The UUID directory name under your saves directory |
| `paths.worldSave` | Full path to that UUID directory |

The saves directory is typically `~/.local/share/TheBlockheads/saves/` on Linux. The world ID is the UUID-named folder inside it.

All other fields have working defaults.

### 2. Become an admin

Add your in-game username (uppercase) to `<paths.worldSave>/adminlist.txt`, one name per line. Admin commands (`/deposit`, `/give`, `/tp`, etc.) will not work until your name is in this file.

### 3. Install bot dependencies

```bash
cd bot
npm install    # Also applies the @bhmb/server patch automatically
npm run build  # Compile TypeScript
cd ..
```

### 4. Install Python dependencies

```bash
cd tools
pip install -r requirements.txt
cd ..
```

### 5. Build the proxy

```bash
cd proxy
./gradlew :interceptor:installDist
cd ..
```

This produces a launch script at `proxy/interceptor/build/install/interceptor/bin/interceptor` that includes the correct classpath and required JVM flags (`--enable-preview`, `--enable-native-access`, etc.).

### 6. Compile the item injection library

`blockheads_give.so` is an `LD_PRELOAD` library that adds `/give` and `/give-id` commands to the server's stdin interface. The source is included at `blockheads_give.c`.

```bash
gcc -shared -fPIC -o blockheads_give.so blockheads_give.c -lobjc -ldl -lpthread
```

Requires `libobjc` (GNUstep Objective-C runtime):

```bash
sudo apt install gobjc gnustep-devel
```

### 7. Start the Blockheads server

The server must be started with the item injection library preloaded, and with its stdin piped from the file the bot writes admin commands to.

```bash
nohup bash -c 'tail -f /path/to/blockheads_input | \
  LD_PRELOAD=/path/to/blockheads_give.so \
  ./blockheads_server171 \
  -o YOUR_WORLD_UUID \
  -s 67 -m 32 \
  --owner YOUR_USERNAME \
  --no-exit 2>&1 | tee /path/to/blockheads.log' &
```

Replace the placeholders:

| Placeholder | Where to find it |
|-------------|-----------------|
| `/path/to/blockheads_input` | Must match `paths.inputPipe` in `config.json` |
| `/path/to/blockheads_give.so` | Path to the compiled library from step 6 |
| `YOUR_WORLD_UUID` | Must match `server.worldId` in `config.json` |
| `YOUR_USERNAME` | Your in-game owner username |
| `/path/to/blockheads.log` | Must match `paths.serverLog` in `config.json` |

The `tail -f blockheads_input` pipe is how the bot sends kick and chat commands to the server. The `tee blockheads.log` output is how the bot detects player joins, leaves, and chat.

### 8. Start the proxy and bot

```bash
# Terminal 1: Start the proxy (intercepts game traffic)
JAVA_OPTS="-Dbh.privateMessagesFile=$(pwd)/data/private_messages.jsonl \
           -Dbh.commandEventsFile=$(pwd)/data/command_events.jsonl" \
  proxy/interceptor/build/install/interceptor/bin/interceptor -P 15153 -S 15151

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
- Check that `server.worldId` and `paths.worldSave` are filled in correctly

**Teleport doesn't work**
- The game server caches player positions in RAM. The bot kicks the player before writing to LMDB so changes take effect on reconnect.
- Check that `paths.worldSave` points to the correct LMDB save directory.

**Quests not tracking inventory**
- Check that `paths.worldManager`, `paths.inventoryReader`, and `paths.python` are correct
- Verify Python can open the world save: `python3 tools/inventory_reader.py --save-path /your/world/save --list-blockheads --player-uuid YOUR_UUID`

**LMDB error on open**
- You must use 64-bit Python. The tools reserve a 6GB virtual address mapping; this is impossible in a 32-bit process.
- Verify `paths.worldSave` points to the directory containing `world_db/` (with a trailing slash).

**Events not detected**
- Ensure the proxy is running and `paths.eventLog` points to the proxy's output file
- The proxy writes `blockheads_events.jsonl` in its working directory by default

**Admin commands not working**
- Your username (uppercase) must be in `<paths.worldSave>/adminlist.txt`. The bot reads this file to determine admins.

**Bot freezes / 100% CPU**
- The `@bhmb/server` patch fixes a known infinite loop bug. Run `npm install` to re-apply patches.
- Check `data/node-stack-dump.txt` (send `kill -USR2 <pid>` to generate)

**Proxy won't start / JVM errors**
- Java 21 is required. The proxy uses preview features and will fail with older JVMs.
- Use the `installDist` script rather than `java -jar` — the generated script at `proxy/interceptor/build/install/interceptor/bin/interceptor` includes all required JVM flags automatically.

## Acknowledgements

This project builds on work by several authors:

- **Bot framework** — [Console-Loader](https://github.com/Blockheads-Messagebot/Console-Loader) by Bibliofile / Blockheads-Messagebot (MIT License)
- **Proxy** — [blockheads](https://github.com/juanmuscaria/blockheads) by juanmuscaria (MPL-2.0 License)
- **World save tools** — [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844

## License

- Top-level and bot code: [MIT](LICENSE)
- Proxy: [MPL-2.0](proxy/LICENSE)
- Tools: Based on [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844 (no upstream license specified — attribution provided, will comply with any license terms if established)
