# Blockheads Server Tools

A full server management framework for [The Blockheads](https://theblockheads.net/) Linux servers.

**What's included:**
- **Java proxy** — sits in front of the game server, intercepts all UDP traffic, enforces IP/iCloud bans, and streams structured game events (joins, moves, item pickups, kills) over a Unix socket
- **Node.js bot** — event-driven extension framework with quests, token economy, shop, teleport, jobs, claims, PvP duels, and buff shop — all hot-configurable without a rebuild
- **Python LMDB daemon** — keeps the world database open for fast direct reads and writes (give items, teleport, read/modify inventory) — typically 1–5ms per operation
- **C hooks (LD_PRELOAD)** — patches the game server binary at runtime. The default deploy runs a minimal, proven set: trade-portal price protection (anti-exploit), a network crash-fix, and land claims. Optional feature hooks (boss fights, arena waves, poison, buffs/god mode, duels) ship **disabled** and can be enabled per world in config.

**Built for hosting services.** Each world gets its own config, data directory, quest chain, and extension set. One Docker image, unlimited worlds via `docker-compose.multi.yml`.

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

The game server and C hooks run together under `LD_PRELOAD`. The proxy sits in front — players connect to the proxy port (default 15153), which relays traffic to the game (15151) while intercepting packets. The bot watches the proxy's event stream and the server log, responding to actions in real time.

---

## Quick Start (Docker)

Everything is bundled in one container. No dependency installation.

```bash
git clone https://github.com/saadkhairullah/blockheads-server-tools.git
cd blockheads-server-tools/docker

cp .env.example .env
# Edit .env and fill in the required fields (see below)

sudo docker compose build
sudo docker compose up -d
```

### Required `.env` fields

| Variable | Description |
|----------|-------------|
| `BH_WORLD_ID` | Your world's UUID — the folder name inside your saves directory |
| `BH_SERVER_USER` | Your in-game username (must also be in `adminlist.txt`) |
| `BH_SERVER_PASS` | Your server password |
| `BH_GNUSTEP_PATH` | Full path to your GNUstep directory on the host (e.g. `/home/you/GNUstep`) |

To find your world UUID:
```bash
ls ~/GNUstep/Library/ApplicationSupport/TheBlockheads/saves/
# Each folder is a world UUID
```

### Viewing logs

```bash
# Bot activity (quests, joins, commands, errors)
tail -f data/logs/bot.log

# Game server output
tail -f data/logs/blockheads.log

# Java proxy
tail -f data/logs/proxy.log

# All three at once
tail -f data/logs/bot.log data/logs/blockheads.log data/logs/proxy.log

# Or via Docker (game server stdout only)
docker logs -f blockheads-server
```

### Sending server commands

The game server reads commands from a named pipe. From the host:

```bash
echo "/kick PLAYERNAME" >> blockheads-server-tools/data/blockheads_input
echo "/give-id 12345 88 1" >> blockheads-server-tools/data/blockheads_input
```

From inside the container:
```bash
docker exec blockheads-server bash -c 'echo "/kick PLAYERNAME" >> /data/blockheads_input'
```

### Custom config

On first run the container copies the bundled `config.example.json` to the data volume as
`data/config.json`. That file is the single source of truth for both the bot and the C hooks.
To customize shop items, jobs, economy values, or which hooks are enabled:

```bash
# 1. Start once so data/config.json is created, then edit it:
nano data/config.json

# 2. Apply changes — no rebuild needed:
sudo docker compose restart
```

Prefer to keep your config in the repo instead? Point the mount at an existing file by
uncommenting the `../config/config.json:/data/config.json` line in `docker-compose.yml` — but
make sure that file exists first, otherwise Docker silently creates an empty *directory* there
and the server fails to read its config.

### Updating

```bash
git pull
sudo docker compose build
sudo docker compose up -d
```

---

## Multiple Servers (Hosting Providers)

Build the image once, spin up a container per world:

```bash
sudo docker compose build

# Generate env file + compose block for each server
./add-server.sh --name "PvP Arena" --port 15153 --world-id "abc-123" --owner "YourUsername"
./add-server.sh --name "Creative"  --port 15154 --world-id "def-456" --owner "YourUsername"

# Copy the printed YAML blocks into docker-compose.multi.yml, then:
sudo docker compose -f docker-compose.multi.yml up -d
```

Each server gets its own data volume, port, config, and quest file. All containers on the same machine share the same `BH_GNUSTEP_PATH` — each reads only its own world UUID.

---

## Configuration

All config lives in `config/config.json` (or whatever you mount to `/data/config.json`). Copy `config/config.example.json` as a starting point. Every field also has an environment variable override.

### `server`

| Field | Env Var | Description |
|-------|---------|-------------|
| `user` | `BH_SERVER_USER` | Admin username |
| `pass` | `BH_SERVER_PASS` | Server password |
| `worldName` | `BH_WORLD_NAME` | Display name |
| `worldId` | `BH_WORLD_ID` | World save UUID |

### `paths`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `worldSave` | `BH_WORLD_SAVE_PATH` | — | Path to the world's LMDB save directory |
| `dataDir` | `BH_DATA_DIR` | `./data` | Runtime data directory (JSON, JSONL, logs) |
| `wmSock` | `BH_WM_SOCK` | `/tmp/bh-wm.sock` | Python daemon socket. Must be unique per world. |
| `questData` | `BH_QUEST_DATA_PATH` | `./config/quest-data.json` | Quest chain JSON |
| `serverLog` | `BH_SERVER_LOG_PATH` | `./data/blockheads.log` | Game server log (watched for joins/chat) |
| `inputPipe` | `BH_INPUT_PIPE_PATH` | `./data/blockheads_input` | Server stdin pipe |
| `proxyCommandSock` | `BH_COMMAND_SOCKET` | `/tmp/bh-commands.sock` | Proxy command socket. Must be unique per world. |

### `game`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `spawn.x` / `spawn.y` | `BH_SPAWN_X` / `BH_SPAWN_Y` | `0, 0` | `/spawn` destination |
| `arena.x` / `arena.y` | `BH_ARENA_X` / `BH_ARENA_Y` | `0, 0` | Arena center for kill tracking |
| `arena.radius` | `BH_ARENA_RADIUS` | `50` | Arena radius in blocks |
| `forbiddenItemIds` | — | `[1074, 206, 300]` | Items auto-removed from players |

### `economy`

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `wildCost` | `BH_WILD_COST` | `25` | Token cost per `/wild` |
| `wildCooldownMs` | — | `300000` | Cooldown between `/wild` uses (ms) |
| `wildMinY` / `wildMaxY` | — | `521, 600` | Y range for wild spawn search |
| `tpaCost` | `BH_TPA_COST` | `0` | Token cost per `/tpa` |
| `tpaCooldownMs` | — | `60000` | `/tpa` cooldown (ms) |
| `tpaExpireMs` | — | `90000` | How long a `/tpa` request stays open (ms) |
| `dailyReward` | `BH_DAILY_REWARD` | `200` | Tokens from `/daily` |

### `shop`

Array of purchasable items:

```json
"shop": [
  { "key": "diamond",      "name": "Diamond",      "itemId": 88,   "price": 400,  "count": 1 },
  { "key": "infinite_food","name": "Infinite Food", "itemId": 59,   "price": 2000, "count": 9999, "preferBasket": true }
]
```

`preferBasket: true` puts the item in a basket before giving it (avoids stack size limits for large counts).

### `jobs`

```json
"jobs": [
  { "key": "PUBLIC_BUILDER", "name": "Public Builder", "dailyPay": 200 }
]
```

---

## C Hooks

The C hook library (`hooks/`) is loaded into the game server via `LD_PRELOAD`. It patches game functions at runtime — no server source code required. All hooks read from the `hooks` section of `config.json`. The Docker image compiles it from source (`libblockheads_hooks.so`) during the build.

**Default hook set.** To keep deployments stable, only the proven hooks ship enabled: `trade`
(price protection), `network` (crash-fix), and `claims`. The feature hooks — `boss`, `poison`,
`godmode`, `arena`, and `duel` — ship **disabled**. Turn any on with `"enabled": true` in the
`hooks` section. (`/give` and `/give-id` are always available — they aren't gated by a hook flag.)

> Enabling `godmode`, `boss`, or `duel` also has a bot-side half: set the matching entry in the
> top-level `extensions` block (`buff-shop`, `boss-rewards`, `duel-system`) back to `true` (or
> remove it) so the player-facing commands come back too.

### Boss

Spawns a souped-up cave troll with custom stats, projectiles, and teleportation. Spawn with `/spawn-boss <x> <y>` (admin command).

```json
"hooks": {
  "boss": {
    "enabled": true,
    "hp": 4096,
    "damage": 60,
    "speed": 40,
    "timer": 0.01,
    "aggro": 64,
    "aggroRidden": 64,
    "flight": true,
    "loot": { "itemId": 88, "count": 10 },
    "projectile": { "enabled": true, "rate": 3, "type": 255, "damage": 40 },
    "teleport":   { "enabled": true, "rate": 2, "range": 1, "maxDist": 64 }
  }
}
```

| Field | Description |
|-------|-------------|
| `hp` | Boss health points |
| `damage` | Damage per hit |
| `speed` | Movement speed |
| `timer` | AI update interval (lower = faster reactions) |
| `aggro` / `aggroRidden` | Aggro range in blocks (normal / while player is riding) |
| `flight` | Whether the boss can fly |
| `loot` | Item dropped on death |
| `projectile.rate` | Shots per second |
| `projectile.type` | Projectile NPC type (255 = scorpion) |
| `teleport.rate` | Teleports per second |
| `teleport.range` | Teleport radius |
| `teleport.maxDist` | Max distance the boss will teleport toward a player |

### Boss Arena

Defines the zone where boss-specific buffs and loot scaling apply. Set these to the coordinates of your boss room.

```json
"bossArena": {
  "x1": 90000, "y1": 600,
  "x2": 91000, "y2": 640,
  "autoBuff": false,
  "lootScale": true,
  "buffValue": 5.0
}
```

> Set `x1/y1/x2/y2` to the bounding box of your boss room. Use `/coords` in-game to find your coordinates.

| Field | Description |
|-------|-------------|
| `x1/y1/x2/y2` | Bounding box of the boss arena |
| `autoBuff` | Automatically apply `buffValue` attack multiplier to players inside |
| `lootScale` | Scale boss loot drop by number of players inside the arena |
| `buffValue` | Attack multiplier applied to players when `autoBuff` is on |

### Arena (Wave Mode)

A timed mob wave event. Start with `/arena start`, stop with `/arena stop` (admin commands). Zone is saved to disk and persists across restarts.

```json
"arena": {
  "enabled": true,
  "waveDelay": 10,
  "maxWaves": 10,
  "lootId": 88,
  "lootCount": 20,
  "mobCountBase": 2,
  "rewardPerWave": false,
  "perWaveRewardId": 88,
  "perWaveRewardCount": 5,
  "waves": [
    { "mobType": 6, "count": 2 },
    { "mobType": 6, "count": 4 }
  ]
}
```

| Field | Description |
|-------|-------------|
| `waveDelay` | Seconds between waves |
| `maxWaves` | Total number of waves |
| `lootId` / `lootCount` | Item given on full arena clear |
| `mobCountBase` | If `waves` is empty, spawns `wave * mobCountBase` trolls per wave |
| `rewardPerWave` | If true, give `perWaveRewardId` after each wave clears |
| `waves` | Per-wave mob config. `mobType`: 6 = cave troll, 7 = scorpion |
| `zone` | Arena bounding box. Set via `/arena set` in-game and saved automatically. |

### Duel

Manages the C-side duel state machine (position tracking, spawn point). The bot's `DuelSystem` extension handles the inventory backup/kit/teleport side via LMDB.

```json
"duel": {
  "enabled": true,
  "countdown": 10,
  "timeout": 300,
  "pendingTimeout": 60,
  "arena": { "x": 76923, "y": 607 },
  "tokenReward": 100,
  "kit": [
    { "itemId": 68,  "count": 1 },
    { "itemId": 193, "count": 1 },
    { "itemId": 192, "count": 1 }
  ]
}
```

| Field | Description |
|-------|-------------|
| `countdown` | Seconds between "Preparing arena" and fight start |
| `timeout` | Seconds before a live duel is declared a draw |
| `pendingTimeout` | Seconds a challenge stays open before expiring |
| `arena.x/y` | Where both players teleport to when a duel starts. Use `/coords` in-game to find the right spot. |
| `tokenReward` | Tokens awarded to the winner |
| `kit` | Items given to both players at duel start (replaces their inventory for the duration, slots 1–7 only — slot 0 clothing is preserved) |

### Poison

Applies ongoing damage to players hit by poison attacks.

```json
"poison": { "enabled": true, "damage": 0.01, "ticks": 20 }
```

### Other Hooks

| Key | Default | What it does |
|-----|---------|-------------|
| `trade.enabled` | **on** | **Trade-portal price protection.** Freezes trade prices so a player mass-selling a cheap item (e.g. flax seed) can't drift/overflow the price and wreck the server-wide economy. Hooks the per-transaction price update, the server price sync, and the client-sent price offsets. |
| `network.enabled` | **on** | **Crash-fix.** Stops the server calling `exit(0)` when `pollNetEvents` hits a network exception (`NSRangeException`) — a stability/DoS fix, not a feature hook. |
| `claims.enabled` | **on** | Land claims — powers `/claim`, `/claim-at`, `/unclaim` (pairs with the bot's `ClaimsSystem` extension). Command-driven; no always-on runtime cost. |
| `godmode.enabled` | off | Backs the damage-modifier system: the `/godmode`, `/defense`, and `/buff` admin commands **and** the bot's buff-shop (`/buydefense`, `/buystrength`). |
| `trollAIMaxWait` | — | Max seconds a non-boss troll waits between AI updates (default 3.0). |

---

## Extending the Bot

### Writing a Custom Extension

```typescript
import type { ExtensionFactory, BotContext } from './bot/src'
import type { AppConfig } from './bot/src'
import { MessageBot } from '@bhmb/bot'

export const MyExtension: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('my-extension', (ex) => {

    ex.world.onMessage.sub(({ player, message }) => {
      if (message === '/hello') {
        ex.bot.send(`Hello ${player.name}!`)
      }
    })

    ex.world.onJoin.sub((player) => {
      console.log(`${player.name} joined ${cfg.server.worldName}`)
    })

  })
  return 'my-extension'
}

MyExtension.extensionName = 'my-extension'
MyExtension.requires = ['virtual-bank'] as const  // validated at startup
```

### Inter-Extension APIs

```typescript
import { getBankAPI, getActivityMonitorAPI, getQuestAPI } from './helpers/extension-api'

const bank = getBankAPI(ex.bot)
bank?.addCoins('PlayerName', 100, 'bonus')
bank?.removeCoins('PlayerName', 25, 'fee')
bank?.getBalance('PlayerName')      // → number
bank?.hasCoins('PlayerName', 50)    // → boolean

const activity = getActivityMonitorAPI(ex.bot)
activity?.getPlayerUuid('PlayerName')
activity?.getMostRecentBlockheadId('PlayerName')
activity?.addAdminAllowlist('PlayerName')    // whitelist for forbidden items

const quests = getQuestAPI(ex.bot)
quests?.hasCompletedQuest('PlayerName', '5')  // → boolean
```

### Extension Dependencies

| Extension | Requires |
|-----------|----------|
| `VirtualBank` | _(none)_ |
| `ActivityMonitor` | _(none)_ |
| `QuestSystem` | `activity-monitor` |
| `ShopSystem` | `virtual-bank`, `activity-monitor` |
| `TeleportSystem` | `activity-monitor` |
| `JobSystem` | `virtual-bank` |
| `ClaimsSystem` | `activity-monitor` |
| `DuelSystem` | `activity-monitor` |
| `BuffShop` | `virtual-bank` |
| `BossRewards` | _(none)_ |

Missing dependencies cause a clear startup error before anything loads:

```
Error: Extension "shop-system" requires "virtual-bank" but it is not registered.
```

---

## Quests

Quests are defined in `config/quest-data.json`. Edit and restart the bot — no rebuild needed.

### Structure

```json
[
  {
    "id": "1",
    "title": "Welcome to Town",
    "description": "Head to the town center.",
    "requirements": [ { "type": "travel", "x": 1500, "y": 550, "radius": 15 } ],
    "rewards": [ { "type": "tokens", "count": 200 } ],
    "nextQuestId": "2"
  }
]
```

### Requirement Types

**`travel`** — reach a location
```json
{ "type": "travel", "x": 1500, "y": 550, "radius": 15, "hideCoords": false }
```

**`collect`** — have items in inventory
```json
{ "type": "collect", "itemId": 34, "itemName": "Stone Pickaxe", "count": 1, "consume": false }
```
`consume: true` removes the items atomically when the quest completes (triggers kick-first LMDB delivery).

**`kill`** — arena kills
```json
{ "type": "kill", "killCount": 3 }
```
Only kills inside `game.arena` count.

### Reward Types

```json
{ "itemId": 88, "itemName": "Diamond", "count": 1 }
{ "type": "tokens", "count": 200 }
```

### Versioning / Migration

When adding new quests to an existing chain, bump the version in `bot/src/extensions/quests/quest-context.ts`:

```typescript
export const CURRENT_QUEST_VERSION = 3
export const LAST_OLD_QUEST_ID = '10'   // last quest in the old chain
export const FIRST_NEW_QUEST_ID = '11'  // first new quest
```

Players who completed the old chain are automatically moved to the new starting point on their next login.

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
| `/home` | Teleport to your saved home |
| `/sethome` | Save current location as home |
| `/delhome` | Delete saved home |
| `/tpa <player>` | Request teleport to another player |
| `/accept` / `/decline` | Accept or decline a `/tpa` or `/duel` request |
| `/balance` (`/bal`) | Check token balance |
| `/pay <player> <amount>` | Send tokens to another player |
| `/cf <amount>` | Coin flip (max 1,000) |
| `/daily` | Claim daily reward (requires completing the quest chain) |
| `/transactions` | Recent transaction history |
| `/baltop` | Token leaderboard |
| `/jobs` | View available jobs |
| `/apply <job> <discord>` | Apply for a job |
| `/rep <message>` | Submit a job report |
| `/coords` | Show current coordinates |
| `/track <n>` | Choose which blockhead to track |
| `/claim [radius]` | Claim land (default radius 10, max 61, min 122 blocks from any other claim) |
| `/whisper <player> <msg>` | Send a private message |
| `/duel <player>` | Challenge another player to a duel |
| `/duelstats` | View duel record |
| `/buydefense` | Purchase +1% damage reduction (200 tokens each, max 99%) |
| `/buystrength` | Purchase +0.05x attack multiplier (100 tokens each) |
| `/defenses` / `/strengths` | View current buff levels |
| `/cmds` | List all commands |

## Admin Commands

| Command | Description |
|---------|-------------|
| `/tp <x> <y>` | Teleport to coordinates |
| `/give <player> <itemId> [count]` | Give items |
| `/hire <player> <job>` | Hire a player |
| `/fire <player> [reason]` | Fire a player |
| `/deposit <player> <amount>` | Add tokens |
| `/withdraw <player> <amount>` | Remove tokens |
| `/questreset <player>` | Reset a player's quest progress |
| `/seasonreset` | Reset all players' quest progress |
| `/unclaim` | Remove claim nearest to your position |
| `/claim-at <x> <y> <player> [radius]` | Place a claim at specific coordinates |
| `/spawn-boss <x> <y>` | Spawn the boss at coordinates |
| `/spawn-troll <x> <y>` | Spawn a regular cave troll |
| `/arena set` | Set the arena zone boundaries |
| `/arena start` / `/arena stop` | Start or stop a wave event |
| `/defense <player> <percent>` | Set a player's damage reduction directly |
| `/buff <player> <multiplier>` | Set a player's attack multiplier directly |

> **Note:** `/spawn-boss`, `/spawn-troll`, `/arena`, `/defense`, and `/buff` require their hook
> enabled (`boss` / `arena` / `godmode`). In the default deploy those hooks are off, so these
> commands are inert and pass through to the game. `/give`, `/give-id`, and the claim commands
> always work.

---

## Debug Flags

| Env Var | Description |
|---------|-------------|
| `BH_LOG_BOT_DEBUG=1` | Verbose per-operation logs |
| `BH_LOG_ACTIVITY_EVENTS=1` | Log every game event |
| `BH_LOG_BLOCKHEAD_MAP=1` | Log blockhead→player mapping |
| `BH_LOG_QUEST_CACHE=1` | Verbose quest checking |
| `BH_INVENTORY_INACTIVITY_MS=<ms>` | Inventory cache TTL (default 120000) |

Generate a Node.js stack dump at any time:
```bash
# Get the bot's PID
docker exec blockheads-server pgrep -f "node build/mac.js"
# Then:
docker exec blockheads-server kill -USR2 <pid>
cat data/node-stack-dump.txt
```

---

## Troubleshooting

**"Could not find both players" on duel start**
Both players must be online and have moved at least once since joining (so the bot has their coordinates). If the issue persists, check `data/logs/bot.log` for `[DuelSystem]` lines.

**Teleport puts player back where they were**
The game server caches positions in RAM. The bot kicks the player before writing to LMDB so the change takes effect on reconnect. Verify `paths.worldSave` points to the correct LMDB directory.

**Quests not detecting item pickups**
Inventory is polled every 15 seconds. If it never updates, check that the Python daemon is running: `docker exec blockheads-server ls /tmp/bh-wm.sock`

**LMDB error on open**
Python must be 64-bit: `python3 -c "import struct; print(struct.calcsize('P')*8)"` → must print `64`.

**No joins/leaves detected**
Check `data/logs/bot.log` for `[UDS] Connected to proxy`. If missing, the proxy isn't running or the event socket path doesn't match.

**Admin commands not working**
Your username (uppercase) must be in `<worldSave>/adminlist.txt`. The bot watches this file live — no restart needed.

**100% CPU / bot seems frozen**
```bash
docker exec blockheads-server pgrep -f "node build/mac.js" | xargs docker exec blockheads-server kill -USR2
cat data/node-stack-dump.txt
```

**Proxy won't start**
Java 21 is required. The Docker image includes it. For bare-metal, verify: `java -version`.

---

## Proxy Configuration

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--event-socket` | `BH_EVENT_SOCKET` | `/tmp/bh-events.sock` | UDS socket proxy emits events on |
| `--command-socket` | `BH_COMMAND_SOCKET` | `/tmp/bh-commands.sock` | UDS socket for bot→proxy commands |
| `-P` | — | `15153` | UDP port players connect to |
| `-S` | — | `15151` | UDP port of the game server |

---

## Acknowledgements

- **Bot framework** — [Console-Loader](https://github.com/Blockheads-Messagebot/Console-Loader) by Bibliofile / Blockheads-Messagebot (MIT)
- **Proxy** — [blockheads](https://github.com/juanmuscaria/blockheads) by juanmuscaria (MPL-2.0)
- **World save tools** — [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844

## License

- Top-level and bot code: [MIT](LICENSE)
- Proxy: [MPL-2.0](proxy/LICENSE)
- Tools: Based on [TheBlockheadsTools](https://github.com/med1844/TheBlockheadsTools) by med1844
